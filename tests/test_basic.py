"""Basic tests for weles."""

import asyncio
from weles import AsyncWeles


async def test_launch_and_spoof():
    async with AsyncWeles(os="macos", headless=True) as ctx:
        page = await ctx.new_page()
        await page.goto("about:blank")

        webdriver = await page.evaluate("() => navigator.webdriver")
        assert webdriver is None or webdriver is False, f"webdriver should be hidden, got {webdriver}"

        ua = await page.evaluate("() => navigator.userAgent")
        assert "Firefox" in ua, f"UA should contain Firefox, got {ua}"

        platform = await page.evaluate("() => navigator.platform")
        assert platform == "MacIntel", f"platform should be MacIntel, got {platform}"

        oscpu = await page.evaluate("() => navigator.oscpu")
        assert "Mac" in oscpu, f"oscpu should contain Mac, got {oscpu}"

        print("All basic tests passed.")


if __name__ == "__main__":
    asyncio.run(test_launch_and_spoof())
