"""Test raw patched Chromium with minimal CDP — no init scripts at all."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from weles.cdp.launcher import launch_chromium
from weles.cdp.connection import CDPConnection


async def main():
    patched = "/Users/zuzannadykiert/Desktop/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium"

    proc, ws_url = await launch_chromium(headless=True, chromium_path=patched)
    conn = CDPConnection()
    await conn.connect(ws_url)

    # Minimal CDP: just create a target, enable Page, navigate
    result = await conn.send("Target.createTarget", {"url": "about:blank"})
    target_id = result["targetId"]
    attach = await conn.send("Target.attachToTarget",
                             {"targetId": target_id, "flatten": True})
    sid = attach["sessionId"]
    await conn.send("Page.enable", session_id=sid)

    # Navigate — NO init scripts, NO fingerprint spoofing
    nav = await conn.send("Page.navigate",
                          {"url": "https://dashboard.oxylabs.io/en/"},
                          session_id=sid)

    # Wait for load
    loaded = asyncio.Event()
    conn.on("Page.loadEventFired", lambda p: loaded.set(), sid)

    for _ in range(15):
        if loaded.is_set():
            break
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        loop.call_later(2, fut.set_result, None)
        await fut

    # Read body via Runtime.evaluate WITHOUT Runtime.enable
    result = await conn.send("Page.createIsolatedWorld", {
        "frameId": nav.get("frameId", ""),
        "worldName": "",
        "grantUniveralAccess": True,
    }, session_id=sid)
    ctx_id = result["executionContextId"]

    result = await conn.send("Runtime.evaluate", {
        "expression": "document.body.innerText.substring(0, 300)",
        "contextId": ctx_id,
        "returnByValue": True,
    }, session_id=sid)
    body = result.get("result", {}).get("value", "")
    print(f"Body: {body[:200]}")

    await conn.close()
    proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
