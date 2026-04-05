"""End-to-end test: Oxylabs login with CDPWeles + full capture + traffic diff.

Runs the complete pipeline:
1. Launch CDPWeles with video recording and traffic capture
2. Navigate to Oxylabs, fill login form, submit
3. Wait for Cloudflare challenge
4. On failure: diagnose video + open real browser for traffic comparison
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from weles import CDPWeles, Capture, wait_cloudflare, SessionStore
from weles.cloudflare.challenge import _has_cf_frame


async def oxylabs_login():
    """Attempt Oxylabs login via stored cookies or human SSO, then diagnose."""
    output_dir = os.path.join(os.path.dirname(__file__), "..", "recordings")
    os.makedirs(output_dir, exist_ok=True)

    sessions = SessionStore()

    # Acquire cookies first if we don't have them (opens real browser)
    if not sessions.load_cookies("oxylabs"):
        print("No stored session. Opening browser for login...")
        acquired = await sessions.acquire(
            "oxylabs",
            url="https://dashboard.oxylabs.io/",
            task_description="Login to Oxylabs dashboard using Google SSO",
        )
        print(f"Cookies acquired: {acquired}")
        if not acquired:
            print("No cookies captured. Exiting.")
            return

    # Now run the automated session with stored cookies
    async with CDPWeles(
        os="macos",
        headless=True,
    ) as ctx:
        cap = Capture(ctx)
        page = await cap.new_page()

        # Inject stored cookies
        has_session = await sessions.inject(ctx, "oxylabs")
        print(f"Session injected: {has_session}")

        await page.goto("https://dashboard.oxylabs.io/en/", wait_until="load")
        await page.wait_for_timeout(5000)
        url = page.url
        print(f"Page loaded: {url}")

        body = await page.evaluate("()=>document.body.innerText.substring(0,300)")
        print(f"Body: {body[:200]}")

        # Check cookies the browser actually has
        cookies = await ctx.cookies()
        cookie_names = [c["name"] for c in cookies]
        print(f"Browser cookies: {len(cookies)}")
        has_jwt = "JWT" in cookie_names
        print(f"JWT cookie present: {has_jwt}")


if __name__ == "__main__":
    asyncio.run(oxylabs_login())
