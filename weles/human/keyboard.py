"""Human-like keyboard input and timing."""

import asyncio
import random


async def type_text(page, selector, text, clear=True, min_delay=30, max_delay=120):
    """Type text character-by-character with random delays.

    Args:
        page: Playwright page
        selector: CSS selector for the input element
        text: Text to type
        clear: Whether to clear the field first
        min_delay: Minimum ms between keystrokes
        max_delay: Maximum ms between keystrokes
    """
    el = page.locator(selector).first
    if clear:
        await el.click()
        await el.fill("")
    else:
        await el.click()

    for i, char in enumerate(text):
        delay = random.randint(min_delay, max_delay)
        # Occasional longer pause (simulates thinking)
        if random.random() < 0.05:
            delay += random.randint(200, 600)
        await page.keyboard.type(char, delay=delay)


async def human_delay(min_ms=500, max_ms=2000):
    """Random delay simulating human pause."""
    await asyncio.sleep(random.randint(min_ms, max_ms) / 1000)


async def human_think(min_ms=1000, max_ms=4000):
    """Longer delay simulating reading or thinking."""
    await asyncio.sleep(random.randint(min_ms, max_ms) / 1000)
