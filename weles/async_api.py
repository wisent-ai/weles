"""Async API for Weles browser fingerprint spoofing."""

from typing import Any, Dict, List, Optional, Tuple, Union

from playwright.async_api import (
    BrowserContext,
    Playwright,
    async_playwright,
)

from .fingerprint import generate, to_config
from .scripts import build_init_script


class AsyncWeles:
    """Context manager that launches a spoofed Playwright Firefox browser."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._pw = None
        self._context: Optional[BrowserContext] = None

    async def __aenter__(self) -> BrowserContext:
        self._pw = await async_playwright().start()
        self._context = await AsyncNewBrowser(self._pw, **self.kwargs)
        return self._context

    async def __aexit__(self, *args):
        if self._context:
            await self._context.close()
        if self._pw:
            await self._pw.stop()


async def AsyncNewBrowser(
    playwright: Playwright,
    *,
    os: Optional[Union[str, List[str]]] = None,
    config: Optional[Dict[str, Any]] = None,
    proxy: Optional[Dict[str, str]] = None,
    locale: Optional[Union[str, List[str]]] = None,
    timezone_id: Optional[str] = None,
    headless: Optional[bool] = None,
    debug: Optional[bool] = None,
    **launch_options,
) -> BrowserContext:
    """Launch Playwright Firefox with fingerprint spoofing."""
    if os is None:
        os = "macos"
    target_os = os if isinstance(os, str) else os[0]

    # Generate fingerprint
    fp = generate(os=os)
    fp_config = to_config(fp, target_os=target_os, config_overrides=config)

    # Build init script
    init_script = build_init_script(fp_config)

    if debug:
        import json
        print("[weles] Fingerprint config:")
        print(json.dumps(fp_config, indent=2)[:2000])

    # Launch browser
    if headless is None:
        headless = False
    browser = await playwright.firefox.launch(
        headless=headless,
        **launch_options,
    )

    # Build context options from fingerprint
    nav = fp_config.get("navigator", {})
    scr = fp_config.get("screen", {})
    win = fp_config.get("window", {})

    ctx_opts: Dict[str, Any] = {
        "user_agent": nav.get("userAgent"),
        "viewport": {
            "width": win.get("outerWidth", scr.get("width", 1920)),
            "height": win.get("outerHeight", scr.get("height", 1080)) - 80,
        },
        "screen": {
            "width": scr.get("width", 1920),
            "height": scr.get("height", 1080),
        },
        "device_scale_factor": win.get("devicePixelRatio", 1),
    }

    if locale:
        ctx_opts["locale"] = locale if isinstance(locale, str) else locale[0]
    if timezone_id:
        ctx_opts["timezone_id"] = timezone_id
    if proxy:
        ctx_opts["proxy"] = proxy

    context = await browser.new_context(**ctx_opts)
    await context.add_init_script(init_script)

    # Store browser ref for cleanup
    context._weles_browser = browser
    _orig_close = context.close

    async def _close_with_browser():
        await _orig_close()
        await browser.close()

    context.close = _close_with_browser

    return context
