"""Basic tests for weles."""

import asyncio
from weles import AsyncWeles
from weles.session import list_profiles, extract_cookies


def test_chrome_profiles():
    profiles = list_profiles()
    print(f"Chrome profiles found: {len(profiles)}")
    for p in profiles[:5]:
        print(f"  {p['dir']}: {p['name']}")


def test_cookie_extraction():
    cookies = extract_cookies("google.com")
    print(f"Google cookies: {len(cookies)}")
    for c in cookies[:3]:
        print(f"  {c['name']} ({c['domain']}): {c['value'][:20]}...")


async def test_launch_and_spoof():
    async with AsyncWeles(os="macos", headless=True) as ctx:
        page = await ctx.new_page()
        await page.goto("about:blank")

        webdriver = await page.evaluate("() => navigator.webdriver")
        assert webdriver is None or webdriver is False, f"webdriver should be hidden, got {webdriver}"

        ua = await page.evaluate("() => navigator.userAgent")
        assert "Firefox" in ua, f"UA should contain Firefox, got {ua}"

        print("Playwright spoofing tests passed.")


if __name__ == "__main__":
    test_chrome_profiles()
    test_cookie_extraction()
    asyncio.run(test_launch_and_spoof())
