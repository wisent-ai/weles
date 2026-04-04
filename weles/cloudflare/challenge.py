"""Cloudflare challenge waiting and bypass."""

import asyncio
from typing import Optional

CF_KEYWORDS = [
    "just a moment", "verify you are human", "verifying you are human",
    "performing security", "verification successful",
]
CF_IFRAME_HOST = "challenges.cloudflare.com"
CF_MAX_CHECKS = 24
CF_CHECK_INTERVAL = 3
CF_CLICK_XY = 25


async def wait_cloudflare(page, max_checks: int = CF_MAX_CHECKS,
                          interval: float = CF_CHECK_INTERVAL) -> bool:
    """Wait for Cloudflare challenge to resolve, clicking Turnstile if present.

    Polls the page body for CF challenge keywords. When a Turnstile iframe
    is found, clicks at the checkbox position. Returns True if the challenge
    clears within the timeout (max_checks * interval seconds).
    """
    for i in range(max_checks):
        body = ""
        try:
            body = (await page.text_content("body") or "").lower()
        except Exception:
            pass
        if not any(kw in body for kw in CF_KEYWORDS):
            return True
        for frame in page.frames:
            if CF_IFRAME_HOST in (frame.url or ""):
                try:
                    await frame.locator("body").click(
                        position={"x": CF_CLICK_XY, "y": CF_CLICK_XY})
                except Exception:
                    pass
                break
        await asyncio.sleep(interval)
    return False


def is_cloudflare_challenge(body_text: str) -> bool:
    """Check if page body text contains Cloudflare challenge indicators."""
    lower = body_text.lower()
    return any(kw in lower for kw in CF_KEYWORDS)


async def bypass_cloudflare(page, solver=None, timeout: int = 72) -> bool:
    """Full Cloudflare bypass: wait for challenge, then solve if needed.

    Args:
        page: Playwright page
        solver: Optional CaptchaSolver instance for API-based solving
        timeout: Max seconds to wait for challenge resolution

    Returns True if bypass succeeded.
    """
    max_checks = timeout // CF_CHECK_INTERVAL

    # First try: wait and click
    if await wait_cloudflare(page, max_checks=max_checks):
        return True

    # If solver provided, try API-based captcha solving
    if solver:
        try:
            from ..captcha.detect import detect_captcha
            from ..captcha.inject import inject_turnstile
            from ..captcha.autopass import try_turnstile_auto

            # Try auto-pass one more time
            if await try_turnstile_auto(page):
                return True

            # Detect and solve via API
            ctype, sitekey = await detect_captcha(page)
            if ctype == "turnstile" and sitekey:
                token = await solver.solve_turnstile(sitekey, page.url)
                if token:
                    await inject_turnstile(page, token)
                    await asyncio.sleep(CF_CHECK_INTERVAL)
                    body = (await page.text_content("body") or "").lower()
                    return not any(kw in body for kw in CF_KEYWORDS)
        except Exception:
            pass

    return False
