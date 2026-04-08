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
import os
from dataclasses import dataclass, field
from typing import Optional

from . import discover, login, vision
from ..cloudflare import wait_cloudflare


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
        """Execute the task and return the value, or None on failure."""
        bal = await self._attempt_with_existing_session()
        if bal is not None:
            return bal
        print(f"[task] {self.service}: first attempt returned None, "
              "forcing fresh login and retrying")
        return await self._attempt_with_fresh_login()

    async def _attempt_with_existing_session(self) -> Optional[float]:
        cookies = self._load_cookies()
        async with _open_session(self.os_target) as page:
            if cookies:
                await page.context.add_cookies(cookies)
            await page.goto(self.url, wait_until="domcontentloaded")
            await wait_cloudflare(page)
            return await self._extract_value(page)

    async def _attempt_with_fresh_login(self) -> Optional[float]:
        self._clear_cookies()
        username = os.environ.get(self.username_env, "")
        password = os.environ.get(self.password_env, "")
        if not username or not password:
            print(f"[task] {self.service}: missing credentials in env "
                  f"({self.username_env}, {self.password_env})")
            return None
        async with _open_session(self.os_target) as page:
            await page.goto(self.url, wait_until="domcontentloaded")
            await wait_cloudflare(page)
            if not await vision.boolean(
                page,
                "Is this page showing a login form with username and "
                "password fields?",
            ):
                print(f"[task] {self.service}: expected a login form")
                return None
            ok = await login.run(page, username, password)
            if not ok:
                return None
            self._save_cookies(await page.context.cookies())
            return await self._extract_value(page)

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
