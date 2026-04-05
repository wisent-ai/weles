"""Test Oxylabs login with CDPWeles using stored cookies."""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from weles import CDPWeles, SessionStore


async def oxylabs_login():
    """Login to Oxylabs with stored cookies, check if dashboard loads."""
    sessions = SessionStore()

    if not sessions.load_cookies("oxylabs"):
        print("No stored session. Opening browser for login...")
        acquired = await sessions.acquire(
            "oxylabs",
            url="https://dashboard.oxylabs.io/",
            task_description="Login to Oxylabs dashboard using Google SSO",
        )
        if not acquired:
            print("No cookies captured.")
            return

    async with CDPWeles(os="macos", headless=False) as ctx:
        page = await ctx.new_page()
        await sessions.inject(ctx, "oxylabs")
        print("Cookies injected")

        await page.goto("https://dashboard.oxylabs.io/en/", wait_until="load")
        await page.wait_for_timeout(5000)

        body = await page.evaluate("()=>document.body.innerText.substring(0,300)")
        url = page.url
        print(f"URL: {url}")
        print(f"Body: {body[:200]}")

        success = "overview" in body.lower() or "usage" in body.lower()
        print(f"\nDashboard loaded: {success}")


if __name__ == "__main__":
    asyncio.run(oxylabs_login())
