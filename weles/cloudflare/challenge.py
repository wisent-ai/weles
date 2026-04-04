"""Cloudflare challenge detection and bypass using structural checks.

Detection is based on frame presence and cookies, not page text.
"""

from .config import CF_IFRAME_HOST, CF_CLEARANCE_COOKIE, CF_CHECK_INTERVAL_MS, CF_CLICK_XY


def _has_cf_frame(page) -> bool:
    """Check if a Cloudflare challenge iframe is present."""
    return any(CF_IFRAME_HOST in (f.url or "") for f in page.frames)


def _get_cf_frame(page):
    """Return the Cloudflare challenge frame, or None."""
    for f in page.frames:
        if CF_IFRAME_HOST in (f.url or ""):
            return f
    return None


async def _has_clearance(context) -> bool:
    """Check if cf_clearance cookie exists."""
    cookies = await context.cookies()
    return any(c["name"] == CF_CLEARANCE_COOKIE for c in cookies)


async def _click_turnstile(page):
    """Click the Turnstile checkbox if the frame is present."""
    cf_frame = _get_cf_frame(page)
    if cf_frame:
        try:
            await cf_frame.locator("body").click(
                position={"x": CF_CLICK_XY, "y": CF_CLICK_XY})
        except Exception:
            pass


async def wait_cloudflare(page, timeout_ms: int = 72000,
                          settle_ms: int = 5000) -> bool:
    """Wait for Cloudflare challenge to resolve, clicking Turnstile if present.

    Uses structural detection:
    - Challenge present = challenges.cloudflare.com frame exists
    - Challenge resolved = that frame disappears OR cf_clearance cookie set

    First waits settle_ms for a CF frame to appear (the challenge page
    may not have loaded its iframe yet). Then clicks and polls until
    the frame disappears or timeout.

    Returns True if no challenge appears or challenge clears within timeout.
    """
    # Wait for CF frame to appear (or confirm it won't)
    settle_checks = settle_ms // CF_CHECK_INTERVAL_MS
    for _ in range(max(settle_checks, 2)):
        if _has_cf_frame(page):
            break
        await page.wait_for_timeout(CF_CHECK_INTERVAL_MS)
    else:
        return True  # No CF frame appeared — not challenged

    # CF frame is present — click and wait for it to resolve
    checks = timeout_ms // CF_CHECK_INTERVAL_MS
    for i in range(checks):
        await _click_turnstile(page)
        await page.wait_for_timeout(CF_CHECK_INTERVAL_MS)

        if not _has_cf_frame(page):
            return True

        try:
            if await _has_clearance(page.context):
                return True
        except Exception:
            pass

    return False


async def is_challenged(page) -> bool:
    """Check if the page is currently showing a Cloudflare challenge."""
    return _has_cf_frame(page)


async def bypass_cloudflare(page, solver=None, timeout_ms: int = 72000) -> bool:
    """Full Cloudflare bypass: wait + click, then API solve if needed.

    Args:
        page: Playwright page
        solver: Optional CaptchaSolver instance for API-based solving
        timeout_ms: Max milliseconds to wait

    Returns True if bypass succeeded.
    """
    if await wait_cloudflare(page, timeout_ms=timeout_ms):
        return True

    if solver:
        try:
            from ..captcha.detect import detect_captcha
            from ..captcha.inject import inject_turnstile
            from ..captcha.autopass import try_turnstile_auto

            if await try_turnstile_auto(page):
                return True

            ctype, sitekey = await detect_captcha(page)
            if ctype == "turnstile" and sitekey:
                token = await solver.solve_turnstile(sitekey, page.url)
                if token:
                    await inject_turnstile(page, token)
                    await page.wait_for_timeout(CF_CHECK_INTERVAL_MS)
                    return not _has_cf_frame(page)
        except Exception:
            pass

    return False
