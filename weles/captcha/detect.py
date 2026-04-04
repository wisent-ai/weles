"""Captcha detection for Playwright pages.

Detects Cloudflare Turnstile, reCAPTCHA v2/v3, and hCaptcha by inspecting
iframe URLs, DOM ``data-sitekey`` attributes, and raw HTML patterns.
"""

from __future__ import annotations

import asyncio
import re
from typing import Optional, Tuple

# ── JavaScript detection snippets ─────────────────────────────────────

_JS_DETECT_TURNSTILE = """() => {
    var els = document.querySelectorAll('[data-sitekey]');
    for (var e of els) {
        var sk = e.getAttribute('data-sitekey');
        if (sk && sk.startsWith('0x')) return sk;
    }
    return null;
}"""

_JS_DETECT_RECAPTCHA = """() => {
    var els = document.querySelectorAll('[data-sitekey]');
    for (var e of els) {
        var sk = e.getAttribute('data-sitekey');
        if (sk && sk.startsWith('6L')) return sk;
    }
    var rc = document.querySelector('.g-recaptcha[data-sitekey]');
    if (rc) return rc.getAttribute('data-sitekey');
    return null;
}"""

_JS_DETECT_HCAPTCHA = """() => {
    var el = document.querySelector('.h-captcha[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    return null;
}"""

# Turnstile sitekeys in raw HTML (last-resort regex scan)
_HTML_TURNSTILE_PATTERNS = [
    r'data-sitekey=["\']( 0x[A-Za-z0-9_-]+)',
    r'sitekey[\'"\s:=]+[\'"]( 0x[A-Za-z0-9_-]+)',
]

# How many times to retry detection (captcha widgets load async)
_DETECT_RETRIES = 8
_DETECT_INTERVAL = 2  # seconds between retries

# Types returned
TYPE_TURNSTILE = "turnstile"
TYPE_RECAPTCHA = "recaptcha"
TYPE_HCAPTCHA = "hcaptcha"


async def detect_captcha(
    page,
    *,
    retries: int = _DETECT_RETRIES,
    interval: float = _DETECT_INTERVAL,
) -> Tuple[Optional[str], Optional[str]]:
    """Detect which captcha is on *page* and return ``(type, sitekey)``.

    Checks in priority order:
    1. Iframe URLs (most reliable -- catches Turnstile, reCAPTCHA, hCaptcha)
    2. DOM ``data-sitekey`` attributes via JS evaluation
    3. Raw HTML regex scan for Turnstile

    Returns ``(None, None)`` if nothing is found after all retries.
    """
    for attempt in range(retries):
        # ── 1. Iframe inspection ──────────────────────────────────────
        for frame in page.frames:
            furl = frame.url or ""

            # Cloudflare Turnstile
            if "challenges.cloudflare.com" in furl:
                m = re.search(r"/(0x[^/]+)/", furl)
                if m:
                    return TYPE_TURNSTILE, m.group(1)

            # Google reCAPTCHA
            if "google.com/recaptcha" in furl:
                m = re.search(r"[?&]k=([^&]+)", furl)
                if m:
                    return TYPE_RECAPTCHA, m.group(1)

            # hCaptcha
            if "hcaptcha.com" in furl:
                m = re.search(r"[?&]sitekey=([^&]+)", furl)
                if m:
                    return TYPE_HCAPTCHA, m.group(1)

        # ── 2. DOM data-sitekey attributes ────────────────────────────
        sk = await page.evaluate(_JS_DETECT_TURNSTILE)
        if sk:
            return TYPE_TURNSTILE, sk

        sk = await page.evaluate(_JS_DETECT_RECAPTCHA)
        if sk:
            return TYPE_RECAPTCHA, sk

        sk = await page.evaluate(_JS_DETECT_HCAPTCHA)
        if sk:
            return TYPE_HCAPTCHA, sk

        # ── 3. Raw HTML regex scan (Turnstile) ───────────────────────
        html = await page.content()
        for pattern in _HTML_TURNSTILE_PATTERNS:
            m = re.search(pattern, html)
            if m:
                return TYPE_TURNSTILE, m.group(1)

        # Wait before next attempt (widget may still be loading)
        if attempt < retries - 1:
            await asyncio.sleep(interval)

    return None, None
