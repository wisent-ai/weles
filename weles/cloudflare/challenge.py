"""Cloudflare challenge detection and bypass.

Strategy:
1. Detect the challenge page by looking for the Turnstile script load.
2. Wait for the Turnstile widget iframe to appear in the DOM.
3. Click the iframe centre using human-like Bezier-curve mouse motion
   (CDPMouse defaults). No vision/AI required for the click target.
4. Poll for the challenge to clear (the "Performing security
   verification" text disappears).

The Turnstile widget always renders inside an iframe whose src starts
with https://challenges.cloudflare.com/turnstile/. Clicking the
centre of that iframe always lands on the checkbox.
"""

import logging

from .config import CF_CHECK_INTERVAL_MS

logger = logging.getLogger(__name__)

_TURNSTILE_IFRAME_SEL = 'iframe[src*="challenges.cloudflare.com"]'
_CF_VERIFICATION_TEXT = "performing security verification"


async def _is_cf_challenge(page) -> bool:
    """Check if the page text mentions Cloudflare verification."""
    try:
        body = await page.inner_text("body")
        return _CF_VERIFICATION_TEXT in body.lower()
    except Exception:
        return False


async def wait_cloudflare(page, timeout_ms: int = 72000,
                          settle_ms: int = 3000) -> bool:
    """Wait for Cloudflare challenge to resolve, clicking the Turnstile
    iframe via human mouse motion if a checkbox appears.

    Returns True if no challenge or challenge clears within timeout.
    """
    await page.wait_for_timeout(settle_ms)

    if not await _is_cf_challenge(page):
        print("  [cloudflare] no challenge detected")
        return True

    print("  [cloudflare] challenge detected, waiting for Turnstile iframe")

    # Wait for the Turnstile widget iframe to render
    try:
        await page.wait_for_selector(
            _TURNSTILE_IFRAME_SEL, timeout=timeout_ms,
        )
    except Exception:
        print("  [cloudflare] no Turnstile iframe appeared (auto-pass mode)")
        # Non-interactive interstitial - just wait for it to clear
        return await _poll_until_clear(page, timeout_ms)

    # Get the iframe bounding box and click its centre
    iframe = await page.query_selector(_TURNSTILE_IFRAME_SEL)
    if iframe:
        box = await iframe.bounding_box()
        if box:
            # Click slightly left of centre where the checkbox sits
            cx = box["x"] + 30
            cy = box["y"] + box["height"] / 2
            print(f"  [cloudflare] clicking Turnstile iframe at ({cx}, {cy})")
            await page.mouse.click(cx, cy)
        else:
            print("  [cloudflare] iframe has no bounding box")
    else:
        print("  [cloudflare] iframe disappeared before click")

    return await _poll_until_clear(page, timeout_ms)


async def _poll_until_clear(page, timeout_ms: int) -> bool:
    """Poll until the Cloudflare verification text disappears."""
    checks = max(1, timeout_ms // CF_CHECK_INTERVAL_MS)
    for i in range(checks):
        await page.wait_for_timeout(CF_CHECK_INTERVAL_MS)
        still_cf = await _is_cf_challenge(page)
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
