"""Vision query escalation helpers used by find_click_target.

Stays inside the Claude Code CLI subscription (no Anthropic API calls)
- the escalation works by changing the input image and the question,
not by changing the model or invocation method.
"""
import json
import re
from typing import Optional


def center_crop(png_bytes: bytes, frac_w: float = 0.5,
                frac_h: float = 0.6) -> tuple[Optional[bytes], int, int]:
    """Return a center crop of a PNG plus the (offset_x, offset_y) of the
    crop relative to the original image. Returns (None, 0, 0) if PIL is
    unavailable or the image cannot be parsed.
    """
    try:
        from io import BytesIO
        from PIL import Image
        img = Image.open(BytesIO(png_bytes))
        w, h = img.size
        cw = int(w * frac_w)
        ch = int(h * frac_h)
        ox = (w - cw) // 2
        oy = (h - ch) // 2
        cropped = img.crop((ox, oy, ox + cw, oy + ch))
        out = BytesIO()
        cropped.save(out, format="PNG")
        return out.getvalue(), ox, oy
    except Exception:
        return None, 0, 0


def parse_xy(answer: str) -> Optional[dict]:
    """Try multiple ways to extract {x, y} from Claude's answer."""
    try:
        data = json.loads(answer.strip())
        if isinstance(data, dict) and "x" in data and "y" in data:
            return {"x": int(data["x"]), "y": int(data["y"])}
    except (json.JSONDecodeError, ValueError, KeyError):
        pass
    nums = re.findall(r"-?\d+", answer)
    if len(nums) >= 2:
        try:
            return {"x": int(nums[0]), "y": int(nums[1])}
        except ValueError:
            pass
    return None


def parse_elements(answer: str) -> list:
    """Parse a JSON array of UI elements from Claude's answer."""
    try:
        idx = answer.find("[")
        end = answer.rfind("]")
        if idx >= 0 and end > idx:
            data = json.loads(answer[idx:end + 1])
            if isinstance(data, list):
                return data
    except (json.JSONDecodeError, ValueError):
        pass
    return []


def filter_elements(elements: list, description: str) -> Optional[dict]:
    """Pick the element whose label best matches the description."""
    if not elements:
        return None
    keywords = [w for w in re.split(r"\W+", description.lower()) if len(w) > 2]
    best = None
    best_score = 0
    for el in elements:
        if not isinstance(el, dict):
            continue
        label = str(el.get("label", "")).lower()
        score = sum(1 for k in keywords if k in label)
        if score > best_score and "x" in el and "y" in el:
            try:
                best = {"x": int(el["x"]), "y": int(el["y"])}
                best_score = score
            except (ValueError, TypeError):
                pass
    return best
