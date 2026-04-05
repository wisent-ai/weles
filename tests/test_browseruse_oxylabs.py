"""Test Oxylabs dashboard access via Browser Use cloud stealth browser."""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from browser_use_sdk.v3 import AsyncBrowserUse


async def test_oxylabs():
    """Use Browser Use to navigate to Oxylabs and check if CF blocks."""
    api_key = os.environ.get(
        "BROWSER_USE_API_KEY",
        "bu_WN7UEtvqVoR-x70ZMjRINanwhOpnEM4LF-HSAsIyc7c",
    )
    client = AsyncBrowserUse(api_key=api_key)

    result = await client.run(
        "Go to https://dashboard.oxylabs.io/en/ and tell me "
        "what you see on the page. Is it the Oxylabs dashboard "
        "or a Cloudflare security verification page?"
    )
    print(f"Output: {result.output}")


if __name__ == "__main__":
    asyncio.run(test_oxylabs())
