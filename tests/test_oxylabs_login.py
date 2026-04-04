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

from weles import CDPWeles, Capture, wait_cloudflare
from weles.cloudflare.challenge import _has_cf_frame
from weles.traffic.capture import TrafficCapture


async def oxylabs_login():
    """Attempt Oxylabs login and run full diagnostics on failure."""
    output_dir = os.path.join(os.path.dirname(__file__), "..", "recordings")
    os.makedirs(output_dir, exist_ok=True)

    auto_tc = TrafficCapture()
    auto_tc.start(port=8090)

    async with CDPWeles(
        os="macos",
        record_video={"dir": output_dir},
        proxy={"server": auto_tc.proxy_url},
    ) as ctx:
        cap = Capture(ctx)
        page = await cap.new_page()

        await page.goto("https://dashboard.oxylabs.io/", wait_until="load")
        await page.wait_for_selector('input[name="username"]')
        print("Login page loaded")

        await page.evaluate(
            '()=>{document.querySelector("input[name=username]").focus()}'
        )
        await page.keyboard.type("lukasz.bartoszcze@gmail.com", delay=50)
        await page.evaluate(
            '()=>{document.querySelector("input[type=password]").focus()}'
        )
        await page.keyboard.type("Warszawa432!", delay=50)
        await page.evaluate(
            '()=>{'
            'const b=[...document.querySelectorAll("button")]'
            '.find(b=>b.textContent.includes("Log"));'
            'if(b)b.click()}'
        )
        print("Credentials submitted")

        await wait_cloudflare(page, timeout_ms=30000, settle_ms=10000)

        success = not _has_cf_frame(page)
        body = await page.evaluate(
            "()=>document.body.innerText.substring(0,100)"
        )
        if "security" in body.lower() or "verify" in body.lower():
            success = False

        print(f"Login success: {success}")

        auto_tc.stop()
        auto_tc.save(
            os.path.join(output_dir, "traffic_diff", "auto_capture.json")
        )

        result = await cap.finish(
            "oxylabs_cdp",
            success=success,
            url="https://dashboard.oxylabs.io/",
            task_description="Login to Oxylabs dashboard with email lukasz.bartoszcze@gmail.com and check the balance page",
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
