"""Cloudflare challenge detection and bypass using vision.

Uses AI screenshot analysis to detect and interact with Cloudflare
challenges, instead of fragile selectors or keyword matching.
"""

import logging

from .config import CF_CHECK_INTERVAL_MS

logger = logging.getLogger(__name__)


async def wait_cloudflare(page, timeout_ms: int = 72000,
                          settle_ms: int = 5000) -> bool:
    """Wait for Cloudflare challenge to resolve, clicking via vision if needed.

    Uses AI to detect the challenge and find click targets. Works regardless
    of whether Turnstile renders as an iframe or inline widget.

    Returns True if no challenge or challenge clears within timeout.
    """
    from ..cdp.dom.vision import check_page, find_click_target

    await page.wait_for_timeout(settle_ms)

    # First check: is there a challenge at all?
    from ..cdp.dom.vision import ask_page
    raw_answer = await ask_page(
        page, "Is this a Cloudflare security verification or challenge page? Answer only YES or NO.")
    is_cf = raw_answer.strip().upper().startswith("YES")
    print(f"  [cloudflare] raw vision answer: {repr(raw_answer)}")
    print(f"  [cloudflare] challenge detected: {is_cf}")

    if not is_cf:
        return True

    # Find and click the verification target
    target = await find_click_target(
        page, "the checkbox or button to verify you are human")
    print(f"  [cloudflare] click target: {target}")
    if target:
        await page.mouse.click(target["x"], target["y"])
        print(f"  [cloudflare] clicked at ({target['x']}, {target['y']})")
    else:
        print("  [cloudflare] no click target found")

    # Poll until challenge clears
    checks = timeout_ms // CF_CHECK_INTERVAL_MS
    for i in range(checks):
        await page.wait_for_timeout(CF_CHECK_INTERVAL_MS)

        still_cf = await check_page(
            page, "Is this a Cloudflare security verification or challenge page?")
        print(f"  [cloudflare] check {i+1}/{checks}: still challenged = {still_cf}")

        if not still_cf:
            return True

    return False


async def is_challenged(page) -> bool:
    """Check if the page is currently showing a Cloudflare challenge."""
    from ..cdp.dom.vision import check_page
    return await check_page(
        page, "Is this a Cloudflare security verification or challenge page?")


async def bypass_cloudflare(page, solver=None, timeout_ms: int = 72000) -> bool:
    """Full Cloudflare bypass: vision-based detection and clicking.

    Args:
        page: Playwright or CDPPage instance.
        solver: Optional CaptchaSolver for API-based solving.
        timeout_ms: Max milliseconds to wait.

    Returns True if bypass succeeded.
    """
    return await wait_cloudflare(page, timeout_ms=timeout_ms)
