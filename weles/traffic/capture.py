"""Traffic fingerprint capture via mitmdump.

Justification: Provides the ``TrafficCapture`` class that launches mitmdump
as a subprocess with the companion addon (addon.py), collects the resulting
JSON data, and offers save/load helpers.  This is the main entry point for
recording a browser session's full network fingerprint.

Usage (automated):
    tc = TrafficCapture()
    tc.start(port=8090)
    async with CDPWeles(os="macos", proxy={"server": tc.proxy_url}) as ctx:
        page = await ctx.new_page()
        await page.goto("https://example.com")
    tc.stop()
    tc.save("automated_capture.json")

Usage (real browser):
    tc = TrafficCapture()
    tc.start(port=8080)
    print(f"Configure your browser to use proxy {tc.proxy_url}")
    input("Press Enter when done...")
    tc.stop()
    tc.save("real_capture.json")
"""

import json
import os
import signal
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .config import (
    CAPTURE_PATH_ENV,
    DEFAULT_PROXY_PORT,
    MITMDUMP_BINARY,
    MITMDUMP_STARTUP_TIMEOUT_S,
)

_addon_script = str(Path(__file__).parent / "addon.py")


def _wait_for_port(port, deadline_mono):
    """Block until a TCP port accepts connections or deadline is reached."""
    while time.monotonic() < deadline_mono:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            remaining = max(0.05, deadline_mono - time.monotonic())
            sock.settimeout(remaining)
            sock.connect(("127.0.0.1", port))
            return True
        except OSError:
            continue
        finally:
            sock.close()
    return False


def _terminate_process(proc):
    """Send SIGINT then wait, falling back to SIGKILL if needed."""
    try:
        proc.send_signal(signal.SIGINT)
        proc.wait()
    except (ProcessLookupError, OSError):
        pass
    if proc.poll() is None:
        proc.kill()
        proc.wait()


class TrafficCapture:
    """Manages a mitmdump proxy session for traffic fingerprint capture.

    Attributes:
        port: The port mitmdump listens on.
        data: The captured data dict (populated after ``stop()``).
    """

    def __init__(self):
        self._port: int = DEFAULT_PROXY_PORT
        self._process: Optional[subprocess.Popen] = None
        self._capture_file: Optional[str] = None
        self.data: Optional[Dict[str, Any]] = None

    # -- Lifecycle -----------------------------------------------------------

    def start(self, port: int = DEFAULT_PROXY_PORT) -> None:
        """Launch mitmdump with the capture addon.

        Args:
            port: TCP port for the proxy to listen on.

        Raises:
            RuntimeError: If mitmdump fails to start or the binary is missing.
        """
        if self._process is not None:
            raise RuntimeError("Capture already running — call stop() first")

        self._port = port

        # Create a temp file for the addon to write captured data into.
        fd, self._capture_file = tempfile.mkstemp(
            prefix="weles_capture_", suffix=".json",
        )
        os.close(fd)

        env = os.environ.copy()
        env[CAPTURE_PATH_ENV] = self._capture_file

        cmd = [
            MITMDUMP_BINARY,
            "--listen-port", str(port),
            "--set", "stream_large_bodies=1m",
            "-s", _addon_script,
            "--quiet",
        ]

        try:
            self._process = subprocess.Popen(
                cmd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            raise RuntimeError(
                f"mitmdump not found at {MITMDUMP_BINARY}. "
                "Install mitmproxy: brew install mitmproxy"
            )

        # Check it didn't die immediately.
        if self._process.poll() is not None:
            stderr = self._process.stderr.read().decode(errors="replace")
            raise RuntimeError(f"mitmdump exited immediately: {stderr}")

        # Wait for the port to accept connections.
        deadline = time.monotonic() + MITMDUMP_STARTUP_TIMEOUT_S
        if not _wait_for_port(port, deadline):
            self.stop()
            raise RuntimeError(
                f"mitmdump did not start listening on port {port} "
                f"within {MITMDUMP_STARTUP_TIMEOUT_S}s"
            )

    def stop(self) -> Dict[str, Any]:
        """Stop mitmdump and read the captured data.

        Returns:
            The captured data dict (also stored in ``self.data``).
        """
        if self._process is None:
            return self.data or {}

        _terminate_process(self._process)
        self._process = None

        # Read the captured JSON.
        if self._capture_file and os.path.exists(self._capture_file):
            try:
                with open(self._capture_file) as f:
                    self.data = json.load(f)
            except (json.JSONDecodeError, OSError):
                self.data = {}
            finally:
                try:
                    os.unlink(self._capture_file)
                except OSError:
                    pass
        else:
            self.data = {}

        return self.data

    # -- Persistence ---------------------------------------------------------

    def save(self, path: str) -> None:
        """Write the captured data to a JSON file.

        Args:
            path: File path to write to.

        Raises:
            RuntimeError: If no data has been captured yet.
        """
        if self.data is None:
            raise RuntimeError("No capture data — call stop() first")
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            json.dump(self.data, f, indent=2, default=str)

    @staticmethod
    def load(path: str) -> Dict[str, Any]:
        """Load a previously saved capture from a JSON file.

        Args:
            path: File path to read from.

        Returns:
            The capture data dict.
        """
        with open(path) as f:
            return json.load(f)

    # -- Helpers -------------------------------------------------------------

    @property
    def proxy_url(self) -> str:
        """Proxy URL suitable for passing to browser proxy config."""
        return f"http://localhost:{self._port}"

    @property
    def running(self) -> bool:
        """Whether the mitmdump process is currently alive."""
        return self._process is not None and self._process.poll() is None

    def __repr__(self) -> str:
        state = "running" if self.running else "stopped"
        return f"TrafficCapture(port={self._port}, {state})"

    # -- Context manager -----------------------------------------------------

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()
