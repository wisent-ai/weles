"""Generic vision-driven login flow.

Works on any login form on any site. Uses Claude vision to identify
the username field, password field, and submit button. No selectors,
no per-site code.

Usage:
    from weles.agent import login

    success = await login.run(page,
                              username="user@example.com",
                              password="hunter2")
"""
from typing import Any

from . import vision
from ..cloudflare import wait_cloudflare


async def run(page: Any, username: str, password: str,
              post_login_timeout_ms: int = 30000) -> bool:
    """Fill and submit a login form via vision.

    Steps:
      1. Wait for any Cloudflare challenge to clear.
      2. Find the username/email field via vision and type the username.
      3. Find the password field via vision and type the password.
      4. Find the submit button via vision and click it.
      5. Wait for navigation away from the login page (or timeout).
      6. Wait for any post-submit Cloudflare challenge.

    Returns True if the page navigated away from the login URL after
    submit, False otherwise.
    """
    await wait_cloudflare(page)

    pre_login_url = _get_url(page)

    if not await vision.fill(
        page,
        "the username or email input field of the login form",
        username,
    ):
        print("[login] could not find username field")
        return False

    if not await vision.fill(
        page,
        "the password input field of the login form",
        password,
    ):
        print("[login] could not find password field")
        return False

    if not await vision.click(
        page,
        "the submit button of the login form (Log In, Sign In, "
        "Continue, Submit, etc.)",
    ):
        print("[login] could not find submit button")
        return False

    print("[login] submitted form, waiting for navigation")

    try:
        await page.wait_for_function(
            f"() => window.location.href !== {pre_login_url!r}",
            timeout=post_login_timeout_ms,
        )
    except Exception:
        print("[login] navigation timeout after submit")
        return False

    await wait_cloudflare(page)

    new_url = _get_url(page)
    success = "login" not in new_url.lower() and "signin" not in new_url.lower()
    print(f"[login] post-submit url={new_url} success={success}")
    return success


def _get_url(page: Any) -> str:
    """Page URL accessor that works for both Playwright and CDPPage."""
    url_attr = getattr(page, "url", "")
    if callable(url_attr):
        try:
            return url_attr()
        except Exception:
            return ""
    return url_attr or ""
