"""CDP-based mouse and keyboard input via Input domain."""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .connection import CDPConnection

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
                    click_count: int = 1, delay: float = 0):
        """Click at coordinates. delay is in ms between down/up."""
        await self.move(x, y)
        await self.down(button=button, click_count=click_count)
        if delay > 0:
            from .page import CDPPage
            loop = __import__("asyncio").get_event_loop()
            fut = loop.create_future()
            loop.call_later(delay / 1000, fut.set_result, None)
            await fut
        await self.up(button=button, click_count=click_count)

    async def move(self, x: float, y: float, *, steps: int = 1):
        """Move mouse to coordinates, optionally with intermediate steps."""
        start_x, start_y = self._x, self._y
        for i in range(1, steps + 1):
            ix = start_x + (x - start_x) * (i / steps)
            iy = start_y + (y - start_y) * (i / steps)
            await self._conn.send("Input.dispatchMouseEvent", {
                "type": "mouseMoved",
                "x": ix,
                "y": iy,
            }, session_id=self._session_id)
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

    async def press(self, key: str, *, delay: float = 0):
        """Press and release a key. delay in ms."""
        await self.down(key)
        if delay > 0:
            loop = __import__("asyncio").get_event_loop()
            fut = loop.create_future()
            loop.call_later(delay / 1000, fut.set_result, None)
            await fut
        await self.up(key)

    async def type(self, text: str, *, delay: float = 0):
        """Type a string character by character."""
        loop = __import__("asyncio").get_event_loop()
        for char in text:
            if char in _key_defs:
                await self.press(char, delay=delay)
            else:
                await self.insert_text(char)
            if delay > 0:
                fut = loop.create_future()
                loop.call_later(delay / 1000, fut.set_result, None)
                await fut

    async def insert_text(self, text: str):
        """Insert text without key events (IME-style)."""
        await self._conn.send("Input.insertText", {
            "text": text,
        }, session_id=self._session_id)
