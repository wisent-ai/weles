"""CDP browser context — manages pages, cookies, and init scripts."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from ..connection import CDPConnection

logger = logging.getLogger(__name__)


class CDPBrowserContext:
    """Manages an isolated browser context created via Target.createBrowserContext.

    Each context has its own cookie jar, local/session storage, and can apply
    emulation settings and init scripts to every new page.
    """

    def __init__(
        self,
        connection: CDPConnection,
        browser_context_id: str,
        *,
        record_video: Optional[Dict[str, Any]] = None,
    ):
        self._conn = connection
        self._context_id = browser_context_id
        self._pages: List[Any] = []  # List[CDPPage] — avoids circular import
        self._init_scripts: List[str] = []
        self._emulation: Dict[str, Any] = {}
        self._record_video = record_video
        self._closed = False

    @property
    def context_id(self) -> str:
        return self._context_id

    @property
    def pages(self) -> List[Any]:
        """Return the list of pages in this context."""
        return list(self._pages)

    # ------------------------------------------------------------------
    # Emulation settings (applied to each new page)
    # ------------------------------------------------------------------

    def set_emulation(
        self,
        *,
        user_agent: Optional[str] = None,
        viewport_width: Optional[int] = None,
        viewport_height: Optional[int] = None,
        device_scale_factor: Optional[float] = None,
        mobile: Optional[bool] = None,
        platform: Optional[str] = None,
        accept_language: Optional[str] = None,
    ) -> None:
        """Store emulation settings to apply to every new page."""
        if user_agent is not None:
            self._emulation["user_agent"] = user_agent
        if viewport_width is not None:
            self._emulation["viewport_width"] = viewport_width
        if viewport_height is not None:
            self._emulation["viewport_height"] = viewport_height
        if device_scale_factor is not None:
            self._emulation["device_scale_factor"] = device_scale_factor
        if mobile is not None:
            self._emulation["mobile"] = mobile
        if platform is not None:
            self._emulation["platform"] = platform
        if accept_language is not None:
            self._emulation["accept_language"] = accept_language

    # ------------------------------------------------------------------
    # Page management
    # ------------------------------------------------------------------

    async def new_page(self) -> Any:
        """Create a new page (tab) in this context.

        Returns a CDPPage instance with emulation and init scripts applied.
        The import is deferred to avoid circular dependency.
        """
        from ..page.page import CDPPage

        result = await self._conn.send("Target.createTarget", {
            "url": "about:blank",
            "browserContextId": self._context_id,
        })
        target_id = result["targetId"]

        attach = await self._conn.send("Target.attachToTarget", {
            "targetId": target_id,
            "flatten": True,
        })
        session_id = attach["sessionId"]

        page = CDPPage(self._conn, target_id, session_id, context=self,
                       record_video=self._record_video)
        await page._init()

        # Apply emulation
        await self._apply_emulation(page)

        for script in self._init_scripts:
            await page.add_init_script(script)

        self._pages.append(page)
        return page

    async def _apply_emulation(self, page: Any) -> None:
        """Apply stored emulation settings to a page."""
        from ..emulation import set_user_agent, set_viewport

        ua = self._emulation.get("user_agent")
        if ua:
            await set_user_agent(
                page._sid, self._conn, ua,
                platform=self._emulation.get("platform"),
                accept_language=self._emulation.get("accept_language"),
            )

        vw = self._emulation.get("viewport_width")
        vh = self._emulation.get("viewport_height")
        if vw and vh:
            await set_viewport(
                page._sid, self._conn, vw, vh,
                device_scale_factor=self._emulation.get(
                    "device_scale_factor", 1.0,
                ),
                mobile=self._emulation.get("mobile", False),
            )

    # ------------------------------------------------------------------
    # Init scripts
    # ------------------------------------------------------------------

    async def add_init_script(self, script: str) -> None:
        """Store an init script to be applied to all future pages.

        Also applies it to any already-existing pages via
        Page.addScriptToEvaluateOnNewDocument.
        """
        self._init_scripts.append(script)
        for page in self._pages:
            page.add_init_script(script)

    # ------------------------------------------------------------------
    # Cookies
    # ------------------------------------------------------------------

    async def cookies(self, urls: Optional[List[str]] = None) -> List[Dict]:
        """Get cookies, optionally filtered by URLs.

        Uses the first page's session for the Network domain call.
        """
        if not self._pages:
            return []
        session_id = self._pages[0]._sid
        params: Dict[str, Any] = {}
        if urls:
            params["urls"] = urls
        result = await self._conn.send(
            "Network.getCookies", params, session_id=session_id,
        )
        return result.get("cookies", [])

    async def add_cookies(self, cookies: List[Dict[str, Any]]) -> None:
        """Add cookies to the browser.

        Each dict should have at minimum: name, value, domain (or url).
        """
        if not self._pages:
            return
        session_id = self._pages[0]._sid
        for cookie in cookies:
            c = dict(cookie)
            # CDP Network.setCookie needs url for secure cookies
            if "url" not in c and "domain" in c:
                scheme = "https" if c.get("secure") else "http"
                domain = c["domain"].lstrip(".")
                c["url"] = f"{scheme}://{domain}{c.get('path', '/')}"
            await self._conn.send(
                "Network.setCookie", c, session_id=session_id,
            )

    async def clear_cookies(self) -> None:
        """Clear all browser cookies in this context."""
        if not self._pages:
            return
        session_id = self._pages[0]._sid
        await self._conn.send(
            "Network.clearBrowserCookies", session_id=session_id,
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def close(self) -> None:
        """Close all pages and dispose the browser context."""
        if self._closed:
            return
        self._closed = True

        for page in self._pages:
            try:
                await page.close()
            except Exception:
                logger.debug("Error closing page in context %s", self._context_id)
        self._pages.clear()

        try:
            await self._conn.send("Target.disposeBrowserContext", {
                "browserContextId": self._context_id,
            })
        except Exception:
            logger.debug("Error disposing context %s", self._context_id)

    def __repr__(self) -> str:
        n = len(self._pages)
        return f"CDPBrowserContext({self._context_id!r}, pages={n})"
