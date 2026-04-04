"""Token injection for solved captchas.

After a captcha is solved via an API, the token must be planted into the
page DOM (hidden inputs, textareas, callback functions) so the site
accepts it on form submission.  This module provides the JS snippets and
Playwright helpers for each captcha type plus route interception for POST
forms.
"""

from __future__ import annotations

import json

# ── Turnstile injection ───────────────────────────────────────────────

JS_INJECT_TURNSTILE = """(t) => {
    // Hidden input
    var inp = document.querySelector('input[name="cf-turnstile-response"]');
    if (inp) inp.value = t;

    // Any hidden inputs with "turnstile" in the name
    var hidden = document.querySelectorAll('input[type="hidden"]');
    for (var h of hidden) {
        if (h.name && h.name.includes('turnstile')) h.value = t;
    }

    // data-callback attribute
    var cb = document.querySelector('[data-callback]');
    if (cb) {
        var fn = cb.getAttribute('data-callback');
        if (window[fn]) window[fn](t);
    }

    // Global callbacks
    if (window.turnstileCallback) window.turnstileCallback(t);
    if (window.turnstile) window.turnstile.getResponse = function() { return t; };

    // Re-enable disabled submit buttons
    var forms = document.querySelectorAll('form');
    for (var f of forms) {
        var bs = f.querySelectorAll('button[disabled]');
        for (var b of bs) b.removeAttribute('disabled');
    }

    // Monkey-patch fetch to inject token into JSON bodies
    var _f = window.fetch;
    window.fetch = function(u, o) {
        if (o && o.body) {
            try {
                var d = JSON.parse(o.body);
                if (typeof d === 'object') {
                    d['cf-turnstile-response'] = t;
                    o.body = JSON.stringify(d);
                }
            } catch(e) {}
        }
        return _f.call(this, u, o);
    };
}"""

# ── reCAPTCHA injection ───────────────────────────────────────────────

JS_INJECT_RECAPTCHA = """(t) => {
    // Standard textarea
    var e = document.getElementById('g-recaptcha-response');
    if (e) { e.innerHTML = t; e.value = t; }

    // All g-recaptcha-response textareas (multiple widgets)
    var tas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
    for (var ta of tas) { ta.innerHTML = t; ta.value = t; }

    // wcaptcha_response (some sites)
    var wc = document.querySelector('[name="wcaptcha_response"]');
    if (wc) wc.value = t;

    // Hidden inputs with captcha/response in name
    var hi = document.querySelectorAll('input[type="hidden"]');
    for (var h of hi) {
        if (h.name && (h.name.includes('captcha') || h.name.includes('response')))
            h.value = t;
    }

    // data-callback
    try {
        var cb = document.querySelector('[data-callback]');
        if (cb) {
            var fn = cb.getAttribute('data-callback');
            if (window[fn]) window[fn](t);
        }
    } catch(x) {}

    // grecaptcha.enterprise.getResponse override
    if (window.grecaptcha && window.grecaptcha.enterprise) {
        try { window.grecaptcha.enterprise.getResponse = function() { return t; }; }
        catch(x) {}
    }
    // grecaptcha.getResponse override
    if (window.grecaptcha) {
        try { window.grecaptcha.getResponse = function() { return t; }; }
        catch(x) {}
    }
}"""

# ── hCaptcha injection ────────────────────────────────────────────────

JS_INJECT_HCAPTCHA = """(t) => {
    // h-captcha-response textareas
    var tas = document.querySelectorAll('textarea[name="h-captcha-response"]');
    for (var ta of tas) { ta.innerHTML = t; ta.value = t; }

    // Also fill g-recaptcha-response (hCaptcha sets both)
    var tas2 = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
    for (var ta of tas2) { ta.innerHTML = t; ta.value = t; }
}"""


# ── Playwright helpers ────────────────────────────────────────────────

async def inject_turnstile(page, token: str) -> None:
    """Inject a solved Turnstile token into the page."""
    await page.evaluate(JS_INJECT_TURNSTILE, token)


async def inject_recaptcha(page, token: str) -> None:
    """Inject a solved reCAPTCHA token into the page."""
    await page.evaluate(JS_INJECT_RECAPTCHA, token)


async def inject_hcaptcha(page, token: str) -> None:
    """Inject a solved hCaptcha token into the page."""
    await page.evaluate(JS_INJECT_HCAPTCHA, token)


INJECTORS = {
    "turnstile": inject_turnstile,
    "recaptcha": inject_recaptcha,
    "hcaptcha": inject_hcaptcha,
}


async def inject_token(page, captcha_type: str, token: str) -> None:
    """Inject *token* for the given *captcha_type* (turnstile/recaptcha/hcaptcha)."""
    fn = INJECTORS.get(captcha_type)
    if fn is None:
        raise ValueError(f"Unknown captcha type for injection: {captcha_type}")
    await fn(page, token)


# ── Route interception ────────────────────────────────────────────────

async def setup_route_intercept(page, token: str, *, field: str = "cf-turnstile-response") -> None:
    """Intercept all POST requests from *page* and inject *token* into the
    request body.

    For JSON bodies the *field* key is added/overwritten.  For form-encoded
    bodies the field is appended if not already present.
    """

    async def _handler(route):
        req = route.request
        if req.method != "POST" or not token:
            await route.continue_()
            return

        try:
            body = req.post_data or ""
        except Exception:
            await route.continue_()
            return

        ct = req.headers.get("content-type", "")

        if "application/json" in ct:
            try:
                data = json.loads(body)
                data[field] = token
                await route.continue_(post_data=json.dumps(data))
                return
            except Exception:
                pass
        elif field not in body:
            sep = "&" if body else ""
            await route.continue_(post_data=f"{body}{sep}{field}={token}")
            return

        await route.continue_()

    await page.route("**/*", _handler)
