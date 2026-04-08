"""Async API for Weles browser fingerprint spoofing."""

import json as _json
import os as _os
import tempfile as _tempfile
from typing import Any, Dict, List, Optional, Tuple, Union

from playwright.async_api import (
    BrowserContext,
    Playwright,
    async_playwright,
)

from .fingerprint import generate, to_config, to_cpp_config
from .scripts import build_init_script

# Chromium launch args for anti-detection
_CHROMIUM_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-infobars",
]


class AsyncWeles:
    """Context manager that launches a spoofed Playwright browser.

    Args:
        browser: "firefox" (default) or "chromium".
        All other kwargs are passed to AsyncNewBrowser.
    """

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
    browser: str = "firefox",
    config: Optional[Dict[str, Any]] = None,
    proxy: Optional[Dict[str, str]] = None,
    locale: Optional[Union[str, List[str]]] = None,
    timezone_id: Optional[str] = None,
    headless: Optional[bool] = None,
    debug: Optional[bool] = None,
    user_data_dir: Optional[str] = None,
    record_video: Optional[bool] = None,
    record_har: Optional[bool] = None,
    exclude_scripts: Optional[list] = None,
    **launch_options,
) -> BrowserContext:
    """Launch Playwright Firefox or Chromium with fingerprint spoofing.

    Args:
        playwright: A Playwright instance.
        os: Target OS ("macos", "windows", "linux") or list.
        browser: "firefox" (default) or "chromium".
        config: Optional fingerprint config overrides.
        proxy: Optional proxy dict.
        locale: Optional locale string or list.
        timezone_id: Optional timezone ID.
        headless: Run headless (default False).
        debug: Print fingerprint config to stdout.
        user_data_dir: Optional path for persistent browser context.
        record_video: Record video of browser session.
        record_har: Record HAR network log.
        **launch_options: Extra args passed to browser.launch().
    """
    if os is None:
        os = "macos"
    target_os = os if isinstance(os, str) else os[0]

    # Generate fingerprint
    fp = generate(os=os, browser=browser)
    fp_config = to_config(fp, target_os=target_os, config_overrides=config, browser=browser)

    # Build init script
    init_script = build_init_script(fp_config, exclude=exclude_scripts)

    if debug:
        import json
        print(f"[weles] Browser: {browser}")
        print("[weles] Fingerprint config:")
        print(json.dumps(fp_config, indent=2)[:2000])

    # Launch browser
    if headless is None:
        headless = False

    # Default: record video of every session unless caller explicitly sets
    # record_video=False or sets WELES_DISABLE_RECORDING=1.
    if record_video is None:
        record_video = _os.environ.get("WELES_DISABLE_RECORDING") != "1"

    is_chromium = browser == "chromium"

    # If using custom Chromium build (CHROMIUM_PATH set), write the C++
    # fingerprint config and prepare to pass --weles-fingerprint flag.
    weles_chromium_path = _os.environ.get("CHROMIUM_PATH", "")
    weles_fp_args: List[str] = []
    if is_chromium and weles_chromium_path and _os.path.isfile(weles_chromium_path):
        cpp_config = to_cpp_config(fp_config, target_os=target_os)
        fp_file = _tempfile.NamedTemporaryFile(
            prefix="weles-fp-", suffix=".json", delete=False, mode="w")
        _json.dump(cpp_config, fp_file)
        fp_file.close()
        weles_fp_args = [f"--weles-fingerprint={fp_file.name}"]
        launch_options.setdefault("executable_path", weles_chromium_path)

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
        if is_chromium:
            ctx_opts["ignore_https_errors"] = True
    if record_video:
        from .capture import _recordings_dir, _output_path
        rec_dir = _recordings_dir()
        ctx_opts["record_video_dir"] = rec_dir
        # Bound recordings dir size (default 2 GB, override via env var)
        try:
            from . import prune_recordings
            budget = int(_os.environ.get("WELES_RECORDINGS_MAX_BYTES",
                                         str(2 * 1024 * 1024 * 1024)))
            prune_recordings(rec_dir, budget)
        except Exception:
            pass
    if record_har:
        from .capture import _recordings_dir, _output_path
        ctx_opts["record_har_path"] = _output_path("network", "har")
        ctx_opts["record_har_content"] = "attach"

    if user_data_dir is not None:
        # Persistent context: merge launch options + context options into one call
        persistent_kwargs: Dict[str, Any] = {
            "headless": headless,
            **ctx_opts,
            **launch_options,
        }

        if is_chromium:
            user_args = persistent_kwargs.pop("args", []) or []
            merged_args = list(_CHROMIUM_ARGS) + weles_fp_args + [a for a in user_args if a not in _CHROMIUM_ARGS]
            persistent_kwargs["args"] = merged_args
            context = await playwright.chromium.launch_persistent_context(
                user_data_dir, **persistent_kwargs
            )
        else:
            context = await playwright.firefox.launch_persistent_context(
                user_data_dir, **persistent_kwargs
            )

        await context.add_init_script(init_script)

        # No separate browser object to close; just close the context
        context._weles_browser = None
        return context

    # Non-persistent: launch browser then create context
    if is_chromium:
        # Merge anti-detection args with any user-provided args
        user_args = launch_options.pop("args", []) or []
        merged_args = list(_CHROMIUM_ARGS) + weles_fp_args + [a for a in user_args if a not in _CHROMIUM_ARGS]
        pw_browser = await playwright.chromium.launch(
            headless=headless,
            args=merged_args,
            **launch_options,
        )
    else:
        pw_browser = await playwright.firefox.launch(
            headless=headless,
            **launch_options,
        )

    context = await pw_browser.new_context(**ctx_opts)
    await context.add_init_script(init_script)

    # Store browser ref for cleanup
    context._weles_browser = pw_browser
    _orig_close = context.close

    async def _close_with_browser():
        await _orig_close()
        await pw_browser.close()

    context.close = _close_with_browser

    return context
