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
from weles.traffic.capture import TrafficCapture


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
    auto_tc = TrafficCapture()
    auto_tc.start(port=8090)

    async with CDPWeles(
        os="macos",
        record_video={"dir": output_dir},
        proxy={"server": auto_tc.proxy_url},
    ) as ctx:
        cap = Capture(ctx)
        page = await cap.new_page()

        # Inject stored cookies
        has_session = await sessions.inject(ctx, "oxylabs")
        print(f"Session injected: {has_session}")

        await page.goto("https://dashboard.oxylabs.io/", wait_until="load")
        await page.wait_for_timeout(5000)
        print(f"Page loaded: {page.url}")

        # Handle CF challenge if present
        if _has_cf_frame(page):
            await wait_cloudflare(page, timeout_ms=30000, settle_ms=10000)

        # Check if we reached the dashboard
        body = await page.evaluate("()=>document.body.innerText.substring(0,200)")
        success = any(w in body.lower() for w in ["overview", "usage", "traffic", "subscription"])
        print(f"Dashboard loaded: {success}")
        print(f"Body: {body[:150]}")

        auto_tc.stop()
        auto_tc.save(
            os.path.join(output_dir, "traffic_diff", "auto_capture.json")
        )

        result = await cap.finish(
            "oxylabs_cdp",
            success=success,
            url="https://dashboard.oxylabs.io/",
            task_description="Login to Oxylabs dashboard using Google SSO and navigate to the balance/usage page",
        )

        if result.get("diagnosis"):
            print("\n=== DIAGNOSIS ===")
            print(result["diagnosis"])

        if result.get("traffic_diff"):
            diff = result["traffic_diff"].get("diff", {})
            summary = diff.get("summary", {})
            print(f"\n=== TRAFFIC DIFF ===")
            print(f"Verdict: {summary.get('verdict', '?')}")
            print(f"Issues: {summary.get('issue_count', '?')}")
            for section in ["tls", "http2", "headers", "cookies"]:
                data = diff.get(section, {})
                if data:
                    print(f"\n[{section}]")
                    for k, v in data.items():
                        if v and v is not True:
                            print(f"  {k}: {v}")


if __name__ == "__main__":
    asyncio.run(oxylabs_login())
