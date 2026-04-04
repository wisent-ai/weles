"""Isolate which spoofing script causes a site to detect automation.

Runs the same task multiple times:
1. No spoofing at all (plain Playwright)
2. All scripts enabled (full weles)
3. Each script excluded one at a time

For each run, records video and captures telemetry, then uses
Capture.diagnose() to determine if the task succeeded or failed.
Returns a structured report identifying which script(s) cause detection.
"""

import asyncio
from typing import Any, Callable, Dict, Optional

from ..async_api import AsyncNewBrowser
from ..capture import Capture
from ..scripts import list_scripts
from playwright.async_api import async_playwright


async def _run_variant(
    task_fn: Callable,
    label: str,
    browser: str,
    os_name: str,
    locale: str,
    exclude: Optional[list],
    no_spoof: bool,
) -> Dict[str, Any]:
    """Run one variant of the task and return results."""
    pw = await async_playwright().start()
    try:
        if no_spoof:
            # Plain Playwright, no weles spoofing
            if browser == "chromium":
                pw_browser = await pw.chromium.launch(headless=False)
            else:
                pw_browser = await pw.firefox.launch(headless=False)
            ctx = await pw_browser.new_context(locale=locale)
            ctx._weles_browser = pw_browser
        else:
            ctx = await AsyncNewBrowser(
                pw, browser=browser, os=os_name, locale=locale,
                record_video=True, exclude_scripts=exclude,
            )

        cap = Capture(ctx)
        page = await cap.new_page()

        success = await task_fn(page)

        paths = cap.save(label)
        video_path = None
        if page.video:
            video_path = await page.video.path()

        await ctx.close()

        diagnosis = ""
        if video_path:
            diagnosis = Capture.diagnose(
                str(video_path),
                console_log_path=paths.get("console"),
                responses_path=paths.get("responses"),
            )

        return {
            "label": label,
            "exclude": exclude,
            "no_spoof": no_spoof,
            "success": success,
            "diagnosis": diagnosis,
            "video": str(video_path) if video_path else None,
            "paths": paths,
        }
    finally:
        await pw.stop()


async def isolate_failure(
    task_fn: Callable,
    browser: str = "chromium",
    os_name: str = "macos",
    locale: str = "en-US",
) -> Dict[str, Any]:
    """Isolate which spoofing script causes detection.

    Args:
        task_fn: Async function that takes a page and returns True if
            the task succeeded, False if it failed. The function should
            perform the action being tested (e.g. login, navigate, etc).
        browser: "chromium" or "firefox".
        os_name: Target OS for fingerprint generation.
        locale: Browser locale.

    Returns a dict with:
        - "results": list of per-variant results
        - "conclusion": human-readable summary
        - "culprit": name of the script causing detection, or None
    """
    scripts = list_scripts()
    results = []

    # Run 1: No spoofing at all (plain Playwright)
    print(f"[isolate] Running: no_spoofing (plain Playwright {browser})")
    r = await _run_variant(task_fn, "no_spoofing", browser, os_name, locale,
                           exclude=None, no_spoof=True)
    results.append(r)
    print(f"[isolate] no_spoofing: {'PASS' if r['success'] else 'FAIL'}")

    # Run 2: All scripts enabled (full weles)
    print(f"[isolate] Running: all_scripts (full weles)")
    r = await _run_variant(task_fn, "all_scripts", browser, os_name, locale,
                           exclude=None, no_spoof=False)
    results.append(r)
    print(f"[isolate] all_scripts: {'PASS' if r['success'] else 'FAIL'}")

    # If plain Playwright also fails, spoofing isn't the issue
    no_spoof_result = results[0]
    all_scripts_result = results[1]

    if not no_spoof_result["success"]:
        return {
            "results": results,
            "conclusion": (
                f"Plain Playwright {browser} (no weles) also fails. "
                "The detection is not caused by weles spoofing scripts. "
                "The site detects Playwright itself or something else."
            ),
            "culprit": None,
        }

    if all_scripts_result["success"]:
        return {
            "results": results,
            "conclusion": "Both plain Playwright and full weles pass. No issue detected.",
            "culprit": None,
        }

    # Plain passes, weles fails — one of the scripts is causing detection.
    # Exclude each script one at a time.
    for script in scripts:
        label = f"without_{script.replace('.js', '')}"
        print(f"[isolate] Running: {label}")
        r = await _run_variant(task_fn, label, browser, os_name, locale,
                               exclude=[script], no_spoof=False)
        results.append(r)
        print(f"[isolate] {label}: {'PASS' if r['success'] else 'FAIL'}")

        if r["success"]:
            return {
                "results": results,
                "conclusion": (
                    f"Excluding '{script}' makes the task pass. "
                    f"This script is causing detection."
                ),
                "culprit": script,
            }

    return {
        "results": results,
        "conclusion": (
            "No single script exclusion fixes the issue. "
            "The detection is caused by a combination of scripts, "
            "or by something in weles's core (user agent, viewport, etc)."
        ),
        "culprit": None,
    }
