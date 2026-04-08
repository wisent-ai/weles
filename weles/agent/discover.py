"""Page discovery via vision.

Given a page and a description of what to find, look for the value on
the current page; if not present, find a navigation link related to
the description and click it, then repeat.

Generic over any dashboard. The depth is bounded so the loop cannot
run forever even if no value is ever found.
"""
from typing import Any, Optional

from . import vision


_DEFAULT_DEPTH = 4


async def find_number(page: Any, what: str,
                      depth: int = _DEFAULT_DEPTH) -> Optional[float]:
    """Walk pages looking for a numeric value matching `what`.

    On each page:
      1. Try to read `what` directly via vision.
      2. If not found, ask vision to click a navigation link related
         to the description.
      3. Wait for network idle, then repeat.

    Returns the float value or None if `depth` pages were visited
    without finding the value.
    """
    for step in range(depth):
        value = await vision.number(page, what)
        if value is not None:
            print(f"[discover] found '{what}' = {value} at depth {step}")
            return value

        nav_target = (
            f"the navigation link, menu item, or button most likely "
            f"to lead to a page that shows {what}. Examples: billing, "
            f"balance, credits, account, wallet, dashboard, overview"
        )
        clicked = await vision.click(page, nav_target)
        if not clicked:
            print(f"[discover] no navigation target at depth {step}")
            return None
        try:
            await page.wait_for_load_state("networkidle")
        except Exception:
            pass

    print(f"[discover] depth {depth} exhausted without finding '{what}'")
    return None


async def find_text(page: Any, what: str,
                    depth: int = _DEFAULT_DEPTH) -> Optional[str]:
    """Walk pages looking for a text value matching `what`."""
    for step in range(depth):
        value = await vision.text(page, what)
        if value is not None:
            return value
        nav_target = (
            f"the navigation link, menu item, or button most likely "
            f"to lead to a page that shows {what}"
        )
        clicked = await vision.click(page, nav_target)
        if not clicked:
            return None
        try:
            await page.wait_for_load_state("networkidle")
        except Exception:
            pass
    return None
