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

    async def capture_tls_fingerprint(self, page):
        """Visit browserleaks and save TLS fingerprint."""
        try:
            resp = await page.goto(_TLS_FP_URL, wait_until="domcontentloaded", timeout=15000)
            data = json.loads(await resp.text()) if resp else {}
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
        """Extract frames from a browser recording video.

        Args:
            video_path: Path to .webm video file.
            fps: Frames per second to extract (default "1").
            start: Optional start time (e.g. "5" for 5 seconds in).
            end: Optional end time.

        Returns list of extracted frame paths.
        """
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
