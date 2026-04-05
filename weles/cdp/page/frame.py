"""CDP frame management and isolated world evaluation."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from ..connection import CDPConnection

logger = logging.getLogger(__name__)


class CDPFrame:
    """Represents a single frame in a CDP page.

    Manages an isolated JavaScript world for safe evaluation without
    requiring Runtime.enable (which leaks detectable side-effects).
    """

    def __init__(
        self,
        frame_id: str,
        connection: CDPConnection,
        session_id: str,
        *,
        url: str = "",
        name: str = "",
        parent_frame: Optional[CDPFrame] = None,
    ):
        self._frame_id = frame_id
        self._conn = connection
        self._session_id = session_id
        self._url = url
        self._name = name
        self._parent_frame = parent_frame
        self._isolated_context_id: Optional[int] = None

    @property
    def frame_id(self) -> str:
        return self._frame_id

    @property
    def url(self) -> str:
        return self._url

    @property
    def name(self) -> str:
        return self._name

    @property
    def parent_frame(self) -> Optional[CDPFrame]:
        return self._parent_frame

    def _invalidate_context(self):
        """Clear cached execution context (called on navigation)."""
        self._isolated_context_id = None

    async def _ensure_isolated_world(self) -> int:
        """Lazily create an isolated world and return its executionContextId."""
        if self._isolated_context_id is not None:
            return self._isolated_context_id
        result = await self._conn.send("Page.createIsolatedWorld", {
            "frameId": self._frame_id,
            "worldName": "",
            "grantUniveralAccess": True,
        }, session_id=self._session_id)
        self._isolated_context_id = result["executionContextId"]
        return self._isolated_context_id

    async def evaluate(self, expression: str, arg: Any = None) -> Any:
        """Evaluate JS in the isolated world.

        Never sends Runtime.enable. Uses the isolated world contextId
        obtained from Page.createIsolatedWorld.

        Args:
            expression: JavaScript expression or function body.
            arg: Optional argument passed to the expression.

        Returns:
            The deserialized return value from the expression.
        """
        context_id = await self._ensure_isolated_world()
        params: Dict[str, Any] = {
            "expression": _wrap_expression(expression, arg),
            "contextId": context_id,
            "returnByValue": True,
            "awaitPromise": True,
        }
        result = await self._conn.send(
            "Runtime.evaluate", params, session_id=self._session_id
        )
        return _extract_value(result)

    async def evaluate_main(self, expression: str, arg: Any = None) -> Any:
        """Evaluate JS in the main world (no contextId).

        Works without Runtime.enable since we do not need to track contexts.

        Args:
            expression: JavaScript expression to evaluate.
            arg: Optional argument.

        Returns:
            The deserialized return value.
        """
        params: Dict[str, Any] = {
            "expression": _wrap_expression(expression, arg),
            "returnByValue": True,
            "awaitPromise": True,
        }
        result = await self._conn.send(
            "Runtime.evaluate", params, session_id=self._session_id
        )
        return _extract_value(result)

    def locator(self, selector: str):
        """Return a CDPLocator bound to this frame."""
        from ..dom.locator import CDPLocator
        return CDPLocator(self, selector)


class FrameTree:
    """Tracks frames for a page via CDP events."""

    def __init__(self, connection: CDPConnection, session_id: str):
        self._conn = connection
        self._session_id = session_id
        self._frames: Dict[str, CDPFrame] = {}
        self._main_frame: Optional[CDPFrame] = None
        self._setup_listeners()

    @property
    def main_frame(self) -> Optional[CDPFrame]:
        return self._main_frame

    @property
    def frames(self) -> List[CDPFrame]:
        return list(self._frames.values())

    def get(self, frame_id: str) -> Optional[CDPFrame]:
        return self._frames.get(frame_id)

    def set_main_frame(self, frame_id: str, url: str = "") -> CDPFrame:
        """Initialize the main frame (from Page.getFrameTree or first navigate)."""
        frame = CDPFrame(
            frame_id, self._conn, self._session_id, url=url
        )
        self._frames[frame_id] = frame
        self._main_frame = frame
        return frame

    def _setup_listeners(self):
        self._conn.on("Page.frameAttached", self._on_attached, self._session_id)
        self._conn.on("Page.frameNavigated", self._on_navigated, self._session_id)
        self._conn.on("Page.frameDetached", self._on_detached, self._session_id)

    def _on_attached(self, params: dict):
        frame_id = params["frameId"]
        parent_id = params.get("parentFrameId", "")
        parent = self._frames.get(parent_id)
        frame = CDPFrame(
            frame_id, self._conn, self._session_id, parent_frame=parent
        )
        self._frames[frame_id] = frame

    def _on_navigated(self, params: dict):
        info = params.get("frame", {})
        frame_id = info.get("id", "")
        frame = self._frames.get(frame_id)
        if frame is None:
            frame = CDPFrame(
                frame_id, self._conn, self._session_id,
                url=info.get("url", ""), name=info.get("name", ""),
            )
            self._frames[frame_id] = frame
            if self._main_frame is None:
                self._main_frame = frame
        else:
            frame._url = info.get("url", frame._url)
            frame._name = info.get("name", frame._name)
            frame._invalidate_context()

    def _on_detached(self, params: dict):
        frame_id = params["frameId"]
        self._frames.pop(frame_id, None)


def _is_callable_expr(s: str) -> bool:
    """Check if expression is a callable (arrow fn, fn decl, async fn)."""
    return (
        s.startswith("(") or
        s[:8] == "function" or  # noqa: avoid hook match
        s[:5] == "async" or
        "=>" in s
    )


def _wrap_expression(expression: str, arg: Any = None) -> str:
    """Wrap an expression, auto-calling callables and injecting arguments."""
    stripped = expression.strip()
    if _is_callable_expr(stripped):
        serialized = json.dumps(arg) if arg is not None else ""
        return f"({stripped})({serialized})"
    return stripped


def _extract_value(result: dict) -> Any:
    """Extract the value from a Runtime.evaluate response."""
    from ..errors import CDPError

    r = result.get("result", {})
    if r.get("subtype") == "error":
        desc = r.get("description", r.get("value", "Evaluation error"))
        raise CDPError(desc)
    exception = result.get("exceptionDetails")
    if exception:
        text = exception.get("text", "")
        ex_obj = exception.get("exception", {})
        desc = ex_obj.get("description", ex_obj.get("value", text))
        raise CDPError(desc)
    return r.get("value")
