"""Unit tests for weles/capture.py -- Capture class (no real browser)."""

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

from weles.capture import Capture, _recordings_dir, _output_path


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

class TestRecordingsDir:
    def test_creates_directory(self, tmp_path):
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path / "rec")}):
            d = _recordings_dir()
        assert Path(d).exists()

    def test_uses_env_var(self, tmp_path):
        target = str(tmp_path / "custom_recordings")
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": target}):
            d = _recordings_dir()
        assert d == target

    def test_defaults_to_cwd_recordings(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("WELES_RECORDINGS_DIR", raising=False)
        d = _recordings_dir()
        assert d == str(tmp_path / "recordings")


class TestOutputPath:
    def test_returns_string(self, tmp_path):
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            p = _output_path("label", "json")
        assert isinstance(p, str)

    def test_contains_label(self, tmp_path):
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            p = _output_path("my_label", "json")
        assert "my_label" in p

    def test_correct_extension(self, tmp_path):
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            p = _output_path("x", "png")
        assert p.endswith(".png")


# ---------------------------------------------------------------------------
# Capture.__init__
# ---------------------------------------------------------------------------

class TestCaptureInit:
    def _ctx(self):
        return MagicMock()

    def test_default_url_filters(self):
        cap = Capture(self._ctx())
        expected = ["cloudflare", "challenge", "turnstile", "seon", "login"]
        assert cap._url_filters == expected

    def test_custom_url_filters(self):
        cap = Capture(self._ctx(), url_filters=["mysite", "auth"])
        assert cap._url_filters == ["mysite", "auth"]

    def test_console_log_starts_empty(self):
        cap = Capture(self._ctx())
        assert cap.console_log == []

    def test_response_bodies_starts_empty(self):
        cap = Capture(self._ctx())
        assert cap.response_bodies == []

    def test_context_stored(self):
        ctx = self._ctx()
        cap = Capture(ctx)
        assert cap.context is ctx


# ---------------------------------------------------------------------------
# Capture.new_page
# ---------------------------------------------------------------------------

class TestCaptureNewPage:
    @pytest.mark.asyncio
    async def test_creates_page_via_context(self):
        ctx = MagicMock()
        mock_page = MagicMock()
        mock_page.on = MagicMock()
        ctx.new_page = AsyncMock(return_value=mock_page)

        cap = Capture(ctx)
        page = await cap.new_page()

        ctx.new_page.assert_awaited_once()
        assert page is mock_page

    @pytest.mark.asyncio
    async def test_attaches_console_listener(self):
        ctx = MagicMock()
        mock_page = MagicMock()
        mock_page.on = MagicMock()
        ctx.new_page = AsyncMock(return_value=mock_page)

        cap = Capture(ctx)
        await cap.new_page()

        # .on should be called for "console", "pageerror", "response"
        event_names = [c.args[0] for c in mock_page.on.call_args_list]
        assert "console" in event_names
        assert "pageerror" in event_names
        assert "response" in event_names

    @pytest.mark.asyncio
    async def test_page_added_to_pages_list(self):
        ctx = MagicMock()
        mock_page = MagicMock()
        mock_page.on = MagicMock()
        ctx.new_page = AsyncMock(return_value=mock_page)

        cap = Capture(ctx)
        await cap.new_page()
        assert mock_page in cap._pages


# ---------------------------------------------------------------------------
# Capture.save
# ---------------------------------------------------------------------------

class TestCaptureSave:
    def test_save_empty_returns_empty_dict(self, tmp_path):
        ctx = MagicMock()
        cap = Capture(ctx)
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            paths = cap.save()
        assert paths == {}

    def test_save_console_log_creates_file(self, tmp_path):
        ctx = MagicMock()
        cap = Capture(ctx)
        cap.console_log = ["[console.log] Hello", "[console.error] Error"]
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            paths = cap.save("my_session")
        assert "console" in paths
        assert Path(paths["console"]).exists()
        content = Path(paths["console"]).read_text()
        assert "[console.log] Hello" in content

    def test_save_response_bodies_creates_file(self, tmp_path):
        ctx = MagicMock()
        cap = Capture(ctx)
        cap.response_bodies = [{"url": "https://example.com/login", "status": 200}]
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            paths = cap.save()
        assert "responses" in paths
        assert Path(paths["responses"]).exists()


# ---------------------------------------------------------------------------
# Capture.screenshot
# ---------------------------------------------------------------------------

class TestCaptureScreenshot:
    @pytest.mark.asyncio
    async def test_screenshot_calls_page(self, tmp_path):
        ctx = MagicMock()
        cap = Capture(ctx)
        page = MagicMock()
        page.screenshot = AsyncMock()
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            path = await cap.screenshot(page, label="test_shot")
        page.screenshot.assert_awaited_once()
        assert "test_shot" in path

    @pytest.mark.asyncio
    async def test_screenshot_full_page_option(self, tmp_path):
        ctx = MagicMock()
        cap = Capture(ctx)
        page = MagicMock()
        page.screenshot = AsyncMock()
        with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
            await cap.screenshot(page, full_page=True)
        _, kwargs = page.screenshot.call_args
        assert kwargs.get("full_page") is True


# ---------------------------------------------------------------------------
# Capture.run_diagnostics
# ---------------------------------------------------------------------------

class TestCaptureDiagnostics:
    @pytest.mark.asyncio
    async def test_run_diagnostics_returns_dict(self):
        ctx = MagicMock()
        cap = Capture(ctx)
        cap.capture_tls_fingerprint = AsyncMock(return_value={"tls": "data"})
        cap.capture_environment = AsyncMock(return_value={"env": "data"})
        page = MagicMock()
        result = await cap.run_diagnostics(page)
        assert "tls" in result
        assert "environment" in result


# ---------------------------------------------------------------------------
# Capture.extract_frames (static method)
# ---------------------------------------------------------------------------

class TestExtractFrames:
    def test_runs_ffmpeg_command(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock()
            with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
                frames = Capture.extract_frames(str(tmp_path / "video.webm"))
        mock_run.assert_called_once()
        cmd = mock_run.call_args.args[0]
        assert "ffmpeg" in cmd
        assert str(tmp_path / "video.webm") in cmd

    def test_includes_fps_filter(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock()
            with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
                Capture.extract_frames(str(tmp_path / "v.webm"), fps="2")
        cmd = mock_run.call_args.args[0]
        assert "fps=2" in " ".join(cmd)

    def test_includes_start_time(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock()
            with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
                Capture.extract_frames(str(tmp_path / "v.webm"), start="5")
        cmd = mock_run.call_args.args[0]
        assert "-ss" in cmd
        assert "5" in cmd

    def test_includes_end_time(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock()
            with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
                Capture.extract_frames(str(tmp_path / "v.webm"), end="30")
        cmd = mock_run.call_args.args[0]
        assert "-to" in cmd

    def test_returns_list(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock()
            with patch.dict(os.environ, {"WELES_RECORDINGS_DIR": str(tmp_path)}):
                result = Capture.extract_frames(str(tmp_path / "v.webm"))
        assert isinstance(result, list)


# ---------------------------------------------------------------------------
# Capture.get_video_path (static async method)
# ---------------------------------------------------------------------------

class TestGetVideoPath:
    @pytest.mark.asyncio
    async def test_returns_path_when_video_exists(self):
        page = MagicMock()
        video = MagicMock()
        video.path = AsyncMock(return_value="/tmp/video.webm")
        page.video = video
        path = await Capture.get_video_path(page)
        assert path == "/tmp/video.webm"

    @pytest.mark.asyncio
    async def test_returns_none_when_no_video(self):
        page = MagicMock()
        page.video = None
        path = await Capture.get_video_path(page)
        assert path is None
