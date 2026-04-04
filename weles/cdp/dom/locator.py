"""Element locator with Playwright-compatible API over CDP."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from ..errors import CDPTimeoutError
from . import locator_js as js

logger = logging.getLogger(__name__)


async def _wait_tick(loop: asyncio.AbstractEventLoop, ms: float) -> None:
    """Non-sleep delay using call_later + Future."""
    fut: asyncio.Future = loop.create_future()
    loop.call_later(ms / 1000.0, fut.set_result, None)
    await fut


class CDPLocator:
    """Finds and interacts with DOM elements via CSS selectors.

    Mirrors the Playwright Locator API. All element lookups and interactions
    are performed through JavaScript evaluation on the parent page or frame.

    JS snippets live in locator_js.py. Each accepts a single array arg
    so it works with CDPFrame.evaluate(expr, arg).
    """

    def __init__(self, page_or_frame: Any, selector: str, *, index: int = -1):
        self._parent = page_or_frame
        self._selector = selector
        self._index = index  # -1 means "first match" for single-element ops

    @property
    def first(self) -> CDPLocator:
        """Return a locator targeting the first matching element."""
        return CDPLocator(self._parent, self._selector, index=0)

    def nth(self, n: int) -> CDPLocator:
        """Return a locator targeting the nth matching element (0-based)."""
        return CDPLocator(self._parent, self._selector, index=n)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _args(self, *extra: Any) -> list:
        """Build the single-array argument for JS snippets."""
        return [self._selector, self._index, *extra]

    async def _eval(self, snippet: str, *extra: Any) -> Any:
        """Evaluate a JS snippet with [selector, index, ...extra] as arg."""
        return await self._parent.evaluate(snippet, self._args(*extra))

    async def _bounding_box(self) -> Optional[Dict[str, float]]:
        return await self._eval(js.bbox)

    async def _ensure_visible(self, ms: int) -> Dict[str, float]:
        """Poll until element is visible and return its bounding box."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + ms / 1000.0
        while True:
            box = await self._bounding_box()
            if box and box["width"] > 0 and box["height"] > 0:
                vis = await self._eval(js.visibility)
                if vis:
                    return box
            if loop.time() >= deadline:
                raise CDPTimeoutError(
                    f"Waiting for visible element: {self._selector}"
                )
            await _wait_tick(loop, 50)

    async def _focus_element(self) -> None:
        await self._eval(js.focus_el)

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    async def click(
        self,
        *,
        position: Optional[Dict[str, float]] = None,
        force: bool = False,
        wait_ms: int = 30000,
    ) -> None:
        """Click the element's center (or offset position)."""
        if force:
            box = await self._bounding_box()
            if not box:
                raise CDPTimeoutError(
                    f"Element not found: {self._selector}"
                )
        else:
            box = await self._ensure_visible(wait_ms)
        x = box["x"] + (position["x"] if position else box["width"] / 2)
        y = box["y"] + (position["y"] if position else box["height"] / 2)
        await self._parent.mouse.click(x, y)

    async def fill(self, value: str, *, wait_ms: int = 30000) -> None:
        """Clear the input and type a new value."""
        await self._ensure_visible(wait_ms)
        await self._eval(js.clear_input)
        await self._parent.keyboard.insert_text(value)

    async def type(self, text: str, *, delay: float = 0) -> None:
        """Type text character by character after focusing the element."""
        await self._focus_element()
        await self._parent.keyboard.type(text, delay=delay)

    async def press_sequentially(self, text: str, *, delay: float = 0) -> None:
        """Alias for type()."""
        await self.type(text, delay=delay)

    async def press(self, key: str) -> None:
        """Focus the element then press a key."""
        await self._focus_element()
        await self._parent.keyboard.press(key)

    async def focus(self) -> None:
        """Focus the element."""
        await self._focus_element()

    async def check(self, *, wait_ms: int = 30000) -> None:
        """Check a checkbox if not already checked."""
        await self._ensure_visible(wait_ms)
        if not await self._eval(js.is_checked):
            await self.click(wait_ms=wait_ms)

    async def uncheck(self, *, wait_ms: int = 30000) -> None:
        """Uncheck a checkbox if currently checked."""
        await self._ensure_visible(wait_ms)
        if await self._eval(js.is_checked):
            await self.click(wait_ms=wait_ms)

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def is_visible(self, *, wait_ms: Optional[int] = None) -> bool:
        """Return True if the element is visible.

        With wait_ms, polls until visible or the time elapses.
        """
        if not wait_ms:
            return await self._eval(js.visibility)
        loop = asyncio.get_event_loop()
        deadline = loop.time() + wait_ms / 1000.0
        while True:
            if await self._eval(js.visibility):
                return True
            if loop.time() >= deadline:
                return False
            await _wait_tick(loop, 50)

    async def is_enabled(self) -> bool:
        """Return True if the element is not disabled."""
        return await self._eval(js.is_enabled)

    async def count(self) -> int:
        """Return the number of elements matching the selector."""
        return await self._parent.evaluate(
            js.count_els, [self._selector],
        )

    async def text_content(self) -> Optional[str]:
        """Return textContent of the element."""
        return await self._eval(js.text_content)

    async def inner_text(self) -> Optional[str]:
        """Return innerText of the element."""
        return await self._eval(js.inner_text)

    async def inner_html(self) -> Optional[str]:
        """Return innerHTML of the element."""
        return await self._eval(js.inner_html)

    async def get_attribute(self, name: str) -> Optional[str]:
        """Return the value of an attribute on the element."""
        return await self._eval(js.get_attr, name)

    async def bounding_box(self) -> Optional[Dict[str, float]]:
        """Return the element's bounding rectangle {x, y, width, height}."""
        return await self._bounding_box()

    async def all(self) -> List[CDPLocator]:
        """Return a list of CDPLocator instances, one per matching element."""
        n = await self.count()
        return [
            CDPLocator(self._parent, self._selector, index=i)
            for i in range(n)
        ]

    async def wait_for(
        self, *, state: str = "visible", wait_ms: int = 30000,
    ) -> None:
        """Wait until the element reaches the desired state.

        Args:
            state: "visible" or "attached".
            wait_ms: Maximum wait in milliseconds.
        """
        loop = asyncio.get_event_loop()
        deadline = loop.time() + wait_ms / 1000.0
        while True:
            if state == "visible":
                if await self._eval(js.visibility):
                    return
            elif state == "attached":
                n = await self.count()
                target = 1 if self._index == -1 else self._index + 1
                if n >= target:
                    return
            else:
                raise ValueError(f"Unknown wait_for state: {state}")
            if loop.time() >= deadline:
                raise CDPTimeoutError(
                    f"Waiting for '{state}': {self._selector}"
                )
            await _wait_tick(loop, 50)

    def __repr__(self) -> str:
        idx = f"[{self._index}]" if self._index >= 0 else ""
        return f"CDPLocator({self._selector!r}{idx})"
