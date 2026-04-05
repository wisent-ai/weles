"""Test Oxylabs via Browserbase stealth browser with Playwright CDP."""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from browserbase import Browserbase
from playwright.async_api import async_playwright


async def test_browserbase_playwright():
    """Connect Playwright to Browserbase and navigate to Oxylabs."""
    print("=== BROWSERBASE + PLAYWRIGHT TEST ===")

    bb = Browserbase(api_key="***REMOVED-BROWSERBASE-KEY***")
    session = bb.sessions.create(
        project_id="360fe763-c175-45df-9e55-cac38400d535",
    )
    print(f"Session: {session.id}")

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(session.connect_url)
        context = browser.contexts[0]
        page = context.pages[0]

        await page.goto("https://dashboard.oxylabs.io/en/")
        await page.wait_for_load_state("networkidle")
        print(f"URL: {page.url}")

        body = await page.inner_text("body")
        print(f"Body: {body[:300]}")


if __name__ == "__main__":
    asyncio.run(test_browserbase_playwright())
