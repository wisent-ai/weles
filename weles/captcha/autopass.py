"""Auto-pass attempts for captchas that can be clicked through.

Try clicking the Turnstile or hCaptcha checkbox before falling back to
expensive API solving.  These work when the browser fingerprint and IP
are trustworthy enough for the provider to auto-grant a token.
"""

from __future__ import annotations

import asyncio

# ── Turnstile constants ───────────────────────────────────────────────

_TS_CHECK_INTERVAL = 2  # seconds between token checks
_TS_MAX_CHECKS = 15  # 30 s total
_TS_TOKEN_MIN_LEN = 200  # real tokens are 200+ chars
_TS_CLICK_X = 25
_TS_CLICK_Y = 25
_TS_CLICK_EVERY = 3  # click the iframe every N iterations

# JS to read the current Turnstile response value
_JS_TS_VALUE = (
    '() => {'
    '  var inp = document.querySelector(\'input[name="cf-turnstile-response"]\');'
    '  return inp ? inp.value : "";'
    '}'
)

# ── hCaptcha constants ────────────────────────────────────────────────

_HC_CHECK_INTERVAL = 2
_HC_MAX_CHECKS = 10  # 20 s total
_HC_CLICK_X = 25
_HC_CLICK_Y = 25
_HC_IFRAME_HOST = "hcaptcha.com"
_HC_MIN_RESPONSE_LEN = 1

# JS to read the current hCaptcha response
_JS_HC_VALUE = (
    '() => {'
    '  var ta = document.querySelector(\'textarea[name="h-captcha-response"]\');'
    '  return ta ? ta.value : "";'
    '}'
)


async def try_turnstile_auto(page) -> bool:
    """Click the Turnstile iframe checkbox repeatedly and check for a
    valid token.  Returns ``True`` if auto-pass succeeded.
    """
    for i in range(_TS_MAX_CHECKS):
        await asyncio.sleep(_TS_CHECK_INTERVAL)

        # Check if a real token appeared
        tok = await page.evaluate(_JS_TS_VALUE)
        if isinstance(tok, str) and len(tok) > _TS_TOKEN_MIN_LEN:
            # Wait a beat for any callbacks to fire
            await asyncio.sleep(_TS_CHECK_INTERVAL)
            return True

        # Periodically click the Turnstile iframe checkbox
        if i % _TS_CLICK_EVERY == 0:
            for frame in page.frames:
                if "challenges.cloudflare.com" not in (frame.url or ""):
                    continue
                try:
                    await frame.locator("body").click(
                        position={"x": _TS_CLICK_X, "y": _TS_CLICK_Y},
                    )
                except Exception:
                    pass
                break

    return False


async def try_hcaptcha_auto(page) -> bool:
    """Click the hCaptcha checkbox and check for an auto-granted token.
    Returns ``True`` if auto-pass succeeded.
    """
    for i in range(_HC_MAX_CHECKS):
        await asyncio.sleep(_HC_CHECK_INTERVAL)

        tok = await page.evaluate(_JS_HC_VALUE)
        if isinstance(tok, str) and len(tok) > _HC_MIN_RESPONSE_LEN:
            await asyncio.sleep(_HC_CHECK_INTERVAL)
            return True

        # Click the hCaptcha iframe checkbox
        if i % _TS_CLICK_EVERY == 0:
            for frame in page.frames:
                if _HC_IFRAME_HOST not in (frame.url or ""):
                    continue
                try:
                    await frame.locator("body").click(
                        position={"x": _HC_CLICK_X, "y": _HC_CLICK_Y},
                    )
                except Exception:
                    pass
                break

    return False
