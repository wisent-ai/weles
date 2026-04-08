"""Declarative Task runner for the weles agent layer.

A Task encapsulates: which account to use, where to start, what to
extract. The runner handles browser session lifecycle, cookie restore,
automatic Cloudflare bypass, login if redirected to a login page,
value discovery via navigation, and retry on stale cookies.

Example - fetching a proxy account balance with NO per-site code:

    balance = await FetchAccountValue(
        service="oxylabs",
        url="https://dashboard.oxylabs.io",
        username_env="OXYLABS_USERNAME",
        password_env="OXYLABS_PASSWORD",
        what="the current account credit balance",
    ).run()
"""
import json as _json
import os
import re as _re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from . import discover, login, vision
from ..cloudflare import wait_cloudflare


# Trajectory cache: persisted at ~/.weles/trajectories/<service>.json
# (or $WELES_CACHE_DIR/trajectories/). Each entry stores the path the
# agent learned during the first successful run, so subsequent calls
# can replay the path with zero vision queries.

def _cache_dir() -> Path:
    base = os.environ.get("WELES_CACHE_DIR") or os.path.join(
        os.path.expanduser("~"), ".weles")
    p = Path(base) / "trajectories"
    p.mkdir(parents=True, exist_ok=True)
    return p


@dataclass
class Trajectory:
    """A learned path for fetching a value from a service."""
    service: str
    final_url: str
    selector: Optional[str] = None
    regex: Optional[str] = None
    last_success: Optional[str] = None
    last_value: Optional[float] = None

    @classmethod
    def load(cls, service: str) -> Optional["Trajectory"]:
        path = _cache_dir() / f"{service}.json"
        try:
            data = _json.loads(path.read_text())
            return cls(**data)
        except Exception:
            return None

    def save(self) -> None:
        path = _cache_dir() / f"{self.service}.json"
        try:
            path.write_text(_json.dumps(asdict(self), indent=2))
        except Exception:
            pass

    @staticmethod
    def invalidate(service: str) -> None:
        path = _cache_dir() / f"{service}.json"
        try:
            path.unlink()
        except Exception:
            pass


@dataclass
class FetchAccountValue:
    """Fetch a numeric value from an authenticated dashboard.

    Fields:
        service: A short name used as the cookie cache key.
        url: Starting URL (homepage, dashboard, or login page).
        what: Plain-English description of the value to extract.
        username_env: Environment variable name for the username.
        password_env: Environment variable name for the password.
        os_target: Spoofed OS for fingerprint generation.
        depth: Max navigation steps for value discovery.
    """

    service: str
    url: str
    what: str
    username_env: str
    password_env: str
    os_target: str = "macos"
    depth: int = 4

    async def run(self) -> Optional[float]:
        """Execute the task and return the value, or None on failure.

        First tries to replay a cached trajectory (zero vision calls
        on the happy path). If that misses or fails, falls through to
        agentic discovery and persists the learned trajectory for the
        next call.
        """
        traj = Trajectory.load(self.service)
        if traj is not None:
            replay_value = await self._replay_trajectory(traj)
            if replay_value is not None:
                print(f"[task] {self.service}: cache replay hit, "
                      f"value={replay_value}")
                traj.last_value = replay_value
                traj.last_success = datetime.utcnow().isoformat() + "Z"
                traj.save()
                return replay_value
            print(f"[task] {self.service}: cache replay missed, "
                  "invalidating and re-discovering")
            Trajectory.invalidate(self.service)

        bal = await self._attempt_with_existing_session()
        if bal is not None:
            return bal
        # Cookies might be stale - clear them and retry once
        print(f"[task] {self.service}: first attempt returned None, "
              "clearing cookies and retrying")
        self._clear_cookies()
        return await self._attempt_with_existing_session()

    async def _replay_trajectory(self, traj: "Trajectory") -> Optional[float]:
        """Try to fetch the value using a cached trajectory.

        Returns the float value or None if anything failed (in which
        case the caller invalidates the cache and re-discovers).
        """
        cookies = self._load_cookies()
        async with _open_session(self.os_target) as page:
            try:
                if cookies:
                    await page.context.add_cookies(cookies)
                await page.goto(traj.final_url, wait_until="domcontentloaded")
                await wait_cloudflare(page)
                if "login" in page.url.lower() or "signin" in page.url.lower():
                    return None
                if not traj.selector:
                    return None
                el = await page.query_selector(traj.selector)
                if el is None:
                    return None
                text = (await el.inner_text() or "").strip()
                if traj.regex:
                    m = _re.search(traj.regex, text)
                    if m:
                        text = m.group(1) if m.groups() else m.group(0)
                cleaned = _re.sub(r"[^\d.\-]", "", text)
                if not cleaned:
                    return None
                return float(cleaned)
            except Exception as e:
                print(f"[task] {self.service}: replay error: {e}")
                return None

    async def _attempt_with_existing_session(self) -> Optional[float]:
        cookies = self._load_cookies()
        async with _open_session(self.os_target) as page:
            if cookies:
                await page.context.add_cookies(cookies)
            await page.goto(self.url, wait_until="domcontentloaded")
            await wait_cloudflare(page)
            if await self._is_login_page(page):
                if not await self._login_inline(page):
                    return None
            value = await self._extract_value(page)
            if value is not None:
                await self._learn_trajectory(page, value)
            return value

    async def _is_login_page(self, page) -> bool:
        url_l = page.url.lower()
        if "login" in url_l or "signin" in url_l or "sign-in" in url_l:
            return True
        return await vision.boolean(
            page,
            "Is this page showing a login form with username and "
            "password fields, or a 'Sign in' / 'Log in' button as "
            "the main call to action?",
        )

    async def _login_inline(self, page) -> bool:
        username = os.environ.get(self.username_env, "")
        password = os.environ.get(self.password_env, "")
        if not username or not password:
            print(f"[task] {self.service}: missing credentials in env "
                  f"({self.username_env}, {self.password_env})")
            return False
        ok = await login.run(page, username, password)
        if not ok:
            return False
        self._save_cookies(await page.context.cookies())
        return True

    async def _learn_trajectory(self, page, value: float) -> None:
        """After a successful agentic discovery, ask vision once for a
        stable CSS selector and persist the trajectory."""
        try:
            sel_answer = await vision.text(
                page,
                f"a CSS selector that uniquely identifies the element "
                f"containing {self.what}",
            )
            selector = (sel_answer or "").strip().strip("`'\"")
            if selector and len(selector) < 200:
                Trajectory(
                    service=self.service,
                    final_url=page.url,
                    selector=selector,
                    regex=r"\$?\s*([0-9]+(?:\.[0-9]+)?)",
                    last_success=datetime.utcnow().isoformat() + "Z",
                    last_value=value,
                ).save()
                print(f"[task] {self.service}: trajectory cached "
                      f"(url={page.url}, selector={selector!r})")
        except Exception as e:
            print(f"[task] {self.service}: could not learn trajectory: {e}")

    async def _extract_value(self, page) -> Optional[float]:
        return await discover.find_number(page, self.what, depth=self.depth)

    def _load_cookies(self):
        try:
            from ..session import SessionStore
            return SessionStore().load(self.service)
        except Exception:
            return None

    def _save_cookies(self, cookies):
        try:
            from ..session import SessionStore
            SessionStore().save(self.service, cookies)
        except Exception:
            pass

    def _clear_cookies(self):
        try:
            from ..session import SessionStore
            SessionStore().clear(self.service)
        except Exception:
            pass


def _open_session(os_target: str):
    """Async context manager that yields a Page from a stealth browser."""
    from playwright.async_api import async_playwright
    from .. import AsyncNewBrowser

    class _Session:
        def __init__(self, os_target):
            self._os_target = os_target
            self._pw = None
            self._ctx = None

        async def __aenter__(self):
            self._pw = await async_playwright().start()
            self._ctx = await AsyncNewBrowser(
                self._pw, browser="chromium",
                os=self._os_target, headless=False,
            )
            page = self._ctx.pages[0] if self._ctx.pages else \
                await self._ctx.new_page()
            return page

        async def __aexit__(self, *args):
            try:
                if self._ctx:
                    await self._ctx.close()
            except Exception:
                pass
            try:
                if self._pw:
                    await self._pw.stop()
            except Exception:
                pass

    return _Session(os_target)
