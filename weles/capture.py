"""Browser telemetry: HAR, video, console, response bodies, fingerprint diagnostics.

Usage:
    from weles import AsyncWeles, Capture

    async with AsyncWeles(os="macos") as ctx:
        cap = Capture(ctx)
        page = await cap.new_page()
        # ... do stuff ...
        await cap.save()  # writes all artifacts to disk
"""

import asyncio
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


_RECORDINGS_ENV = "WELES_RECORDINGS_DIR"
_RECORDINGS_DEFAULT = "recordings"
_TLS_FP_URL = "https://tls.browserleaks.com/json"
_COLLECT_JS = (Path(__file__).parent / "scripts" / "collect.js").read_text()
_COLLECT_PERMS_JS = """async () => {
    const perms = {};
    for (const name of [
        'geolocation', 'notifications', 'push', 'midi',
        'camera', 'microphone', 'screen-wake-lock', 'persistent-storage',
    ]) {
        try { perms[name] = (await navigator.permissions.query({name})).state; }
        catch(e) { perms[name] = 'unsupported'; }
    }
    return perms;
}"""


def _recordings_dir():
    d = os.environ.get(_RECORDINGS_ENV) or str(Path.cwd() / _RECORDINGS_DEFAULT)
    os.makedirs(d, exist_ok=True)
    return d


def _output_path(label, ext="png"):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(_recordings_dir(), f"{label}_{ts}.{ext}")


class Capture:
    """Attaches telemetry to a BrowserContext: video, HAR, console, responses."""

    def __init__(self, context, url_filters=None):
        self.context = context
        self.console_log: List[str] = []
        self.response_bodies: List[Dict[str, Any]] = []
        self._url_filters = url_filters or [
            "cloudflare", "challenge", "turnstile", "seon", "login",
        ]
        self._pages: list = []

    async def new_page(self):
        """Create a page with console and response body logging attached."""
        page = await self.context.new_page()
        self._attach(page)
        self._pages.append(page)
        return page

    def _attach(self, page):
        is_cdp = hasattr(page, '_sid')  # CDPPage has _sid, Playwright Page doesn't
        if is_cdp:
            self._attach_cdp(page)
        else:
            self._attach_playwright(page)

    def _attach_playwright(self, page):
        page.on("console", lambda msg: self.console_log.append(
            f"[console.{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: self.console_log.append(
            f"[pageerror] {err}"))
        filters = self._url_filters

        async def _on_response(response):
            url = response.url.lower()
            if not any(f in url for f in filters):
                return
            try:
                body = await response.body()
                req = response.request
                self.response_bodies.append({
                    "url": response.url[:200],
                    "method": req.method,
                    "status": response.status,
                    "request_body": (req.post_data[:5000] if req.post_data else None),
                    "response_body": body.decode("utf-8", errors="replace")[:5000],
                })
            except Exception:
                pass

        page.on("response", lambda r: asyncio.ensure_future(_on_response(r)))

    def _attach_cdp(self, page):
        """Attach to CDPPage using its on() event system."""
        log = self.console_log
        bodies = self.response_bodies
        filters = self._url_filters

        def on_console(params):
            ctype = params.get("type", "log")
            args = params.get("args", [])
            text = " ".join(a.get("value", str(a.get("description", ""))) for a in args)
            log.append(f"[console.{ctype}] {text}")

        def on_response(params):
            resp = params.get("response", {})
            url = resp.get("url", "")
            if not any(f in url.lower() for f in filters):
                return
            bodies.append({
                "url": url[:200],
                "method": params.get("type", "GET"),
                "status": resp.get("status", 0),
                "request_body": None,
                "response_body": None,
            })

        page.on("console", on_console)
        page.on("response", on_response)

    async def capture_tls_fingerprint(self, page):
        """Visit browserleaks and save TLS fingerprint."""
        try:
            await page.goto(_TLS_FP_URL, wait_until="domcontentloaded", timeout=15000)
            raw = await page.evaluate("() => document.body.innerText")
            data = json.loads(raw) if raw else {}
            path = _output_path("tls_fingerprint", "json")
            with open(path, "w") as f:
                json.dump(data, f, indent=2)
            print(f"  TLS fingerprint: {path}")
            return data
        except Exception as e:
            print(f"  TLS fingerprint failed: {e}")
            return {}

    async def capture_environment(self, page):
        """Collect all browser fingerprint signals and save as JSON."""
        try:
            env = await page.evaluate(f"() => {{ {_COLLECT_JS}\n return __welesCollectEnvironment(); }}")
            try:
                env["permissions"] = await page.evaluate(_COLLECT_PERMS_JS)
            except Exception:
                pass
            path = _output_path("browser_environment", "json")
            with open(path, "w") as f:
                json.dump(env, f, indent=2)
            print(f"  Browser environment: {path}")
            return env
        except Exception as e:
            print(f"  Environment capture failed: {e}")
            return {}

    async def screenshot(self, page, label="screenshot", full_page=False):
        """Take a screenshot."""
        path = _output_path(label, "png")
        await page.screenshot(path=path, full_page=full_page)
        print(f"  Screenshot: {path}")
        return path

    async def run_diagnostics(self, page):
        """Run TLS + environment capture in one call."""
        tls = await self.capture_tls_fingerprint(page)
        env = await self.capture_environment(page)
        return {"tls": tls, "environment": env}

    def save(self, label="session"):
        """Write console log and response bodies to disk."""
        paths = {}
        if self.console_log:
            p = _output_path(f"{label}_console", "log")
            with open(p, "w") as f:
                f.write("\n".join(self.console_log))
            print(f"  Console log ({len(self.console_log)} lines): {p}")
            paths["console"] = p
        if self.response_bodies:
            p = _output_path(f"{label}_responses", "json")
            with open(p, "w") as f:
                json.dump(self.response_bodies, f, indent=2)
            print(f"  Response bodies ({len(self.response_bodies)} entries): {p}")
            paths["responses"] = p
        return paths

    @staticmethod
    def extract_frames(video_path, fps="1", start=None, end=None):
        """Extract frames from a .webm video. Returns list of frame paths."""
        out_dir = os.path.join(_recordings_dir(), "frames")
        os.makedirs(out_dir, exist_ok=True)
        for f in Path(out_dir).glob("frame_*.png"):
            f.unlink()
        cmd = ["ffmpeg", "-i", video_path]
        if start:
            cmd.extend(["-ss", str(start)])
        if end:
            cmd.extend(["-to", str(end)])
        cmd.extend(["-vf", f"fps={fps}", os.path.join(out_dir, "frame_%04d.png")])
        subprocess.run(cmd, capture_output=True)
        frames = sorted(Path(out_dir).glob("frame_*.png"))
        print(f"  Extracted {len(frames)} frames at {fps}fps to {out_dir}/")
        return [str(f) for f in frames]

    @staticmethod
    async def get_video_path(page):
        """Get the video file path for a page (after closing context)."""
        video = page.video
        if video:
            return await video.path()
        return None

    @staticmethod
    def diagnose(video_path, console_log_path=None, responses_path=None):
        """Analyze a recording via Claude CLI vision to explain why a task failed."""
        frames = Capture.extract_frames(video_path, fps="0.5")
        if not frames:
            return "No frames extracted from video."

        # Build prompt with context
        prompt_parts = [
            "These images are sequential frames from a browser automation session.",
            "Analyze each frame in order and explain:",
            "1. What is happening at each step",
            "2. Where exactly the task failed",
            "3. Why it failed (based on what you see on screen)",
            "4. Start your answer with: The task did not succeed due to",
        ]

        if console_log_path and os.path.exists(console_log_path):
            with open(console_log_path) as f:
                log = f.read()[:3000]
            prompt_parts.append(f"\nConsole log:\n{log}")

        if responses_path and os.path.exists(responses_path):
            with open(responses_path) as f:
                resps = json.load(f)
            summary = []
            for r in resps:
                summary.append(f"{r.get('method','?')} {r['status']}: {r['url'][:80]}")
            prompt_parts.append(f"\nNetwork responses:\n" + "\n".join(summary))

        prompt = "\n".join(prompt_parts)

        # Build claude CLI command with image reads
        reads = ". ".join(f"Read the image file at {f}" for f in frames[:10])
        full_prompt = f"{reads}. Then:\n\n{prompt}"

        try:
            proc = subprocess.run(
                ["claude", "-p", "--output-format", "json"],
                input=full_prompt,
                capture_output=True,
                text=True,
            )
            raw = proc.stdout.strip()
            for line in raw.split("\n"):
                if '"type":"result"' in line:
                    try:
                        parsed = json.loads(line)
                        return parsed.get("result", raw)
                    except json.JSONDecodeError:
                        pass
            try:
                parsed = json.loads(raw)
                return parsed.get("result", raw)
            except json.JSONDecodeError:
                return raw
        except FileNotFoundError:
            return "claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
        except Exception as e:
            return f"Diagnosis failed: {e}"

    async def finish(self, label="session"):
        """Save artifacts, get video from page, run diagnose(). Returns diagnosis or None."""
        paths = self.save(label=label)
        video_path = None
        for page in self._pages:
            # For CDPPage: stop screencast to finalize video before getting path
            sc = getattr(page, '_screencast', None)
            if sc and not sc._stopped:
                await sc.stop()
            vp = await self.get_video_path(page)
            if vp:
                video_path = vp
                break
        if not video_path:
            return None
        return self.diagnose(
            video_path,
            console_log_path=paths.get("console"),
            responses_path=paths.get("responses"),
        )
