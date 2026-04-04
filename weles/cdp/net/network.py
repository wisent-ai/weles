"""CDP network interception via the Fetch domain (page.route replacement)."""

from __future__ import annotations

import base64
import fnmatch
import logging
import re
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple

if TYPE_CHECKING:
    from ..connection import CDPConnection

logger = logging.getLogger(__name__)


def _glob_to_regex(pattern: str) -> re.Pattern:
    """Convert a Playwright-style glob pattern to a compiled regex.

    Supports:
        *   — matches any characters except /
        **  — matches any characters including /
        ?   — matches a single character
    """
    parts: List[str] = []
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                parts.append(".*")
                i += 2
                continue
            parts.append("[^/]*")
        elif ch == "?":
            parts.append(".")
        elif ch in r"\.+^${}()|[]":
            parts.append("\\" + ch)
        else:
            parts.append(ch)
        i += 1
    return re.compile("^" + "".join(parts) + "$")


class CDPRequest:
    """Read-only representation of an intercepted request."""

    def __init__(self, data: Dict[str, Any]):
        self._data = data
        req = data.get("request", {})
        self.url: str = req.get("url", "")
        self.method: str = req.get("method", "GET")
        self.headers: Dict[str, str] = req.get("headers", {})
        self.post_data: Optional[str] = req.get("postData")
        self.resource_type: str = data.get("resourceType", "")


class CDPRoute:
    """Provides methods to continue, fulfill, or abort an intercepted request."""

    def __init__(
        self,
        connection: CDPConnection,
        session_id: str,
        request_id: str,
        request: CDPRequest,
    ):
        self._conn = connection
        self._sid = session_id
        self._request_id = request_id
        self.request = request
        self._handled = False

    async def continue_(
        self,
        *,
        url: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        method: Optional[str] = None,
        post_data: Optional[str] = None,
    ) -> None:
        """Continue the request, optionally modifying URL/headers/body."""
        if self._handled:
            return
        self._handled = True
        params: Dict[str, Any] = {"requestId": self._request_id}
        if url is not None:
            params["url"] = url
        if method is not None:
            params["method"] = method
        if headers is not None:
            params["headers"] = [
                {"name": k, "value": v} for k, v in headers.items()
            ]
        if post_data is not None:
            params["postData"] = post_data
        await self._conn.send(
            "Fetch.continueRequest", params, session_id=self._sid,
        )

    async def fulfill(
        self,
        *,
        status: int = 200,
        headers: Optional[Dict[str, str]] = None,
        body: str = "",
    ) -> None:
        """Fulfill the request with a custom response."""
        if self._handled:
            return
        self._handled = True
        encoded = base64.b64encode(body.encode()).decode()
        params: Dict[str, Any] = {
            "requestId": self._request_id,
            "responseCode": status,
            "body": encoded,
        }
        if headers:
            params["responseHeaders"] = [
                {"name": k, "value": v} for k, v in headers.items()
            ]
        await self._conn.send(
            "Fetch.fulfillRequest", params, session_id=self._sid,
        )

    async def abort(self, reason: str = "Failed") -> None:
        """Abort the request with the given reason.

        Valid reasons: Failed, Aborted, TimedOut, AccessDenied,
        ConnectionClosed, ConnectionReset, ConnectionRefused,
        ConnectionAborted, ConnectionFailed, NameNotResolved,
        InternetDisconnected, AddressUnreachable, BlockedByClient,
        BlockedByResponse.
        """
        if self._handled:
            return
        self._handled = True
        await self._conn.send("Fetch.failRequest", {
            "requestId": self._request_id,
            "errorReason": reason,
        }, session_id=self._sid)


class CDPNetworkManager:
    """Manages request interception for a single page session.

    Replaces Playwright's page.route() with CDP Fetch domain support.
    """

    def __init__(self):
        self._conn: Optional[CDPConnection] = None
        self._session_id: Optional[str] = None
        self._routes: List[Tuple[re.Pattern, Callable]] = []
        self._enabled = False

    async def setup(self, connection: CDPConnection, session_id: str) -> None:
        """Register for Fetch.requestPaused events on the given session."""
        self._conn = connection
        self._session_id = session_id
        connection.on(
            "Fetch.requestPaused", self._on_request_paused,
            session_id=session_id,
        )

    async def _enable_fetch(self) -> None:
        """Enable the Fetch domain if routes exist and it's not yet enabled."""
        if self._enabled or not self._conn or not self._session_id:
            return
        await self._conn.send("Fetch.enable", {
            "handleAuthRequests": False,
            "patterns": [{"urlPattern": "*", "requestStage": "Request"}],
        }, session_id=self._session_id)
        self._enabled = True

    async def _disable_fetch(self) -> None:
        """Disable the Fetch domain when no routes remain."""
        if not self._enabled or not self._conn or not self._session_id:
            return
        try:
            await self._conn.send(
                "Fetch.disable", session_id=self._session_id,
            )
        except Exception:
            pass
        self._enabled = False

    async def add_route(self, pattern: str, handler: Callable) -> None:
        """Register a URL pattern and its async handler.

        The handler receives a CDPRoute object and must call one of:
        route.continue_(), route.fulfill(), or route.abort().

        Pattern supports glob syntax: * (segment), ** (any path), ? (char).
        """
        compiled = _glob_to_regex(pattern)
        self._routes.append((compiled, handler))
        await self._enable_fetch()

    async def remove_route(self, pattern: str) -> None:
        """Remove a previously added route by its original glob pattern."""
        compiled = _glob_to_regex(pattern)
        regex_str = compiled.pattern
        self._routes = [
            (rx, h) for rx, h in self._routes if rx.pattern != regex_str
        ]
        if not self._routes:
            await self._disable_fetch()

    async def _on_request_paused(self, params: Dict[str, Any]) -> None:
        """Handle a Fetch.requestPaused event."""
        request_id = params.get("requestId", "")
        req = CDPRequest(params)

        for regex, handler in self._routes:
            if regex.search(req.url):
                route = CDPRoute(
                    self._conn, self._session_id, request_id, req,
                )
                try:
                    await handler(route)
                except Exception:
                    logger.exception(
                        "Error in route handler for %s", req.url,
                    )
                    if not route._handled:
                        await route.continue_()
                return

        # No matching route — continue the request
        try:
            await self._conn.send("Fetch.continueRequest", {
                "requestId": request_id,
            }, session_id=self._session_id)
        except Exception:
            pass

    async def close(self) -> None:
        """Clean up: disable Fetch and remove event listener."""
        if self._conn and self._session_id:
            self._conn.off(
                "Fetch.requestPaused",
                self._on_request_paused,
                session_id=self._session_id,
            )
        await self._disable_fetch()
        self._routes.clear()
