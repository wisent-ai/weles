"""Human-like mouse movement using Bezier curves."""

import asyncio
import math
import random


def _bezier_points(start, end, steps=None):
    """Generate points along a cubic Bezier curve between start and end."""
    x0, y0 = start
    x3, y3 = end
    dist = math.hypot(x3 - x0, y3 - y0)
    if steps is None:
        steps = max(10, int(dist / 5))

    # Random control points for natural curve
    cx1 = x0 + (x3 - x0) * random.uniform(0.1, 0.4) + random.uniform(-30, 30)
    cy1 = y0 + (y3 - y0) * random.uniform(0.1, 0.4) + random.uniform(-30, 30)
    cx2 = x0 + (x3 - x0) * random.uniform(0.6, 0.9) + random.uniform(-30, 30)
    cy2 = y0 + (y3 - y0) * random.uniform(0.6, 0.9) + random.uniform(-30, 30)

    points = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * x0 + 3 * u**2 * t * cx1 + 3 * u * t**2 * cx2 + t**3 * x3
        y = u**3 * y0 + 3 * u**2 * t * cy1 + 3 * u * t**2 * cy2 + t**3 * y3
        points.append((int(x), int(y)))
    return points


async def move_to(page, x, y, start_x=None, start_y=None, steps=None):
    """Move mouse along a Bezier curve to (x, y)."""
    if start_x is None or start_y is None:
        vp = page.viewport_size or {"width": 1920, "height": 1080}
        start_x = start_x or random.randint(0, vp["width"])
        start_y = start_y or random.randint(0, vp["height"])

    points = _bezier_points((start_x, start_y), (x, y), steps)
    for px, py in points:
        await page.mouse.move(px, py)
        await asyncio.sleep(random.uniform(0.002, 0.012))


async def click_at(page, x, y, start_x=None, start_y=None):
    """Move to position with Bezier curve, then click with jitter."""
    jx = x + random.randint(-2, 2)
    jy = y + random.randint(-2, 2)
    await move_to(page, jx, jy, start_x, start_y)
    await asyncio.sleep(random.uniform(0.05, 0.15))
    await page.mouse.click(jx, jy)


async def random_movements(page, count=None):
    """Perform random mouse movements across the viewport."""
    vp = page.viewport_size or {"width": 1920, "height": 1080}
    if count is None:
        count = random.randint(2, 5)
    for _ in range(count):
        x = random.randint(50, vp["width"] - 50)
        y = random.randint(50, vp["height"] - 50)
        await move_to(page, x, y)
        await asyncio.sleep(random.uniform(0.1, 0.5))
