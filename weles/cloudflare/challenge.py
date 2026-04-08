"""Cloudflare challenge detection and bypass using vision.

Uses Claude vision to detect the challenge and locate the verification
checkbox. The click is dispatched through CDPMouse which uses Bezier
curves and realistic timing by default.

If Claude refuses to answer the vision query (safety refusal), the
underlying VisionRefusedError propagates so the failure is visible
and the prompt or context can be fixed.
"""

import logging

from .config import CF_CHECK_INTERVAL_MS

logger = logging.getLogger(__name__)


async def wait_cloudflare(page, timeout_ms: int = 72000,
                          settle_ms: int = 5000) -> bool:
    """Wait for Cloudflare challenge to resolve via vision-based clicking.

    Raises VisionRefusedError if Claude refuses to identify the click
    target. Returns True if no challenge or challenge clears within
    timeout, False if the challenge does not clear before timeout.
    """
    from ..cdp.dom.vision import check_page, find_click_target, ask_page

    await page.wait_for_timeout(settle_ms)

    raw_answer = await ask_page(
        page,
        "Is this a Cloudflare security verification or challenge page? "
        "Answer only YES or NO.",
    )
    is_cf = raw_answer.strip().upper().startswith("YES")
    print(f"  [cloudflare] raw vision answer: {repr(raw_answer)}")
    print(f"  [cloudflare] challenge detected: {is_cf}")

    if not is_cf:
        return True

    target = await find_click_target(
        page, "the checkbox or button to verify you are human")
    print(f"  [cloudflare] click target: {target}")
    if target is None:
        print("  [cloudflare] no click target found - challenge likely "
              "in non-interactive auto-pass mode")
    else:
        await page.mouse.click(target["x"], target["y"])
        print(f"  [cloudflare] clicked at ({target['x']}, {target['y']})")

    checks = timeout_ms // CF_CHECK_INTERVAL_MS
    for i in range(checks):
        await page.wait_for_timeout(CF_CHECK_INTERVAL_MS)
        still_cf = await check_page(
            page,
            "Is this a Cloudflare security verification or challenge page?",
        )
        print(f"  [cloudflare] check {i+1}/{checks}: still challenged = "
              f"{still_cf}")
        if not still_cf:
            return True

    return False


async def is_challenged(page) -> bool:
    """Check if the page is currently showing a Cloudflare challenge."""
    from ..cdp.dom.vision import check_page
    return await check_page(
        page,
        "Is this a Cloudflare security verification or challenge page?",
    )


async def bypass_cloudflare(page, solver=None, timeout_ms: int = 72000) -> bool:
    """Full Cloudflare bypass via vision-based detection and clicking."""
    return await wait_cloudflare(page, timeout_ms=timeout_ms)
