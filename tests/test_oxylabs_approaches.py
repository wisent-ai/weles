"""Test Oxylabs balance check using weles session acquire + CDPWeles."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from weles import CDPWeles, SessionStore


async def main():
    sessions = SessionStore()

    if not sessions.load_cookies("oxylabs"):
        print("No cookies. Opening browser for login...")
        acquired = await sessions.acquire(
            "oxylabs",
            url="https://dashboard.oxylabs.io/",
            task_description="Login to Oxylabs using Google SSO",
        )
        if not acquired:
            print("No cookies captured.")
            return

    cookies = sessions.load_cookies("oxylabs")
    print(f"Using {len(cookies)} stored cookies")

    patched = "/Users/zuzannadykiert/Desktop/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium"

    # Run patched Chromium headed (not headless) to eliminate headless signals
    async with CDPWeles(os="macos", headless=False, chromium_path=patched) as ctx:
        page = await ctx.new_page()

        await page.goto("https://dashboard.oxylabs.io/en/", wait_until="load")

        for _ in range(10):
            loop = asyncio.get_event_loop()
            fut = loop.create_future()
            loop.call_later(2, fut.set_result, None)
            await fut

        body = await page.evaluate("()=>document.body.innerText.substring(0, 500)")
        print(f"URL: {page.url}")
        print(f"Body: {body[:300]}")


if __name__ == "__main__":
    asyncio.run(main())
