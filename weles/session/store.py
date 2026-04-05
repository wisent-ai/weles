"""Cookie-based session caching, reuse, and auto-acquisition."""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


class SessionStore:
    """Persistent cookie store with auto-acquire via real browser.

    Stores cookies as JSON on disk. When cookies are missing or expired,
    opens a real browser for a human to login, captures the resulting
    cookies, and stores them for future automated runs.
    """

    def __init__(self, persist_path: Optional[str] = None):
        if not persist_path:
            persist_path = str(Path.home() / ".weles" / "sessions.json")
        self._persist_path = persist_path
        self._cookies: Dict[str, List[Dict[str, Any]]] = {}
        if Path(persist_path).exists():
            try:
                self._cookies = json.loads(Path(persist_path).read_text())
            except Exception:
                pass

    def save_cookies(self, label: str, cookies: List[Dict[str, Any]]):
        """Store cookies under a label. Persists to disk."""
        self._cookies[label] = cookies
        self._persist()

    def load_cookies(self, label: str) -> Optional[List[Dict[str, Any]]]:
        """Retrieve cached cookies by label, or None if not found."""
        return self._cookies.get(label)

    def import_cookies(self, label: str, cookies: List[Dict[str, Any]]):
        """Import externally-provided cookies (e.g. from an API or CLI)."""
        self.save_cookies(label, cookies)

    def import_from_json(self, label: str, json_path: str):
        """Import cookies from a JSON file (list of cookie dicts)."""
        cookies = json.loads(Path(json_path).read_text())
        self.save_cookies(label, cookies)

    async def inject(self, context, label: str) -> bool:
        """Inject cached cookies into a browser context."""
        cookies = self.load_cookies(label)
        if not cookies:
            return False
        await context.add_cookies(cookies)
        return True

    async def capture(self, context, label: str) -> List[Dict[str, Any]]:
        """Capture cookies from a browser context and store them."""
        cookies = await context.cookies()
        if cookies:
            self.save_cookies(label, cookies)
        return cookies

    def acquire(self, label: str, url: str, task_description: str = "") -> bool:
        """Open a real browser for human login, capture cookies via CDP.

        Launches Chromium with remote debugging, shows the landing page,
        waits for the human to navigate and login, then extracts cookies
        via Network.getCookies before the browser closes.

        Returns True if cookies were captured.
        """
        import asyncio
        return asyncio.get_event_loop().run_until_complete(
            self._acquire_async(label, url, task_description)
        )

    async def _acquire_async(self, label, url, task_description):
        import tempfile
        user_data = tempfile.mkdtemp(prefix="weles_acquire_")
        landing = self._create_landing(url, task_description or url, user_data)

        from ..cdp.launcher import launch_chromium
        from ..cdp.connection import CDPConnection

        proc, ws_url = await launch_chromium(
            headless=False, user_data_dir=user_data)
        conn = CDPConnection()
        await conn.connect(ws_url)

        # Open landing page in a new tab
        result = await conn.send("Target.createTarget", {"url": landing})
        target_id = result["targetId"]
        attach = await conn.send("Target.attachToTarget",
                                 {"targetId": target_id, "flatten": True})
        sid = attach["sessionId"]
        await conn.send("Page.enable", session_id=sid)

        # Wait for the browser process to exit (human closes it)
        domain = url.split("//")[-1].split("/")[0]
        try:
            while proc.returncode is None:
                # Poll every second via event loop
                await asyncio.get_event_loop().run_in_executor(None, proc.poll)
                if proc.returncode is not None:
                    break
                # Try to get cookies while browser is still open
                try:
                    result = await conn.send(
                        "Network.getCookies", {"urls": [url]}, session_id=sid)
                    cookies = result.get("cookies", [])
                    session_cookies = [c for c in cookies if c.get("value")]
                    if session_cookies:
                        formatted = [
                            {"name": c["name"], "value": c["value"],
                             "domain": c["domain"], "path": c["path"],
                             "secure": c.get("secure", False),
                             "httpOnly": c.get("httpOnly", False),
                             "sameSite": "Lax"}
                            for c in session_cookies
                        ]
                        self.save_cookies(label, formatted)
                except Exception:
                    pass
                loop = asyncio.get_event_loop()
                fut = loop.create_future()
                loop.call_later(1, fut.set_result, None)
                await fut
        except Exception:
            pass
        finally:
            try:
                await conn.close()
            except Exception:
                pass
            proc.terminate()

        return bool(self.load_cookies(label))

    async def ensure(self, context, label: str, url: str,
                     task_description: str = "") -> bool:
        """Inject cookies if available, otherwise acquire them first.

        The main entry point for SSO-protected sites:
        1. Try to inject stored cookies
        2. If none stored, open real browser for human login
        3. Store the acquired cookies
        4. Inject them into the context
        """
        if await self.inject(context, label):
            return True
        acquired = self.acquire(label, url, task_description)
        if acquired:
            return await self.inject(context, label)
        return False

    def clear(self, label: Optional[str] = None):
        """Clear cached cookies."""
        if label:
            self._cookies.pop(label, None)
        else:
            self._cookies.clear()
        self._persist()

    def labels(self) -> List[str]:
        """List all cached session labels."""
        return list(self._cookies.keys())

    def _persist(self):
        path = Path(self._persist_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self._cookies, indent=2, default=str))

    def _create_landing(self, url: str, task: str, output_dir: str) -> str:
        from .landing import build_landing_html
        domain = url.split("//")[-1].split("/")[0]
        html = build_landing_html(domain, url, task, purpose="login")
        path = os.path.join(output_dir, "weles_login.html")
        with open(path, "w") as f:
            f.write(html)
        return "file://" + os.path.abspath(path)

