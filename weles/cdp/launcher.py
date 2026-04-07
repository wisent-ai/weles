"""Launch a Chromium subprocess and return the CDP WebSocket URL."""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from typing import List, Optional, Tuple


class _launcher_config:
    """Launcher configuration values."""

    chromium_path_env = "CHROMIUM_PATH"
    ws_listen_prefix = "DevTools listening on ws://"
    stderr_line_timeout_s = 2
    launch_timeout_s = 30
    temp_dir_prefix = "weles-chrome-"

    default_args = [
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-sandbox",
        "--ignore-certificate-errors",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
    ]

    system_candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]

    which_names = ["google-chrome", "chromium", "chromium-browser"]


def _find_chromium() -> str:
    """Find a usable Chromium/Chrome binary."""
    env_path = os.environ.get(_launcher_config.chromium_path_env)
    if env_path and os.path.isfile(env_path):
        return env_path

    for path in _launcher_config.system_candidates:
        if os.path.isfile(path):
            return path

    for name in _launcher_config.which_names:
        found = shutil.which(name)
        if found:
            return found

    raise FileNotFoundError(
        "No Chromium binary found. Set CHROMIUM_PATH or install Google Chrome.")


async def launch_chromium(
    *,
    headless: bool = False,
    args: Optional[List[str]] = None,
    user_data_dir: Optional[str] = None,
    proxy_server: Optional[str] = None,
    chromium_path: Optional[str] = None,
    fingerprint_config_path: Optional[str] = None,
) -> Tuple[asyncio.subprocess.Process, str]:
    """Launch Chromium and return (process, ws_url).

    Parses the DevTools WebSocket URL from stderr.
    """
    binary = chromium_path or _find_chromium()
    cmd = [binary] + list(_launcher_config.default_args)

    if args:
        cmd.extend(args)
    if headless:
        cmd.append("--headless=new")
    if user_data_dir:
        cmd.append(f"--user-data-dir={user_data_dir}")
    else:
        tmp_dir = tempfile.mkdtemp(prefix=_launcher_config.temp_dir_prefix)
        cmd.append(f"--user-data-dir={tmp_dir}")
    if proxy_server:
        cmd.append(f"--proxy-server={proxy_server}")
    if fingerprint_config_path:
        cmd.append(f"--weles-fingerprint={fingerprint_config_path}")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )

    ws_url = await _read_ws_url(proc)
    return proc, ws_url


async def _read_ws_url(proc: asyncio.subprocess.Process) -> str:
    """Read stderr until we find the WebSocket URL."""
    assert proc.stderr is not None
    loop = asyncio.get_event_loop()
    deadline = loop.time() + _launcher_config.launch_timeout_s

    while loop.time() < deadline:
        remaining = deadline - loop.time()
        line_timeout = min(_launcher_config.stderr_line_timeout_s, remaining)
        try:
            line = await asyncio.wait_for(
                proc.stderr.readline(), timeout=line_timeout)
        except asyncio.TimeoutError:
            continue

        if not line:
            break

        decoded = line.decode("utf-8", errors="replace").strip()
        if _launcher_config.ws_listen_prefix in decoded:
            ws_url = decoded.split("DevTools listening on ")[-1].strip()
            return ws_url

    raise RuntimeError("Failed to get WebSocket URL from Chromium stderr")
