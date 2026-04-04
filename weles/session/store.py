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
        """Open a real browser for human login, capture cookies on close.

        Opens Chrome/Chromium, navigates to the URL with an instruction
        page, waits for the human to complete the task and close the
        browser, then extracts cookies from the browser's profile.

        Returns True if cookies were captured.
        """
        import tempfile
        user_data = tempfile.mkdtemp(prefix="weles_acquire_")
        landing = self._create_landing(url, task_description or f"Login to {url}", user_data)

        proc = self._launch_browser(landing, user_data)
        if not proc:
            return False

        proc.wait()

        cookies = self._extract_from_profile(url, user_data)
        if cookies:
            self.save_cookies(label, cookies)
            return True
        return False

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
        html = (
            "<!DOCTYPE html><html><head><title>Weles - Login Required</title>"
            "<style>body{font-family:system-ui;max-width:600px;margin:80px auto;"
            "padding:20px}h1{color:#333}p{font-size:18px;line-height:1.6}"
            "a{color:#0066cc;font-size:20px}.note{color:#666;margin-top:40px}</style>"
            "</head><body>"
            "<h1>Weles needs you to login</h1>"
            f"<p><strong>Task:</strong> {task}</p>"
            f'<p><a href="{url}">Open {url}</a></p>'
            '<p class="note">When done, close this browser window.</p>'
            "</body></html>"
        )
        path = os.path.join(output_dir, "weles_login.html")
        with open(path, "w") as f:
            f.write(html)
        return "file://" + os.path.abspath(path)

    def _launch_browser(self, url: str, user_data_dir: str):
        try:
            if sys.platform == "darwin":
                return subprocess.Popen([
                    "open", "-W", "-n", "-a", "Google Chrome",
                    "--args", f"--user-data-dir={user_data_dir}",
                    "--no-first-run", "--new-window", url,
                ])
            return subprocess.Popen([
                "google-chrome", f"--user-data-dir={user_data_dir}",
                "--no-first-run", url,
            ])
        except FileNotFoundError:
            return None

    def _extract_from_profile(self, domain: str, user_data_dir: str):
        """Read unencrypted cookies from a fresh Chrome profile's SQLite DB."""
        import sqlite3
        db = Path(user_data_dir) / "Default" / "Cookies"
        if not db.exists():
            return []
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro&nolock=1", uri=True)
            rows = conn.execute(
                "SELECT name, value, host_key, path, is_secure, is_httponly "
                "FROM cookies WHERE host_key LIKE ?",
                (f"%{domain}%",),
            ).fetchall()
            conn.close()
            return [
                {"name": n, "value": v, "domain": h, "path": p,
                 "secure": bool(s), "httpOnly": bool(ho), "sameSite": "Lax"}
                for n, v, h, p, s, ho in rows if v
            ]
        except Exception:
            return []
