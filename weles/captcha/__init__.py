"""Captcha solving module for Weles.

Detects Turnstile, reCAPTCHA v2/v3, hCaptcha, and FunCaptcha on Playwright
pages.  Supports 7 solving services with automatic rotation and blacklisting:
2Captcha, AntiCaptcha, Capsolver, CapMonster Cloud, NextCaptcha, NopeCHA,
NoCaptchaAI.

Quick start::

    from weles.captcha import solve_page_captcha

    # all-in-one: detect -> auto-pass -> API solve -> inject
    solved = await solve_page_captcha(page)

    # or use the solver directly
    from weles.captcha import CaptchaSolver, detect_captcha

    solver = CaptchaSolver()
    ctype, sitekey = await detect_captcha(page)
    token = await solver.solve_turnstile(sitekey, page.url)

API keys are read from environment variables automatically:
- CAPMONSTERCLOUD_API_KEY
- ANTICAPTCHA_API_KEY
- NEXTCAPTCHA_API_KEY
- CAPSOLVER_API_KEY
- NOPECHA_API_KEY
- TWOCAPTCHA_API_KEY
- NOCAPTCHAAI_API_KEY
"""

from .solver import CaptchaSolver, solve_page_captcha
from .detect import detect_captcha

__all__ = ["CaptchaSolver", "detect_captcha", "solve_page_captcha"]
