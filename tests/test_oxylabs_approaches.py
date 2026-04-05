"""Test patched Chromium against Cloudflare on Oxylabs."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from weles import CDPWeles


async def main():
    patched = "/Users/zuzannadykiert/Desktop/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium"

    async with CDPWeles(os="macos", headless=True, chromium_path=patched) as ctx:
        page = await ctx.new_page()

        await page.goto("https://dashboard.oxylabs.io/en/", wait_until="load")

        for _ in range(10):
            loop = asyncio.get_event_loop()
            fut = loop.create_future()
            loop.call_later(2, fut.set_result, None)
            await fut

        body = await page.evaluate("()=>document.body.innerText.substring(0, 500)")
        print(f"URL: {page.url}")
        print(f"Body: {body[:200]}")


if __name__ == "__main__":
    asyncio.run(main())
