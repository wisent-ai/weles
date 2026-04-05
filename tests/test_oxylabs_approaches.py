"""Test Oxylabs dashboard via Browserbase cloud stealth browser."""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from weles import CDPWeles, SessionStore


async def test_browserbase_with_cookies():
    """Use Browserbase backend with stored cookies to access Oxylabs."""
    print("=== BROWSERBASE + COOKIES TEST ===")

    sessions = SessionStore()
    if not sessions.load_cookies("oxylabs"):
        print("No stored cookies. Run test_oxylabs_login.py first.")
        return

    async with CDPWeles(
        backend="browserbase",
        browserbase_api_key="***REMOVED-BROWSERBASE-KEY***",
        browserbase_project_id="360fe763-c175-45df-9e55-cac38400d535",
    ) as ctx:
        page = await ctx.new_page()
        # Test without cookies first to see if CF passes
        print("Testing without cookies first...")

        await page.goto("https://dashboard.oxylabs.io/en/", wait_until="load")

        # Wait for page to settle
        for _ in range(15):
            loop = asyncio.get_event_loop()
            fut = loop.create_future()
            loop.call_later(2, fut.set_result, None)
            await fut

        body = await page.evaluate("()=>document.body.innerText.substring(0,500)")
        url = page.url
        print(f"URL: {url}")
        print(f"Body: {body[:300]}")

        has_dashboard = any(w in body.lower() for w in [
            "overview", "usage", "traffic", "subscription", "balance",
            "residential", "datacenter", "mobile",
        ])
        print(f"\nDashboard loaded: {has_dashboard}")


if __name__ == "__main__":
    asyncio.run(test_browserbase_with_cookies())
