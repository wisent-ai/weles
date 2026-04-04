"""Auto-triggered traffic fingerprint comparison.

When a CDPWeles task fails, this module:
1. Captures the failed automated run's traffic (already done via proxy)
2. Opens a real browser with the same proxy for a human to succeed
3. Watches for the human to complete (browser process exits)
4. Compares automated vs human traffic fingerprints
5. Reports what the automated browser does differently

This is called by Capture.finish() when the task reports failure.
"""

import json
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional

from ..traffic.capture import TrafficCapture
from ..traffic.compare import compare_captures


def on_failure(
    auto_capture_path: str,
    url: str,
    *,
    task_description: str = "",
    real_browser: str = "Google Chrome",
    output_dir: str = "recordings/traffic_diff",
    port: int = 8080,
) -> Optional[Dict[str, Any]]:
    """Triggered when an automated task fails. Opens real browser for comparison.

    This is synchronous and blocking — it waits for the real browser process
    to exit, which happens when the human closes the browser window.

    Args:
        auto_capture_path: Path to the already-saved automated traffic capture.
        url: URL to open in the real browser.
        task_description: What the human should do (shown in the browser).
        real_browser: App name for the real browser.
        output_dir: Where to save the comparison report.
        port: Proxy port for the real browser capture.

    Returns:
        Diff report dict, or None if capture failed.
    """
    os.makedirs(output_dir, exist_ok=True)
    real_path = os.path.join(output_dir, "real_capture.json")
    diff_path = os.path.join(output_dir, "diff_report.json")

    tc = TrafficCapture()
    tc.start(port=port)

    if not task_description:
        task_description = f"Complete the task on {url}"
    landing = _create_landing_page(url, task_description, output_dir)
    proc = _launch_real_browser(real_browser, tc.proxy_url, landing)

    if not proc:
        tc.stop()
        return None

    # Wait for browser to exit (human closes it when done)
    proc.wait()
    print("[weles] Browser closed. Processing captures...")

    tc.stop()
    tc.save(real_path)

    # Load both captures and compare
    auto_data = TrafficCapture.load(auto_capture_path)
    real_data = TrafficCapture.load(real_path)

    if not auto_data or not real_data:
        print("[weles] Missing capture data, cannot compare.")
        return None

    diff = compare_captures(real_data, auto_data)

    with open(diff_path, "w") as f:
        json.dump(diff, f, indent=2)

    _print_report(diff)

    return {
        "real_capture": real_path,
        "auto_capture": auto_capture_path,
        "diff": diff,
        "diff_path": diff_path,
    }


def _create_landing_page(url: str, task_description: str, output_dir: str) -> str:
    """Create a Wisent-branded landing page for traffic comparison."""
    from ..session.landing import build_landing_html
    domain = url.split("//")[-1].split("/")[0]
    html = build_landing_html(domain, url, task_description, purpose="comparison")
    path = os.path.join(output_dir, "weles_landing.html")
    with open(path, "w") as f:
        f.write(html)
    return "file://" + os.path.abspath(path)


def _launch_real_browser(app_name: str, proxy_url: str, url: str):
    """Launch a real browser with proxy, navigating to URL. Returns Popen."""
    try:
        if sys.platform == "darwin":
            return subprocess.Popen([
                "open", "-W",
                "-a", app_name,
                url,
                "--args",
                f"--proxy-server={proxy_url}",
                "--ignore-certificate-errors",
                "--no-first-run",
                "--new-window",
            ])
        elif sys.platform == "linux":
            return subprocess.Popen([
                "google-chrome",
                f"--proxy-server={proxy_url}",
                "--ignore-certificate-errors",
                "--no-first-run",
                url,
            ])
    except FileNotFoundError:
        pass
    return None


def _print_report(diff: Dict[str, Any]):
    """Print human-readable diff summary."""
    summary = diff.get("summary", {})
    print(f"\n{'=' * 60}")
    print(f"TRAFFIC FINGERPRINT COMPARISON")
    print(f"{'=' * 60}")
    print(f"Verdict: {summary.get('verdict', '?')}")
    print(f"Issues: {summary.get('issue_count', '?')}")

    for section in ["tls", "http2", "headers", "cookies", "request_ordering"]:
        data = diff.get(section, {})
        issues = _extract_issues(data)
        if issues:
            print(f"\n[{section}]")
            for issue in issues:
                print(f"  - {issue}")


def _extract_issues(data: Dict[str, Any]) -> List[str]:
    """Pull notable differences from a diff section."""
    issues = []
    for key, val in data.items():
        if isinstance(val, bool) and not val:
            issues.append(key)
        elif isinstance(val, list) and val:
            issues.append(f"{key}: {val}")
        elif isinstance(val, dict) and val:
            issues.append(f"{key}: {list(val.keys())}")
    return issues
