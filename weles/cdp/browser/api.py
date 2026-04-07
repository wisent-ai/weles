"""High-level CDP API for weles — no Playwright dependency.

Usage:
    from weles.cdp.browser.api import CDPWeles

    async with CDPWeles(os="macos") as ctx:
        page = await ctx.new_page()
        await page.goto("https://example.com")
"""

import json as _json
import tempfile

from typing import Any, Dict, List, Optional, Union

from ...fingerprint import generate, to_config, to_cpp_config
from ...scripts import build_init_script
from ..launcher import launch_chromium
from ..connection import CDPConnection
from .context import CDPBrowserContext


class CDPWeles:
    """Context manager: launches stealth Chromium via raw CDP (no Playwright)."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._process = None
        self._conn = None
        self._context = None

    async def __aenter__(self):
        self._context = await CDPNewBrowser(**self.kwargs)
        self._conn = self._context._conn
        self._process = self._context._process
        return self._context

    async def __aexit__(self, *args):
        try:
            if self._context:
                await self._context.close()
        except Exception:
            pass
        try:
            if self._conn:
                await self._conn.close()
        except Exception:
            pass
        try:
            if self._process:
                self._process.terminate()
        except ProcessLookupError:
            pass


async def CDPNewBrowser(
    *,
    os: Optional[Union[str, List[str]]] = None,
    config: Optional[Dict[str, Any]] = None,
    proxy: Optional[Dict[str, str]] = None,
    locale: Optional[Union[str, List[str]]] = None,
    headless: Optional[bool] = None,
    debug: Optional[bool] = None,
    user_data_dir: Optional[str] = None,
    exclude_scripts: Optional[list] = None,
    chromium_path: Optional[str] = None,
    record_video: Optional[Dict[str, Any]] = None,
    **launch_options,
):
    """Launch stealth Chromium via raw CDP."""
    if os is None:
        os = "macos"
    target_os = os if isinstance(os, str) else os[0]

    fp = generate(os=os, browser="chromium")
    fp_config = to_config(
        fp, target_os=target_os, config_overrides=config, browser="chromium")
    init_script = build_init_script(fp_config, exclude=exclude_scripts)

    if debug:
        import json
        print("[weles-cdp] Fingerprint config:")
        print(json.dumps(fp_config, indent=2)[:2000])

    process = None
    conn = CDPConnection()

    if headless is None:
        headless = False
    # Write C++ fingerprint config for the custom Chromium build
    cpp_config = to_cpp_config(fp_config)
    fp_file = tempfile.NamedTemporaryFile(
        prefix="weles-fp-", suffix=".json", delete=False, mode="w")
    _json.dump(cpp_config, fp_file)
    fp_file.close()

    proxy_server = proxy.get("server") if proxy else None
    extra_args = launch_options.pop("args", []) or []
    process, ws_url = await launch_chromium(
        headless=headless, args=extra_args, user_data_dir=user_data_dir,
        proxy_server=proxy_server, chromium_path=chromium_path,
        fingerprint_config_path=fp_file.name)
    await conn.connect(ws_url)
    result = await conn.send("Target.createBrowserContext", {})
    browser_context_id = result["browserContextId"]

    nav = fp_config.get("navigator", {})
    scr = fp_config.get("screen", {})
    win = fp_config.get("window", {})

    if locale:
        locale_str = locale if isinstance(locale, str) else locale[0]
    else:
        import locale as _loc
        try:
            sys_locale = _loc.getdefaultlocale()[0] or "en_US"
            lang = sys_locale.replace("_", "-")
            locale_str = f"{lang},{lang.split('-')[0]};q=0.9,en-US;q=0.8,en;q=0.7"
        except Exception:
            locale_str = "en-US"


    ctx = CDPBrowserContext(conn, browser_context_id, record_video=record_video)
    ctx.set_emulation(
        user_agent=nav.get("userAgent", ""),
        viewport_width=win.get("outerWidth", scr.get("width", 1920)),
        viewport_height=win.get("outerHeight", scr.get("height", 1080)) - 80,
        device_scale_factor=win.get("devicePixelRatio", 1),
        accept_language=locale_str,
        platform=nav.get("platform", ""),
    )
    await ctx.add_init_script(init_script)

    ctx._conn = conn
    ctx._process = process
    return ctx
