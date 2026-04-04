"""WebSocket CDP connection manager with session multiplexing."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Dict, List, Optional, Tuple

import websockets
import websockets.asyncio.client

from .errors import CDPError, CDPTargetClosedError

logger = logging.getLogger(__name__)


class CDPConnection:
    """Manages a WebSocket connection to a Chrome DevTools Protocol endpoint.

    Supports browser-level commands (no session_id) and per-target commands
    (with session_id) multiplexed over a single WebSocket.
    """

    def __init__(self):
        self._ws: Optional[websockets.asyncio.client.ClientConnection] = None
        self._next_id = 1
        self._pending: Dict[int, asyncio.Future] = {}
        self._listeners: Dict[Tuple[str, Optional[str]], List[Callable]] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._closed = False

    async def connect(self, ws_url: str) -> None:
        """Connect to Chrome's WebSocket debugging endpoint.

        Args:
            ws_url: The ws:// URL from Chrome's --remote-debugging-port output.
        """
        self._ws = await websockets.asyncio.client.connect(
            ws_url,
            max_size=64 * 1024 * 1024,  # 64 MB for large payloads
        )
        self._closed = False
        self._reader_task = asyncio.create_task(self._read_loop())

    async def send(
        self,
        method: str,
        params: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a CDP command and await its response.

        Args:
            method: CDP method name (e.g. "Page.navigate").
            params: Optional parameters dict.
            session_id: Target session ID for per-target commands. None for browser-level.

        Returns:
            The "result" dict from the CDP response.

        Raises:
            CDPTargetClosedError: If the connection is closed.
            CDPError: If the CDP response contains an error.
        """
        if self._closed or self._ws is None:
            raise CDPTargetClosedError("Connection is closed")

        msg_id = self._next_id
        self._next_id += 1

        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = future

        message: Dict[str, Any] = {"id": msg_id, "method": method}
        if params:
            message["params"] = params
        if session_id:
            message["sessionId"] = session_id

        try:
            await self._ws.send(json.dumps(message))
        except Exception as exc:
            self._pending.pop(msg_id, None)
            raise CDPTargetClosedError(f"Failed to send: {exc}") from exc

        return await future

    def on(
        self,
        event: str,
        callback: Callable,
        session_id: Optional[str] = None,
    ) -> None:
        """Register a listener for a CDP event.

        Args:
            event: Event name (e.g. "Page.loadEventFired").
            callback: Async or sync callable. Receives the event params dict.
            session_id: If set, only fires for events on that session.
        """
        key = (event, session_id)
        self._listeners.setdefault(key, []).append(callback)

    def off(self, event: str, callback: Callable, session_id: Optional[str] = None) -> None:
        """Remove a previously registered event listener.

        Args:
            event: Event name.
            callback: The exact callback reference to remove.
            session_id: Must match the session_id used in on().
        """
        key = (event, session_id)
        cbs = self._listeners.get(key)
        if cbs:
            try:
                cbs.remove(callback)
            except ValueError:
                pass
            if not cbs:
                del self._listeners[key]

    async def close(self) -> None:
        """Close the WebSocket connection and cancel background tasks."""
        if self._closed:
            return
        self._closed = True

        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass

        # Reject all pending futures
        for msg_id, future in self._pending.items():
            if not future.done():
                future.set_exception(CDPTargetClosedError("Connection closed"))
        self._pending.clear()

        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    @property
    def closed(self) -> bool:
        return self._closed

    async def _read_loop(self) -> None:
        """Background task: read messages from WebSocket and dispatch them."""
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Received non-JSON message from CDP")
                    continue

                if "id" in msg:
                    self._handle_response(msg)
                elif "method" in msg:
                    await self._handle_event(msg)

        except websockets.exceptions.ConnectionClosed:
            logger.debug("CDP WebSocket connection closed")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unexpected error in CDP read loop")
        finally:
            if not self._closed:
                self._closed = True
                for future in self._pending.values():
                    if not future.done():
                        future.set_exception(
                            CDPTargetClosedError("WebSocket connection lost")
                        )
                self._pending.clear()

    def _handle_response(self, msg: Dict[str, Any]) -> None:
        """Resolve the pending future for a command response."""
        msg_id = msg["id"]
        future = self._pending.pop(msg_id, None)
        if future is None or future.done():
            return

        if "error" in msg:
            err = msg["error"]
            code = err.get("code", -1)
            message = err.get("message", "Unknown CDP error")
            future.set_exception(CDPError(f"CDP error {code}: {message}"))
        else:
            future.set_result(msg.get("result", {}))

    async def _handle_event(self, msg: Dict[str, Any]) -> None:
        """Dispatch a CDP event to registered listeners."""
        method = msg["method"]
        params = msg.get("params", {})
        session_id = msg.get("sessionId")

        # Collect matching listeners: session-specific first, then global
        callbacks = []
        if session_id:
            callbacks.extend(self._listeners.get((method, session_id), []))
        callbacks.extend(self._listeners.get((method, None), []))

        for cb in callbacks:
            try:
                result = cb(params)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.exception("Error in CDP event listener for %s", method)
