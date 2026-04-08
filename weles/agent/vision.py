"""Typed vision extractors built on weles.cdp.dom.vision.

Provides number/text/boolean/click/fill that take a page and a
description in plain English and return typed values. No selectors,
no regex, no per-site code.

Every extractor goes through the find_click_target escalation
pipeline (full screenshot -> centered crop -> JSON decomposition)
when applied to click/fill, and through ask_page directly when
applied to number/text/boolean.
"""
import re
from typing import Any, Optional

from ..cdp.dom.vision import ask_page, find_click_target


_NONE_MARKERS = ("none", "null", "n/a", "not visible", "no balance", "not found")


def _is_none_answer(answer: str) -> bool:
    low = answer.strip().lower()
    if not low:
        return True
    return any(m in low for m in _NONE_MARKERS)


async def number(page: Any, what: str) -> Optional[float]:
    """Read a numeric value from the page via vision.

    Args:
        page: Playwright/CDP page.
        what: Description of the value (e.g. "the credit balance",
              "the user count", "the price in dollars").

    Returns the float value, or None if Claude could not find it.
    Strips currency symbols, thousands separators, and surrounding text.
    """
    answer = await ask_page(
        page,
        f"What is {what} shown on this page? "
        "Return ONLY the numeric value (e.g. 12.34) - no currency "
        "symbol, no commas, no words. If no such value is visible, "
        "return NONE.",
    )
    if _is_none_answer(answer):
        return None
    cleaned = re.sub(r"[^\d.\-]", "", answer.strip())
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


async def text(page: Any, what: str) -> Optional[str]:
    """Read a text value from the page via vision.

    Returns the text value, or None if Claude could not find it.
    """
    answer = await ask_page(
        page,
        f"What is {what} shown on this page? "
        "Return ONLY the text value, no other words. If no such "
        "value is visible, return NONE.",
    )
    if _is_none_answer(answer):
        return None
    return answer.strip()


async def boolean(page: Any, question: str) -> bool:
    """Ask a yes/no question and return a bool."""
    answer = await ask_page(
        page,
        f"{question} Answer ONLY YES or NO.",
    )
    return answer.strip().upper().startswith("YES")


async def click(page: Any, target_description: str) -> bool:
    """Find and click an element via vision.

    Uses the find_click_target escalation pipeline so refusals fall
    through to cropping and decomposition. Returns True if a click
    happened, False if no target was found.
    """
    target = await find_click_target(page, target_description)
    if target is None:
        return False
    await page.mouse.click(target["x"], target["y"])
    return True


async def fill(page: Any, target_description: str, value: str) -> bool:
    """Find a form field via vision and type a value into it.

    Clicks the field first to focus it, then types via the
    keyboard (which already uses per-character delays). Returns
    True if a field was found, False otherwise.
    """
    target = await find_click_target(page, target_description)
    if target is None:
        return False
    await page.mouse.click(target["x"], target["y"])
    await page.keyboard.type(value)
    return True
