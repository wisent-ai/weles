"""Cookie-based session caching and reuse."""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

_SESSION_KEYWORDS = ["session", "token", "auth", "csrf", "xsrf", "sid", "login", "jwt"]
_LOGIN_PATHS = ["/login", "/signin", "/sign-in", "/sign-up", "/signup", "/entrance/login"]


class SessionStore:
    """In-memory cookie cache with optional JSON persistence."""

    def __init__(self, persist_path: Optional[str] = None):
        self._cookies: Dict[str, List[Dict[str, Any]]] = {}
        self._persist_path = persist_path
        if persist_path and Path(persist_path).exists():
            try:
                self._cookies = json.loads(Path(persist_path).read_text())
            except Exception:
                pass

    def save_cookies(self, label: str, cookies: List[Dict[str, Any]]):
        """Cache cookies under a label."""
        self._cookies[label] = cookies
        self._persist()

    def load_cookies(self, label: str) -> Optional[List[Dict[str, Any]]]:
        """Retrieve cached cookies by label."""
        return self._cookies.get(label)

    def has_session(self, cookies: List[Dict[str, Any]]) -> bool:
        """Check if cookies contain session-like entries."""
        return any(
            any(kw in c.get("name", "").lower() for kw in _SESSION_KEYWORDS)
            and "tracking" not in c.get("name", "").lower()
            for c in cookies
        )

    def session_cookies(self, cookies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Filter for session-relevant cookies only."""
        return [
            c for c in cookies
            if any(kw in c.get("name", "").lower() for kw in _SESSION_KEYWORDS)
            and "tracking" not in c.get("name", "").lower()
        ]

    async def inject(self, context, label: str) -> bool:
        """Inject cached cookies into a browser context."""
        cookies = self.load_cookies(label)
        if not cookies:
            return False
        await context.add_cookies(cookies)
        return True

    async def capture(self, context, label: str) -> List[Dict[str, Any]]:
        """Capture cookies from a browser context and cache them."""
        cookies = await context.cookies()
        if cookies:
            self.save_cookies(label, cookies)
        return cookies

    def clear(self, label: Optional[str] = None):
        """Clear cached cookies. If label given, clear only that label."""
        if label:
            self._cookies.pop(label, None)
        else:
            self._cookies.clear()
        self._persist()

    def labels(self) -> List[str]:
        """List all cached session labels."""
        return list(self._cookies.keys())

    def _persist(self):
        if self._persist_path:
            Path(self._persist_path).write_text(
                json.dumps(self._cookies, indent=2, default=str))

    @staticmethod
    def is_login_page(url: str) -> bool:
        """Heuristic check if a URL looks like a login/signup page."""
        path = urlparse(url).path.lower()
        return any(p in path for p in _LOGIN_PATHS)
