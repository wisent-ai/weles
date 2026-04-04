"""Compare real browser vs CDPWeles traffic fingerprints.

Runs a single command that:
1. Starts mitmproxy
2. Opens a real browser — waits for you to do the task manually
3. Saves that capture
4. Runs CDPWeles doing the same task through the proxy
5. Saves that capture
6. Compares and reports what's different

Usage:
    from weles.testing import fingerprint_diff

    diff = await fingerprint_diff(
        task_fn=my_login_function,
        url="https://dashboard.oxylabs.io/",
    )
    print(diff)
"""

import asyncio
import json
import os
import subprocess
import sys
from typing import Any, Callable, Dict, Optional

from ..traffic.capture import TrafficCapture
from ..traffic.compare import compare_captures


async def fingerprint_diff(
    task_fn: Callable,
    url: str,
    *,
    os_name: str = "macos",
    real_browser: str = "Google Chrome",
    output_dir: str = "recordings/traffic_diff",
    port_real: int = 8080,
    port_auto: int = 8090,
) -> Dict[str, Any]:
    """Compare real browser vs CDPWeles traffic for the same site.

    Args:
        task_fn: Async function(page) that performs the task on CDPWeles.
            Receives a CDPPage, should do the same actions you did manually.
        url: The URL to navigate to. Shown to the user for the manual step.
        os_name: OS for CDPWeles fingerprint generation.
        real_browser: App name to open for the real browser step.
        output_dir: Where to save captures and the diff report.
        port_real: Proxy port for the real browser capture.
        port_auto: Proxy port for the automated capture.

    Returns:
        Dict with keys: real_capture, auto_capture, diff, report
    """
    os.makedirs(output_dir, exist_ok=True)
    real_path = os.path.join(output_dir, "real_capture.json")
    auto_path = os.path.join(output_dir, "auto_capture.json")
    diff_path = os.path.join(output_dir, "diff_report.json")

    # --- Step 1: Capture real browser traffic ---
    print("=" * 60)
    print("STEP 1: Real browser capture")
    print("=" * 60)
    real_tc = TrafficCapture()
    real_tc.start(port=port_real)

    print(f"\nProxy running on {real_tc.proxy_url}")
    print(f"Opening {real_browser}...")

    _open_browser(real_browser, real_tc.proxy_url)

    print(f"\nGo to: {url}")
    print("Do the task manually (login, navigate, etc).")
    print("Press Enter here when done...")
    await _async_input()

    real_tc.stop()
    real_tc.save(real_path)
    print(f"Real capture saved: {real_path}")

    # --- Step 2: Capture CDPWeles traffic ---
    print()
    print("=" * 60)
    print("STEP 2: CDPWeles automated capture")
    print("=" * 60)
    auto_tc = TrafficCapture()
    auto_tc.start(port=port_auto)

    from ..cdp.browser.api import CDPWeles
    async with CDPWeles(
        os=os_name,
        proxy={"server": auto_tc.proxy_url},
    ) as ctx:
        page = await ctx.new_page()
        await task_fn(page)

    auto_tc.stop()
    auto_tc.save(auto_path)
    print(f"Auto capture saved: {auto_path}")

    # --- Step 3: Compare ---
    print()
    print("=" * 60)
    print("STEP 3: Comparison")
    print("=" * 60)
    real_data = TrafficCapture.load(real_path)
    auto_data = TrafficCapture.load(auto_path)
    diff = compare_captures(real_data, auto_data)

    with open(diff_path, "w") as f:
        json.dump(diff, f, indent=2)
    print(f"Diff report saved: {diff_path}")

    _print_diff(diff)

    return {
        "real_capture": real_path,
        "auto_capture": auto_path,
        "diff": diff,
        "diff_path": diff_path,
    }


def _open_browser(app_name: str, proxy_url: str):
    """Open a real browser with the proxy configured."""
    if sys.platform == "darwin":
        subprocess.Popen([
            "open", "-a", app_name,
            "--args",
            f"--proxy-server={proxy_url}",
            "--ignore-certificate-errors",
        ])
    elif sys.platform == "linux":
        subprocess.Popen([
            "google-chrome",
            f"--proxy-server={proxy_url}",
            "--ignore-certificate-errors",
        ])


async def _async_input():
    """Non-blocking input() that works in async context."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, input)


def _print_diff(diff: Dict[str, Any]):
    """Print a human-readable summary of the diff."""
    summary = diff.get("summary", {})
    print(f"\nVerdict: {summary.get('verdict', '?')}")
    print(f"Issues found: {summary.get('issue_count', '?')}")

    for section in ["tls", "http2", "headers", "cookies", "request_ordering"]:
        data = diff.get(section, {})
        issues = []
        for key, val in data.items():
            if isinstance(val, bool) and not val:
                issues.append(key)
            elif isinstance(val, list) and val:
                issues.append(f"{key}: {val}")
            elif isinstance(val, dict) and val:
                issues.append(f"{key}: {list(val.keys())}")
        if issues:
            print(f"\n[{section}]")
            for issue in issues:
                print(f"  - {issue}")
