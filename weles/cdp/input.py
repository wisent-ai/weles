"""CDP-based mouse and keyboard input via Input domain.

All input is human-like by default: mouse clicks include Bezier-curve
movement with realistic timing; key typing has per-character delays
drawn from a typing-speed distribution. Set WELES_INSTANT_INPUT=1 or
pass instant=True to bypass for tests where speed matters.
"""

from __future__ import annotations

import asyncio
import math
import os
import random
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .connection import CDPConnection


def _instant_mode() -> bool:
    return os.environ.get("WELES_INSTANT_INPUT") == "1"


async def _delay(seconds: float):
    """Non-event-driven delay used only for input timing simulation."""
    if seconds <= 0:
        return
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    loop.call_later(seconds, fut.set_result, None)
    await fut


def _bezier_path(start, end, steps=None):
    """Cubic Bezier path between two points with random control points."""
    x0, y0 = start
    x3, y3 = end
    dist = math.hypot(x3 - x0, y3 - y0)
    if steps is None:
        steps = max(15, min(60, int(dist / 8)))
    cx1 = x0 + (x3 - x0) * random.uniform(0.1, 0.4) + random.uniform(-30, 30)
    cy1 = y0 + (y3 - y0) * random.uniform(0.1, 0.4) + random.uniform(-30, 30)
    cx2 = x0 + (x3 - x0) * random.uniform(0.6, 0.9) + random.uniform(-30, 30)
    cy2 = y0 + (y3 - y0) * random.uniform(0.6, 0.9) + random.uniform(-30, 30)
    points = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * x0 + 3*u**2*t*cx1 + 3*u*t**2*cx2 + t**3 * x3
        y = u**3 * y0 + 3*u**2*t*cy1 + 3*u*t**2*cy2 + t**3 * y3
        points.append((x, y))
    return points

# Key definitions: name -> (keyCode, code, key)
_key_defs = {
    "Enter": (13, "Enter", "Enter"),
    "Tab": (9, "Tab", "Tab"),
    "Backspace": (8, "Backspace", "Backspace"),
    "Delete": (46, "Delete", "Delete"),
    "Escape": (27, "Escape", "Escape"),
    "ArrowUp": (38, "ArrowUp", "ArrowUp"),
    "ArrowDown": (40, "ArrowDown", "ArrowDown"),
    "ArrowLeft": (37, "ArrowLeft", "ArrowLeft"),
    "ArrowRight": (39, "ArrowRight", "ArrowRight"),
    "Home": (36, "Home", "Home"),
    "End": (35, "End", "End"),
    "PageUp": (33, "PageUp", "PageUp"),
    "PageDown": (34, "PageDown", "PageDown"),
    "Space": (32, "Space", " "),
    "Shift": (16, "ShiftLeft", "Shift"),
    "Control": (17, "ControlLeft", "Control"),
    "Alt": (18, "AltLeft", "Alt"),
    "Meta": (91, "MetaLeft", "Meta"),
    "F1": (112, "F1", "F1"),
    "F2": (113, "F2", "F2"),
    "F3": (114, "F3", "F3"),
    "F4": (115, "F4", "F4"),
    "F5": (116, "F5", "F5"),
    "F6": (117, "F6", "F6"),
    "F7": (118, "F7", "F7"),
    "F8": (119, "F8", "F8"),
    "F9": (120, "F9", "F9"),
    "F10": (121, "F10", "F10"),
    "F11": (122, "F11", "F11"),
    "F12": (123, "F12", "F12"),
    "a": (65, "KeyA", "a"),
    "b": (66, "KeyB", "b"),
    "c": (67, "KeyC", "c"),
    "v": (86, "KeyV", "v"),
    "x": (88, "KeyX", "x"),
    "z": (90, "KeyZ", "z"),
}


def _resolve_key(key: str):
    """Resolve a key name to (keyCode, code, key_value) tuple."""
    if key in _key_defs:
        return _key_defs[key]
    # Single character
    if len(key) == 1:
        code = f"Key{key.upper()}" if key.isalpha() else f"Digit{key}" if key.isdigit() else ""
        return (ord(key.upper()), code, key)
    return (0, "", key)


class CDPMouse:
    """Low-level mouse input via CDP Input.dispatchMouseEvent."""

    def __init__(self, connection: CDPConnection, session_id: str):
        self._conn = connection
        self._session_id = session_id
        self._x = 0.0
        self._y = 0.0

    async def click(self, x: float, y: float, *, button: str = "left",
                    click_count: int = 1, delay: Optional[float] = None,
                    instant: bool = False):
        """Click at coordinates with realistic human timing.

        - Moves cursor along a Bezier curve from current position
        - Hovers 100-300ms over target before pressing
        - mousedown -> mouseup gap is 50-150ms (random)

        Pass instant=True or set WELES_INSTANT_INPUT=1 to skip the
        realistic motion (still tracks cursor position).
        """
        instant = instant or _instant_mode()
        jx = x + random.uniform(-1.5, 1.5)
        jy = y + random.uniform(-1.5, 1.5)
        await self.move(jx, jy, instant=instant)
        if not instant:
            await _delay(random.uniform(0.1, 0.3))
        await self.down(button=button, click_count=click_count)
        if delay is None:
            press_delay = 0 if instant else random.uniform(0.05, 0.15)
        else:
            press_delay = delay / 1000
        await _delay(press_delay)
        await self.up(button=button, click_count=click_count)

    async def move(self, x: float, y: float, *, steps: Optional[int] = None,
                   instant: bool = False):
        """Move mouse with realistic Bezier-curve motion by default."""
        instant = instant or _instant_mode()
        if instant:
            await self._conn.send("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": x, "y": y,
            }, session_id=self._session_id)
            self._x = x
            self._y = y
            return
        path = _bezier_path((self._x, self._y), (x, y), steps)
        for ix, iy in path:
            await self._conn.send("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": ix, "y": iy,
            }, session_id=self._session_id)
            await _delay(random.uniform(0.005, 0.015))
        self._x = x
        self._y = y

    async def down(self, *, button: str = "left", click_count: int = 1):
        """Press mouse button down."""
        await self._conn.send("Input.dispatchMouseEvent", {
            "type": "mousePressed",
            "button": button,
            "x": self._x,
            "y": self._y,
            "clickCount": click_count,
        }, session_id=self._session_id)

    async def up(self, *, button: str = "left", click_count: int = 1):
        """Release mouse button."""
        await self._conn.send("Input.dispatchMouseEvent", {
            "type": "mouseReleased",
            "button": button,
            "x": self._x,
            "y": self._y,
            "clickCount": click_count,
        }, session_id=self._session_id)

    async def wheel(self, delta_x: float = 0, delta_y: float = 0):
        """Dispatch a mouse wheel event."""
        await self._conn.send("Input.dispatchMouseEvent", {
            "type": "mouseWheel",
            "x": self._x,
            "y": self._y,
            "deltaX": delta_x,
            "deltaY": delta_y,
        }, session_id=self._session_id)


class CDPKeyboard:
    """Low-level keyboard input via CDP Input.dispatchKeyEvent."""

    def __init__(self, connection: CDPConnection, session_id: str):
        self._conn = connection
        self._session_id = session_id
        self._modifiers = 0

    async def down(self, key: str):
        """Press a key down."""
        key_code, code, key_val = _resolve_key(key)
        params = {
            "type": "keyDown",
            "key": key_val,
            "code": code,
            "windowsVirtualKeyCode": key_code,
            "nativeVirtualKeyCode": key_code,
        }
        if key == "Shift":
            self._modifiers |= 8
        elif key == "Control":
            self._modifiers |= 4
        elif key == "Alt":
            self._modifiers |= 2
        elif key == "Meta":
            self._modifiers |= 1
        params["modifiers"] = self._modifiers
        await self._conn.send("Input.dispatchKeyEvent", params,
                              session_id=self._session_id)

    async def up(self, key: str):
        """Release a key."""
        key_code, code, key_val = _resolve_key(key)
        if key == "Shift":
            self._modifiers &= ~8
        elif key == "Control":
            self._modifiers &= ~4
        elif key == "Alt":
            self._modifiers &= ~2
        elif key == "Meta":
            self._modifiers &= ~1
        await self._conn.send("Input.dispatchKeyEvent", {
            "type": "keyUp",
            "key": key_val,
            "code": code,
            "windowsVirtualKeyCode": key_code,
            "nativeVirtualKeyCode": key_code,
            "modifiers": self._modifiers,
        }, session_id=self._session_id)

    async def press(self, key: str, *, delay: Optional[float] = None,
                    instant: bool = False):
        """Press and release a key with realistic key-down hold time."""
        instant = instant or _instant_mode()
        await self.down(key)
        if delay is None:
            hold = 0 if instant else random.uniform(0.04, 0.12)
        else:
            hold = delay / 1000
        await _delay(hold)
        await self.up(key)

    async def type(self, text: str, *, delay: Optional[float] = None,
                   instant: bool = False):
        """Type a string with realistic per-character timing.

        Per-character delays are sampled from a typing-speed distribution
        (~80-180ms) with occasional longer pauses on punctuation/spaces.
        Pass instant=True or set WELES_INSTANT_INPUT=1 to type with no
        delay between characters.
        """
        instant = instant or _instant_mode()
        for char in text:
            if char in _key_defs:
                await self.press(char, instant=instant)
            else:
                await self.insert_text(char)
            if instant:
                continue
            if delay is None:
                gap = random.uniform(0.08, 0.18)
                if char in (".", ",", " ", "?", "!"):
                    gap += random.uniform(0.05, 0.2)
                if random.random() < 0.04:
                    gap += random.uniform(0.2, 0.6)  # thinking pause
            else:
                gap = delay / 1000
            await _delay(gap)

    async def insert_text(self, text: str):
        """Insert text without key events (IME-style)."""
        await self._conn.send("Input.insertText", {
            "text": text,
        }, session_id=self._session_id)
