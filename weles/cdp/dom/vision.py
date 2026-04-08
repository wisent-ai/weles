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
import re
import subprocess
import tempfile
from datetime import datetime
from typing import Optional


class VisionRefusedError(Exception):
    """Raised when Claude refuses to answer a vision query (safety refusal).

    The caller should NOT silently fall back to selector hacks or other
    bypass attempts; the failure must be visible so the prompt or context
    can be fixed.
    """

    def __init__(self, question: str, answer: str):
        self.question = question
        self.answer = answer
        super().__init__(
            f"Claude refused vision query. Question: {question!r}. "
            f"Answer: {answer[:300]!r}"
        )


# Phrases that indicate a refusal rather than an actual answer.
_REFUSAL_MARKERS = (
    "i'm not going to",
    "i won't",
    "i cannot help",
    "i can't help",
    "i'm not able to",
    "outside the scope",
    "i don't feel comfortable",
    "i'm unable to assist",
    "cannot assist with",
    "can't assist with",
    "i need to pause",
    "bypass",
)


def _is_refusal(answer: str) -> bool:
    low = answer.lower()
    return any(m in low for m in _REFUSAL_MARKERS)


async def ask_page(page, question: str,
                   image_bytes: Optional[bytes] = None,
                   tier: str = "tier_0_bare") -> str:
    """Single Claude vision call. No escalation here.

    If image_bytes is provided it is used directly; otherwise a fresh
    screenshot is taken. Raises VisionRefusedError on safety refusal.
    """
    if image_bytes is None:
        image_bytes = await _take_screenshot(page)
    if not image_bytes:
        return ""
    answer = _ask_claude(image_bytes, question, tier=tier)
    if _is_refusal(answer):
        raise VisionRefusedError(question, answer)
    return answer


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
    """Locate a click target via vision with mechanism-based escalation.

    Pipeline (each step tried only if the previous one refused or
    returned no parseable coordinates):

      tier_0_bare      bare question on the full screenshot
      tier_1_crop      same question on a centred crop (50% wide,
                       60% tall) - removes visual context that
                       triggers refusals; coords offset back to full
      tier_2_decompose ask Claude to enumerate all visible UI controls
                       as a JSON array, then filter by description text

    All tiers stay inside the Claude Code CLI subscription.

    Raises VisionRefusedError only if every tier refuses. Returns None
    if every tier answered but no tier produced parseable coordinates.
    """
    from . import escalation as esc

    full = await _take_screenshot(page)
    if not full:
        return None

    bare_q = (
        f"I need to click: {description}. "
        "Return the x,y pixel coordinates of where to click as JSON: "
        '{"x": <number>, "y": <number>}. Only the JSON, nothing else.'
    )
    refusals = []

    try:
        ans = await ask_page(page, bare_q, image_bytes=full,
                             tier="tier_0_bare")
        result = esc.parse_xy(ans)
        if result is not None:
            return result
    except VisionRefusedError as e:
        print("  [vision] tier_0_bare refused, escalating")
        refusals.append(("tier_0_bare", str(e)[:300]))

    cropped, ox, oy = esc.center_crop(full)
    if cropped is not None:
        try:
            ans = await ask_page(page, bare_q, image_bytes=cropped,
                                 tier="tier_1_crop")
            result = esc.parse_xy(ans)
            if result is not None:
                return {"x": result["x"] + ox, "y": result["y"] + oy}
        except VisionRefusedError as e:
            print("  [vision] tier_1_crop refused, escalating")
            refusals.append(("tier_1_crop", str(e)[:300]))
    else:
        print("  [vision] tier_1_crop unavailable (no PIL); skipping")

    decomp_q = (
        "List every interactive UI control visible in this image. "
        "Return ONLY a JSON array, no prose, where each element has "
        '"label" (visible text or description), "x" (centre x in pixels), '
        '"y" (centre y in pixels). Example: '
        '[{"label": "Submit button", "x": 400, "y": 300}]'
    )
    try:
        ans = await ask_page(page, decomp_q, image_bytes=full,
                             tier="tier_2_decompose")
        elements = esc.parse_elements(ans)
        match = esc.filter_elements(elements, description)
        if match is not None:
            return match
    except VisionRefusedError as e:
        print("  [vision] tier_2_decompose refused, escalating")
        refusals.append(("tier_2_decompose", str(e)[:300]))

    if len(refusals) == 3:
        raise VisionRefusedError(
            description,
            f"All 3 vision tiers refused: {refusals}",
        )
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


def _ask_claude(screenshot: bytes, question: str,
                tier: str = "tier_0_bare") -> str:
    """Send screenshot to Claude Code CLI; log Q/A to recordings/vision/."""
    vision_dir = os.environ.get("WELES_VISION_DIR") or os.path.join(
        os.getcwd(), "recordings", "vision")
    os.makedirs(vision_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    img_path = os.path.join(vision_dir, f"vision_{ts}_{tier}.png")
    log_path = os.path.join(vision_dir, f"vision_{ts}_{tier}.json")
    with open(img_path, "wb") as f:
        f.write(screenshot)

    answer = ""
    error = None
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
                    answer = json.loads(line).get("result", raw)
                    break
                except json.JSONDecodeError:
                    pass
        if not answer:
            try:
                answer = json.loads(raw).get("result", raw)
            except json.JSONDecodeError:
                answer = raw
    except FileNotFoundError as e:
        error = str(e)
        answer = ""

    try:
        with open(log_path, "w") as f:
            json.dump({
                "timestamp": ts,
                "tier": tier,
                "image": os.path.basename(img_path),
                "question": question,
                "answer": answer,
                "error": error,
            }, f, indent=2)
    except OSError:
        pass

    # Bound vision dir size (default 500 MB, override via env var)
    try:
        from weles import prune_recordings
        budget = int(os.environ.get("WELES_VISION_MAX_BYTES",
                                    str(500 * 1024 * 1024)))
        prune_recordings(vision_dir, budget)
    except Exception:
        pass

    return answer
