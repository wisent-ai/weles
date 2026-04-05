"""Launch Chromium and discover the DevTools WebSocket URL."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

from .errors import CDPError

logger = logging.getLogger(__name__)


def _find_chromium_binary(chromium_path: Optional[str] = None) -> str:
    """Locate a Chromium/Chrome binary on the system.

    Search order:
        1. Explicit chromium_path argument
        2. CHROMIUM_PATH environment variable
        3. Common system paths (platform-dependent)
        4. Playwright's bundled chromium in ~/.cache/ms-playwright/

    Returns:
        Absolute path to the Chromium binary.

    Raises:
        CDPError: If no binary can be found.
    """
    # 1. Explicit path
    if chromium_path:
        if os.path.isfile(chromium_path) and os.access(chromium_path, os.X_OK):
            return chromium_path
        raise CDPError(f"Chromium binary not found at: {chromium_path}")

    # 2. Environment variable
    env_path = os.environ.get("CHROMIUM_PATH")
    if env_path and os.path.isfile(env_path) and os.access(env_path, os.X_OK):
        return env_path

    # 3. System paths
    system = platform.system()
    candidates: List[str] = []

    if system == "Darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
    elif system == "Linux":
        candidates = [
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
        ]
    elif system == "Windows":
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        program_files = os.environ.get("PROGRAMFILES", "C:\\Program Files")
        program_files_x86 = os.environ.get("PROGRAMFILES(X86)", "C:\\Program Files (x86)")
        candidates = [
            os.path.join(local_app_data, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(program_files, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(program_files_x86, "Google", "Chrome", "Application", "chrome.exe"),
        ]

    # Also check PATH via shutil.which
    for name in ("chromium-browser", "chromium", "google-chrome", "google-chrome-stable"):
        which = shutil.which(name)
        if which:
            candidates.append(which)

    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path

    # 4. Playwright bundled chromium
    pw_path = _find_playwright_chromium()
    if pw_path:
        return pw_path

    raise CDPError(
        "Could not find a Chromium binary. Set CHROMIUM_PATH or install Chrome/Chromium."
    )


def _find_playwright_chromium() -> Optional[str]:
    """Search for Playwright's bundled Chromium in ~/.cache/ms-playwright/."""
    cache_dir = Path.home() / ".cache" / "ms-playwright"
    if not cache_dir.is_dir():
        return None

    system = platform.system()

    # Find chromium-* directories, sorted descending so newest version is first
    chromium_dirs = sorted(
        [d for d in cache_dir.iterdir() if d.is_dir() and d.name.startswith("chromium")],
        reverse=True,
    )

    for chromium_dir in chromium_dirs:
        if system == "Darwin":
            binary = chromium_dir / "chrome-mac" / "Chromium.app" / "Contents" / "MacOS" / "Chromium"
        elif system == "Linux":
            binary = chromium_dir / "chrome-linux" / "chrome"
        else:
            binary = chromium_dir / "chrome-win" / "chrome.exe"

        if binary.is_file() and os.access(str(binary), os.X_OK):
            return str(binary)

    return None


def _build_launch_args(
    headless: bool,
    user_data_dir: Optional[str],
    proxy_server: Optional[str],
    extra_args: Optional[List[str]],
) -> Tuple[List[str], Optional[str]]:
    """Build the list of Chrome CLI arguments.

    Returns:
        (args_list, actual_user_data_dir) where actual_user_data_dir is the
        temp dir created if none was specified (caller must clean up).
    """
    args = [
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-sandbox",
        "--ignore-certificate-errors",
    ]

    if headless:
        args.append("--window-position=-9999,-9999")
        args.append("--window-size=1,1")

    temp_dir = None
    if user_data_dir:
        args.append(f"--user-data-dir={user_data_dir}")
    else:
        temp_dir = tempfile.mkdtemp(prefix="weles-cdp-")
        args.append(f"--user-data-dir={temp_dir}")

    if proxy_server:
        args.append(f"--proxy-server={proxy_server}")

    if extra_args:
        args.extend(extra_args)

    return args, temp_dir


async def _read_ws_url_from_stderr(proc: asyncio.subprocess.Process) -> str:
    """Read Chrome's stderr until the DevTools WebSocket URL appears.

    Chrome prints a line like:
        DevTools listening on ws://127.0.0.1:PORT/devtools/browser/UUID

    Raises:
        CDPError: If stderr closes before the URL is found.
    """
    while True:
        line = await proc.stderr.readline()
        if not line:
            raise CDPError(
                "Chromium process exited before printing the DevTools WebSocket URL"
            )
        decoded = line.decode("utf-8", errors="replace").strip()
        logger.debug("Chrome stderr: %s", decoded)
        if "DevTools listening on " in decoded:
            ws_url = decoded.split("DevTools listening on ", 1)[1].strip()
            return ws_url


async def launch_chromium(
    headless: bool = False,
    args: Optional[List[str]] = None,
    user_data_dir: Optional[str] = None,
    proxy_server: Optional[str] = None,
    chromium_path: Optional[str] = None,
) -> Tuple[asyncio.subprocess.Process, str]:
    """Launch a Chromium process with remote debugging enabled.

    Args:
        headless: Run in headless mode (--headless=new).
        args: Additional CLI flags to pass to Chromium.
        user_data_dir: Path to a user data directory. A temp dir is created if None.
        proxy_server: Proxy server URL (e.g. "http://host:port").
        chromium_path: Explicit path to the Chromium binary.

    Returns:
        (process, ws_url) tuple. The ws_url can be passed to CDPConnection.connect().

    Raises:
        CDPError: If Chromium cannot be found or fails to start.
    """
    binary = _find_chromium_binary(chromium_path)
    launch_args, temp_dir = _build_launch_args(headless, user_data_dir, proxy_server, args)

    cmd = [binary] + launch_args
    logger.info("Launching Chromium: %s", " ".join(cmd[:3]) + " ...")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stderr=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
        )
    except OSError as exc:
        raise CDPError(f"Failed to launch Chromium at {binary}: {exc}") from exc

    try:
        ws_url = await _read_ws_url_from_stderr(proc)
    except CDPError:
        proc.kill()
        raise

    # Stash the temp dir on the process object so callers can clean it up
    proc._weles_temp_dir = temp_dir  # type: ignore[attr-defined]

    return proc, ws_url
