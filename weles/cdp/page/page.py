"""CDP Page API -- navigation, evaluation, selectors, screenshots."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Union

from .frame import CDPFrame, FrameTree
from .screencast import CDPScreencast

if TYPE_CHECKING:
    from ..connection import CDPConnection
    from ..input import CDPKeyboard, CDPMouse

logger = logging.getLogger(__name__)


class CDPPage:
    """Page abstraction over a CDP target. Never sends Runtime.enable."""

    def __init__(self, connection: CDPConnection, target_id: str,
                 session_id: str, context: Any = None,
                 record_video: Optional[Dict[str, Any]] = None):
        self._conn, self._target_id, self._sid = connection, target_id, session_id
        self._context = context
        self._ft = FrameTree(connection, session_id)
        self._init_scripts: List[str] = []
        self._routes: List[tuple] = []
        self._handlers: Dict[str, List[Callable]] = {}
        self._load_ev, self._dc_ev = asyncio.Event(), asyncio.Event()
        self._mouse: Optional[CDPMouse] = None
        self._kb: Optional[CDPKeyboard] = None
        self._viewport: Optional[Dict[str, int]] = None
        self._video, self._record_video_opts = None, record_video
        self._screencast: Optional[CDPScreencast] = None
        self._closed = False
        self._conn.on("Page.loadEventFired", self._on_load, session_id)
        self._conn.on("Page.domContentEventFired", self._on_dc, session_id)

    async def _init(self):
        s = self._sid
        await self._conn.send("Page.enable", session_id=s)
        await self._conn.send("Network.enable", session_id=s)
        tree = await self._conn.send("Page.getFrameTree", session_id=s)
        root = tree.get("frameTree", {}).get("frame", {})
        self._ft.set_main_frame(root.get("id", ""), root.get("url", ""))
        self._conn.on("Network.responseReceived", lambda p: self._fire("response", p), s)
        if self._record_video_opts:
            self._screencast = CDPScreencast(
                self._conn, s, output_dir=self._record_video_opts.get("dir"))
            await self._screencast.start()

    def _on_load(self, p):
        self._load_ev.set(); self._fire("load", p)

    def _on_dc(self, p):
        self._dc_ev.set(); self._fire("domcontentloaded", p)

    def _fire(self, name, data=None):
        for h in self._handlers.get(name, []):
            try:
                r = h(data)
                if asyncio.iscoroutine(r):
                    asyncio.ensure_future(r)
            except Exception:
                logger.exception("Page handler error: %s", name)

    @property
    def context(self): return self._context

    @property
    def url(self) -> str:
        mf = self._ft.main_frame
        return mf.url if mf else ""

    @property
    def frames(self) -> List[CDPFrame]: return self._ft.frames

    @property
    def main_frame(self) -> Optional[CDPFrame]: return self._ft.main_frame

    @property
    def mouse(self) -> CDPMouse:
        if self._mouse is None:
            from ..input import CDPMouse as _M
            self._mouse = _M(self._conn, self._sid)
        return self._mouse

    @property
    def keyboard(self) -> CDPKeyboard:
        if self._kb is None:
            from ..input import CDPKeyboard as _K
            self._kb = _K(self._conn, self._sid)
        return self._kb

    @property
    def video(self):
        return self._screencast.video if self._screencast else self._video

    @property
    def viewport_size(self) -> Optional[Dict[str, int]]: return self._viewport

    async def goto(self, url: str, *, wait_until: str = "load",
                   timeout: float = 30000) -> None:
        self._load_ev.clear()
        self._dc_ev.clear()
        r = await self._conn.send("Page.navigate", {"url": url}, session_id=self._sid)
        if r.get("errorText"):
            from ..errors import CDPNavigationError
            raise CDPNavigationError(f"Navigation failed: {r['errorText']}")
        await self._wait_lc(wait_until)

    async def reload(self) -> None:
        self._load_ev.clear()
        self._dc_ev.clear()
        await self._conn.send("Page.reload", session_id=self._sid)
        await self._wait_lc("load")

    async def go_back(self) -> None:
        h = await self._conn.send("Page.getNavigationHistory", session_id=self._sid)
        idx = h.get("currentIndex", 0)
        if idx > 0:
            await self._conn.send("Page.navigateToHistoryEntry",
                                  {"entryId": h["entries"][idx - 1]["id"]},
                                  session_id=self._sid)

    async def _wait_lc(self, state: str):
        if state == "domcontentloaded":
            await self._dc_ev.wait()
        elif state in ("load", "networkidle"):
            await self._load_ev.wait()

    async def evaluate(self, expression: str, arg: Any = None) -> Any:
        mf = self._ft.main_frame
        if not mf:
            from ..errors import CDPError
            raise CDPError("No main frame")
        return await mf.evaluate(expression, arg)

    async def content(self) -> str:
        mf = self._ft.main_frame
        r = await self._conn.send("Page.getResourceContent",
                                  {"frameId": mf.frame_id, "url": self.url},
                                  session_id=self._sid)
        return r.get("content", "")

    async def title(self) -> str:
        mf = self._ft.main_frame
        return (await mf.evaluate("document.title") if mf else "") or ""

    async def text_content(self, selector: str) -> Optional[str]:
        mf = self._ft.main_frame
        if not mf:
            return None
        return await mf.evaluate(
            f"(document.querySelector({json.dumps(selector)})||{{}}).textContent")

    async def inner_text(self, selector: str) -> str:
        mf = self._ft.main_frame
        if not mf:
            return ""
        v = await mf.evaluate(
            f"(document.querySelector({json.dumps(selector)})||{{}}).innerText||''")
        return v or ""

    def locator(self, selector: str):
        from ..dom.locator import CDPLocator
        return CDPLocator(self._ft.main_frame, selector)

    def get_by_role(self, role: str, *, name: str = ""):
        sel = f'[role="{role}"][aria-label="{name}"]' if name else f'[role="{role}"]'
        return self.locator(sel)

    def get_by_text(self, text: str, *, exact: bool = False):
        if exact:
            return self.locator(f'xpath=//text()[.="{text}"]/parent::*')
        return self.locator(f'xpath=//text()[contains(.,"{text}")]/parent::*')

    async def wait_for_timeout(self, ms: float):
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        loop.call_later(ms / 1000, fut.set_result, None); await fut

    async def wait_for_selector(self, selector: str, *, state: str = "visible"):
        js = _sel_check(selector, state)
        mf = self._ft.main_frame
        if not mf:
            from ..errors import CDPError
            raise CDPError("No main frame")
        while not await mf.evaluate(js):
            await self.wait_for_timeout(100)

    async def wait_for_load_state(self, state: str = "load"):
        await self._wait_lc(state)

    async def wait_for_url(self, url_or_pat: Union[str, re.Pattern]):
        while True:
            cur = self.url
            if isinstance(url_or_pat, re.Pattern) and url_or_pat.search(cur):
                return
            elif isinstance(url_or_pat, str) and url_or_pat in cur:
                return
            await self.wait_for_timeout(100)

    async def screenshot(self, *, path: Optional[str] = None,
                         full_page: bool = False) -> bytes:
        params: Dict[str, Any] = {"format": "png"}
        if full_page:
            m = await self._conn.send("Page.getLayoutMetrics", session_id=self._sid)
            cs = m.get("contentSize", {})
            params["clip"] = {"x": 0, "y": 0, "scale": 1,
                              "width": cs.get("width", 1920),
                              "height": cs.get("height", 1080)}
        r = await self._conn.send("Page.captureScreenshot", params,
                                  session_id=self._sid)
        raw = base64.b64decode(r.get("data", ""))
        if path:
            with open(path, "wb") as f:
                f.write(raw)
        return raw

    def on(self, event: str, handler: Callable):
        self._handlers.setdefault(event, []).append(handler)

    async def close(self):
        if self._closed:
            return
        self._closed = True
        if self._screencast:
            await self._screencast.stop()
        try:
            await self._conn.send("Target.closeTarget", {"targetId": self._target_id})
        except Exception:
            pass

    async def add_init_script(self, script: str):
        self._init_scripts.append(script)
        await self._conn.send(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": script},
            session_id=self._sid,
        )

    async def route(self, pattern: str, handler: Callable):
        if not self._routes:
            await self._conn.send("Fetch.enable",
                                  {"patterns": [{"urlPattern": "*"}]},
                                  session_id=self._sid)
            self._conn.on("Fetch.requestPaused", self._on_paused, self._sid)
        self._routes.append((re.compile(pattern), handler))

    async def _on_paused(self, params: dict):
        url = params.get("request", {}).get("url", "")
        rid = params.get("requestId", "")
        for regex, handler in self._routes:
            if regex.search(url):
                await handler(_Route(self._conn, self._sid, params))
                return
        await self._conn.send("Fetch.continueRequest",
                              {"requestId": rid}, session_id=self._sid)


class _Route:
    """Proxy passed to route handlers."""
    def __init__(self, conn, sid, params):
        self._c, self._s = conn, sid
        self.request = params.get("request", {})
        self._rid = params.get("requestId", "")

    async def abort(self, reason: str = "Failed"):
        await self._c.send("Fetch.failRequest",
                           {"requestId": self._rid, "errorReason": reason},
                           session_id=self._s)

    async def fulfill(self, *, status: int = 200,
                      headers: Optional[dict] = None, body: str = ""):
        h = [{"name": k, "value": v} for k, v in (headers or {}).items()]
        await self._c.send("Fetch.fulfillRequest", {
            "requestId": self._rid, "responseCode": status,
            "responseHeaders": h,
            "body": base64.b64encode(body.encode()).decode(),
        }, session_id=self._s)

    async def continue_(self):
        await self._c.send("Fetch.continueRequest",
                           {"requestId": self._rid}, session_id=self._s)


def _sel_check(selector: str, state: str) -> str:
    if selector.startswith("xpath="):
        xp = selector[6:]
        base = (f"document.evaluate({json.dumps(xp)},document,null,"
                f"XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue")
    else:
        base = f"document.querySelector({json.dumps(selector)})"
    return f"!({base})" if state in ("detached", "hidden") else f"!!({base})"
