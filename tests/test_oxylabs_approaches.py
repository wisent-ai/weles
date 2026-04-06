"""Test Oxylabs login with vision-based Cloudflare bypass."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from weles import CDPWeles
from weles.capture import Capture
from weles.cloudflare import wait_cloudflare


async def main():
    patched = "/Users/zuzannadykiert/Desktop/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium"

    async with CDPWeles(
        os="macos",
        headless=True,
        chromium_path=patched,
    ) as ctx:
        cap = Capture(ctx)
        page = await cap.new_page()
        await page.goto("https://dashboard.oxylabs.io/en/")

        print("Waiting for Cloudflare...")
        cleared = await wait_cloudflare(page, timeout_ms=30000)
        print(f"Cloudflare cleared: {cleared}")

        await cap.screenshot(page, label="oxylabs_after_cf")
        dom_path = await cap.capture_dom(page, label="oxylabs_after_cf")

        body = await page.evaluate("document.body.innerText.substring(0, 2000)")
        print(f"\nURL: {page.url}")
        print(f"Body: {body[:500]}")


if __name__ == "__main__":
    asyncio.run(main())
