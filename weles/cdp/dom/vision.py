"""Vision-based page state analysis using Claude Code CLI.

Replaces keyword matching against page text with screenshot analysis.
Instead of checking if "verify" is in page_text, ask Claude what the
page is showing and get a structured answer.

Usage:
    from weles.cdp.dom.vision import ask_page

    state = ask_page(page, "Is this a login page, a dashboard, or a captcha?")
    # Returns: "This is a login page with email and password fields."

    success = ask_page(page, "Did the login succeed? Answer YES or NO.")
    # Returns: "YES" or "NO"
"""

import base64
import json
import os
import subprocess
import tempfile
from typing import Optional


async def ask_page(page, question: str) -> str:
    """Take a screenshot of the page and ask Claude about it.

    Args:
        page: A Playwright Page or CDPPage instance.
        question: What to ask about the page state.

    Returns:
        Claude's answer as a string.
    """
    screenshot_data = await _take_screenshot(page)
    if not screenshot_data:
        return ""
    return _ask_claude(screenshot_data, question)


async def check_page(page, question: str) -> bool:
    """Ask a yes/no question about the page. Returns True/False.

    Args:
        page: A Playwright Page or CDPPage instance.
        question: Yes/no question about the page state.

    Returns:
        True if Claude answers affirmatively.
    """
    answer = await ask_page(page, f"{question} Answer only YES or NO.")
    return answer.strip().upper().startswith("YES")


async def identify_page(page) -> str:
    """Identify what type of page is currently displayed.

    Returns a short description like:
    - "login_page"
    - "dashboard"
    - "captcha_challenge"
    - "error_page"
    - "verification_required"
    """
    return await ask_page(
        page,
        "What type of page is this? Answer with exactly one of: "
        "login_page, dashboard, captcha_challenge, error_page, "
        "verification_required, signup_page, success_page, "
        "loading, blocked, or unknown. Just the label, nothing else."
    )


async def find_click_target(page, description: str) -> Optional[dict]:
    """Ask Claude to locate an element to click and return its coordinates.

    Args:
        page: A Playwright Page or CDPPage instance.
        description: What to click (e.g. "the checkbox to verify you are human").

    Returns:
        {"x": int, "y": int} if found, None otherwise.
    """
    answer = await ask_page(
        page,
        f"I need to click: {description}. "
        "Return the x,y pixel coordinates of where to click as JSON: "
        '{{"x": <number>, "y": <number>}}. Only the JSON, nothing else.'
    )
    try:
        data = json.loads(answer.strip())
        if "x" in data and "y" in data:
            return {"x": int(data["x"]), "y": int(data["y"])}
    except (json.JSONDecodeError, ValueError, KeyError):
        pass
    return None


async def _take_screenshot(page) -> Optional[bytes]:
    """Take a screenshot, handling both Playwright and CDPPage."""
    try:
        if hasattr(page, 'screenshot'):
            # Playwright page
            return await page.screenshot()
        elif hasattr(page, '_conn'):
            # CDPPage — use CDP screenshot
            result = await page._conn.send(
                "Page.captureScreenshot",
                {"format": "png"},
                session_id=page._sid,
            )
            return base64.b64decode(result.get("data", ""))
    except Exception:
        pass
    return None


def _ask_claude(screenshot: bytes, question: str) -> str:
    """Send screenshot to Claude Code CLI and ask the question."""
    # Save to a project-local path that Claude CLI can access
    vision_dir = os.path.join(os.getcwd(), "recordings", "vision")
    os.makedirs(vision_dir, exist_ok=True)
    img_path = os.path.join(vision_dir, "vision_query.png")
    with open(img_path, "wb") as f:
        f.write(screenshot)

    try:
        prompt = f"Read the image file at {img_path}. Then answer: {question}"
        proc = subprocess.run(
            ["claude", "-p", "--output-format", "json"],
            input=prompt,
            capture_output=True,
            text=True,
        )
        raw = proc.stdout.strip()
        for line in raw.split("\n"):
            if '"type":"result"' in line:
                try:
                    return json.loads(line).get("result", raw)
                except json.JSONDecodeError:
                    pass
        try:
            return json.loads(raw).get("result", raw)
        except json.JSONDecodeError:
            return raw
    except FileNotFoundError:
        return ""
    finally:
        try:
            os.unlink(img_path)
        except OSError:
            pass
