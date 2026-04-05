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

from weles import CDPWeles, SessionStore
from weles.traffic.capture import TrafficCapture
from weles.traffic.compare import compare_captures


async def oxylabs_login():
    """Attempt Oxylabs login, then compare traffic if blocked."""
    output_dir = os.path.join(os.path.dirname(__file__), "..", "recordings", "traffic_diff")
    os.makedirs(output_dir, exist_ok=True)

    sessions = SessionStore()

    if not sessions.load_cookies("oxylabs"):
        print("No stored session. Opening browser for login...")
        acquired = await sessions.acquire(
            "oxylabs",
            url="https://dashboard.oxylabs.io/",
            task_description="Login to Oxylabs dashboard using Google SSO",
        )
        if not acquired:
            print("No cookies captured. Exiting.")
            return

    # Step 1: Automated run through mitmproxy
    auto_tc = TrafficCapture()
    auto_tc.start(port=9091)
    print("Automated traffic capture started")

    async with CDPWeles(
        os="macos",
        headless=True,
        proxy={"server": auto_tc.proxy_url},
    ) as ctx:
        page = await ctx.new_page()
        await sessions.inject(ctx, "oxylabs")
        print("Cookies injected")

        await page.goto("https://dashboard.oxylabs.io/en/", wait_until="load")
        await page.wait_for_timeout(5000)
        body = await page.evaluate("()=>document.body.innerText.substring(0,200)")
        print(f"Automated result: {body[:150]}")

    auto_tc.stop()
    auto_path = os.path.join(output_dir, "auto_capture.json")
    auto_tc.save(auto_path)
    print(f"Automated capture saved: {auto_path}")

    success = "overview" in body.lower() or "usage" in body.lower()
    if success:
        print("Dashboard loaded successfully!")
        return

    # Step 2: Real browser run through mitmproxy
    print("\nNow opening real browser for comparison...")
    from weles.testing.fingerprint_diff import on_failure
    diff_result = on_failure(
        auto_capture_path=auto_path,
        url="https://dashboard.oxylabs.io/en/",
        task_description="Navigate to dashboard.oxylabs.io/en/ while logged in",
        port=9092,
    )
    if diff_result:
        diff = diff_result.get("diff", {})
        summary = diff.get("summary", {})
        print(f"\nVerdict: {summary.get('verdict')}")
        print(f"Issues: {summary.get('issue_count')}")
        for section in ["tls", "http2", "headers"]:
            data = diff.get(section, {})
            if data:
                print(f"\n[{section}]")
                for k, v in data.items():
                    if v and v is not True:
                        print(f"  {k}: {v}")


if __name__ == "__main__":
    asyncio.run(oxylabs_login())
