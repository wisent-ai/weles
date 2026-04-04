"""Fingerprint generation and conversion to JS-ready config."""

import random
from typing import Any, Dict, List, Optional, Tuple, Union

from browserforge.fingerprints import Fingerprint, FingerprintGenerator, Screen


_OS_MAP = {"macos": "macos", "windows": "windows", "linux": "linux"}
_PLATFORM_MAP = {"macos": "MacIntel", "windows": "Win32", "linux": "Linux x86_64"}
_OSCPU_MAP = {
    "macos": "Intel Mac OS X 10.15",
    "windows": "Windows NT 10.0; Win64; x64",
    "linux": "Linux x86_64",
}


def generate(
    os: Optional[Union[str, List[str]]] = None,
    screen: Optional[Screen] = None,
    window: Optional[Tuple[int, int]] = None,
    browser: str = "firefox",
) -> Fingerprint:
    """Generate a fingerprint via browserforge.

    Args:
        os: Target OS ("macos", "windows", "linux") or list to pick from.
        screen: Optional screen constraints.
        window: Optional window size tuple.
        browser: "firefox" (default) or "chromium".
    """
    if os is None:
        os = random.choice(["macos", "windows", "linux"])
    elif isinstance(os, list):
        os = random.choice(os)
    os = _OS_MAP.get(os, os)
    # browserforge uses "chrome" not "chromium"
    bf_browser = "chrome" if browser == "chromium" else "firefox"
    gen = FingerprintGenerator(browser=bf_browser, os=os)
    return gen.generate(screen=screen)


def to_config(
    fp: Fingerprint,
    target_os: str = "macos",
    config_overrides: Optional[Dict[str, Any]] = None,
    browser: str = "firefox",
) -> Dict[str, Any]:
    """Convert a browserforge Fingerprint to a JS-ready config dict.

    Args:
        fp: The generated Fingerprint object.
        target_os: Target OS string.
        config_overrides: Optional dict of overrides to deep-merge.
        browser: "firefox" (default) or "chromium".
    """
    nav = fp.navigator
    scr = fp.screen
    is_chromium = browser == "chromium"

    ua = nav.userAgent
    platform = _PLATFORM_MAP.get(target_os, "MacIntel")

    nav_config: Dict[str, Any] = {
        "userAgent": ua,
        "platform": platform,
        "language": "en-US",
        "languages": ["en-US"],
        "hardwareConcurrency": nav.hardwareConcurrency or 8,
        "maxTouchPoints": nav.maxTouchPoints or 0,
        "doNotTrack": "unspecified",
    }

    if is_chromium:
        # Chromium-specific navigator values
        nav_config["appVersion"] = ua.replace("Mozilla/", "") if ua.startswith("Mozilla/") else ua
        nav_config["vendor"] = "Google Inc."
        nav_config["product"] = "Gecko"  # Chrome reports "Gecko" for product
        nav_config["productSub"] = "20030107"
        # Chromium has deviceMemory; pick a realistic value
        nav_config["deviceMemory"] = random.choice([4, 8, 8, 16])
        nav_config["pdfViewerEnabled"] = True
        # Chromium does NOT expose oscpu or buildID
    else:
        # Firefox-specific navigator values
        oscpu = _OSCPU_MAP.get(target_os, "Intel Mac OS X 10.15")
        ff_version = "135.0"
        if "Firefox/" in ua:
            ff_version = ua.split("Firefox/")[-1]
        nav_config["appVersion"] = nav.appVersion if hasattr(nav, "appVersion") else f"5.0 ({platform})"
        nav_config["vendor"] = ""
        nav_config["product"] = "Gecko"
        nav_config["productSub"] = "20100101"
        nav_config["oscpu"] = oscpu
        nav_config["buildID"] = "20250203212511"

    webgl_vendor = "Google Inc." if is_chromium else "Mozilla"

    config: Dict[str, Any] = {
        "browser": browser,  # Pass browser type to JS scripts
        "navigator": nav_config,
        "screen": {
            "width": scr.width if scr else 1920,
            "height": scr.height if scr else 1080,
            "availWidth": scr.availWidth if scr and hasattr(scr, "availWidth") else (scr.width if scr else 1920),
            "availHeight": scr.availHeight if scr and hasattr(scr, "availHeight") else (scr.height - 25 if scr else 1055),
            "colorDepth": scr.colorDepth if scr and hasattr(scr, "colorDepth") else 24,
            "pixelDepth": scr.pixelDepth if scr and hasattr(scr, "pixelDepth") else 24,
        },
        "window": {
            "devicePixelRatio": fp.screen.devicePixelRatio if scr and hasattr(scr, "devicePixelRatio") else 1,
            "outerWidth": scr.width if scr else 1920,
            "outerHeight": scr.height if scr else 1080,
        },
        "webgl": {
            "vendor": webgl_vendor,
            "renderer": _default_webgl_renderer(target_os),
            "unmaskedVendor": _default_webgl_unmasked_vendor(target_os),
            "unmaskedRenderer": _default_webgl_renderer(target_os),
        },
        "canvas": {"noiseSeed": random.randint(1, 2**31)},
        "audio": {"noiseSeed": random.randint(1, 2**31)},
        "fonts": _default_fonts(target_os),
    }

    if config_overrides:
        _deep_merge(config, config_overrides)

    return config


def _default_webgl_renderer(os: str) -> str:
    renderers = {
        "macos": "Apple M1, or similar",
        "windows": "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)",
        "linux": "Mesa Intel(R) UHD Graphics 630",
    }
    return renderers.get(os, renderers["macos"])


def _default_webgl_unmasked_vendor(os: str) -> str:
    vendors = {"macos": "Apple", "windows": "Google Inc. (Intel)", "linux": "Intel"}
    return vendors.get(os, vendors["macos"])


def _default_fonts(os: str) -> List[str]:
    base = ["Arial", "Courier New", "Georgia", "Helvetica", "Times New Roman", "Verdana"]
    if os == "macos":
        base += ["Menlo", "SF Pro", "Helvetica Neue"]
    elif os == "windows":
        base += ["Segoe UI", "Consolas", "Calibri"]
    return base


def _deep_merge(target: dict, source: dict) -> None:
    for k, v in source.items():
        if k in target and isinstance(target[k], dict) and isinstance(v, dict):
            _deep_merge(target[k], v)
        else:
            target[k] = v
