"""CDP screencast-based video recording.

Uses Page.startScreencast to capture PNG frames, then stitches them into
a .webm video with ffmpeg when recording stops.
"""

from __future__ import annotations

import base64
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ..connection import CDPConnection

logger = logging.getLogger(__name__)


class CDPVideo:
    """Playwright-compatible video handle. Exposes path() for the final video."""

    def __init__(self):
        self._path: Optional[str] = None
        self._ready = False

    async def path(self) -> Optional[str]:
        """Return the path to the .webm video file, or None if not yet ready."""
        return self._path

    def _set_path(self, path: str):
        self._path = path
        self._ready = True


class CDPScreencast:
    """Captures screencast frames from CDP and stitches them into video.

    Lifecycle:
        1. start() -- begins receiving frames from Page.startScreencast
        2. stop()  -- ends capture, stitches PNGs into .webm via ffmpeg
        3. video   -- CDPVideo handle whose path() returns the output file
    """

    def __init__(
        self,
        connection: CDPConnection,
        session_id: str,
        *,
        output_dir: Optional[str] = None,
        every_nth_frame: int = 2,
    ):
        self._conn = connection
        self._sid = session_id
        self._every_nth = every_nth_frame
        self._frame_dir = tempfile.mkdtemp(prefix="weles_screencast_")
        self._output_dir = output_dir or tempfile.mkdtemp(prefix="weles_video_")
        self._frame_count = 0
        self._started = False
        self._stopped = False
        self.video = CDPVideo()
        self._listener_ref = self._on_frame

    async def start(self):
        """Begin capturing screencast frames."""
        if self._started:
            return
        self._started = True
        self._conn.on("Page.screencastFrame", self._listener_ref, self._sid)
        await self._conn.send("Page.startScreencast", {
            "format": "png",
            "everyNthFrame": self._every_nth,
        }, session_id=self._sid)
        logger.debug("Screencast started (frames -> %s)", self._frame_dir)

    def _on_frame(self, params: dict):
        """Handle an incoming screencast frame: save PNG and ack (non-blocking)."""
        import asyncio
        frame_session_id = params.get("sessionId", 0)
        data = params.get("data", "")
        if not data:
            return
        self._frame_count += 1
        frame_path = os.path.join(
            self._frame_dir, f"frame_{self._frame_count:06d}.png"
        )
        with open(frame_path, "wb") as f:
            f.write(base64.b64decode(data))
        # Fire-and-forget ack to avoid deadlocking the read loop
        asyncio.ensure_future(self._ack(frame_session_id))

    async def _ack(self, frame_session_id):
        try:
            await self._conn.send("Page.screencastFrameAck", {
                "sessionId": frame_session_id,
            }, session_id=self._sid)
        except Exception:
            logger.debug("Failed to ack screencast frame %d", self._frame_count)

    async def stop(self) -> Optional[str]:
        """Stop capturing and stitch frames into a .webm video.

        Returns the path to the output video, or None if no frames were captured.
        """
        if self._stopped:
            return self.video._path
        self._stopped = True
        try:
            await self._conn.send(
                "Page.stopScreencast", session_id=self._sid,
            )
        except Exception:
            logger.debug("Page.stopScreencast failed (target may be closed)")
        self._conn.off("Page.screencastFrame", self._listener_ref, self._sid)
        if self._frame_count == 0:
            logger.debug("Screencast: no frames captured, skipping stitch")
            return None
        video_path = self._stitch()
        self.video._set_path(video_path)
        return video_path

    def _stitch(self) -> str:
        """Stitch captured PNG frames into a .webm video using ffmpeg."""
        os.makedirs(self._output_dir, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(self._output_dir, f"screencast_{ts}.webm")
        pattern = os.path.join(self._frame_dir, "frame_%06d.png")
        cmd = [
            "ffmpeg", "-y",
            "-framerate", "5",
            "-i", pattern,
            "-c:v", "libvpx",
            "-pix_fmt", "yuv420p",
            "-b:v", "1M",
            output_path,
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")[:500]
            logger.warning("ffmpeg stitch failed (rc=%d): %s", result.returncode, stderr)
            return ""
        logger.info(
            "Screencast: %d frames -> %s", self._frame_count, output_path,
        )
        return output_path

    def cleanup_frames(self):
        """Remove the temporary frame directory."""
        try:
            for f in Path(self._frame_dir).glob("frame_*.png"):
                f.unlink()
            os.rmdir(self._frame_dir)
        except Exception:
            logger.debug("Failed to clean up frame dir %s", self._frame_dir)
