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
        domain = url.split("//")[-1].split("/")[0]
        html = (
            '<!DOCTYPE html><html><head><meta charset="utf-8">'
            "<title>Weles</title><style>"
            "*{margin:0;padding:0;box-sizing:border-box}"
            "body{font-family:-apple-system,system-ui,sans-serif;"
            "background:#0a0a0a;color:#e5e5e5;height:100vh;"
            "display:flex;align-items:center;justify-content:center}"
            ".card{background:#161616;border:1px solid #2a2a2a;"
            "border-radius:16px;padding:48px;max-width:480px;width:100%}"
            ".logo{font-size:13px;letter-spacing:3px;text-transform:uppercase;"
            "color:#666;margin-bottom:32px}"
            "h1{font-size:22px;font-weight:500;color:#fff;margin-bottom:12px}"
            ".desc{font-size:15px;color:#999;line-height:1.6;margin-bottom:32px}"
            ".steps{list-style:none;margin-bottom:32px}"
            ".steps li{padding:10px 0;border-bottom:1px solid #222;"
            "font-size:14px;color:#bbb}"
            ".steps li:last-child{border:none}"
            ".num{display:inline-block;width:24px;height:24px;"
            "background:#222;border-radius:50%;text-align:center;"
            "line-height:24px;font-size:12px;color:#888;margin-right:12px}"
            ".btn{display:block;width:100%;padding:14px;background:#fff;"
            "color:#000;border:none;border-radius:8px;font-size:15px;"
            "font-weight:500;cursor:pointer;text-align:center;"
            "text-decoration:none;transition:opacity .2s}"
            ".btn:hover{opacity:.85}"
            ".footer{margin-top:24px;font-size:12px;color:#444;text-align:center}"
            "</style></head><body><div class='card'>"
            "<div class='logo'>weles</div>"
            f"<h1>Login session needed for {domain}</h1>"
            f'<p class="desc">{task}</p>'
            '<ol class="steps">'
            f'<li><span class="num">1</span>Click the button below to open {domain}</li>'
            '<li><span class="num">2</span>Login as you normally would</li>'
            '<li><span class="num">3</span>Once logged in, close this browser window</li>'
            "</ol>"
            f'<a class="btn" href="{url}">Open {domain}</a>'
            '<p class="footer">Your session cookies will be saved locally to '
            "~/.weles/sessions.json so you won't need to do this again.</p>"
            "</div></body></html>"
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
