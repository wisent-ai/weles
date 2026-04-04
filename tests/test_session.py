"""Unit tests for weles/session/store.py -- SessionStore."""

import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from weles.session.store import SessionStore, _SESSION_KEYWORDS, _LOGIN_PATHS


# ---------------------------------------------------------------------------
# Basic save / load
# ---------------------------------------------------------------------------

class TestSessionStoreSaveLoad:
    def test_save_and_load(self):
        store = SessionStore()
        cookies = [{"name": "session_id", "value": "abc123", "domain": ".example.com"}]
        store.save_cookies("user1", cookies)
        loaded = store.load_cookies("user1")
        assert loaded == cookies

    def test_load_missing_label_returns_none(self):
        store = SessionStore()
        assert store.load_cookies("nonexistent") is None

    def test_overwrite_existing_label(self):
        store = SessionStore()
        store.save_cookies("u", [{"name": "a", "value": "1"}])
        store.save_cookies("u", [{"name": "b", "value": "2"}])
        loaded = store.load_cookies("u")
        assert loaded[0]["name"] == "b"

    def test_labels_returns_all(self):
        store = SessionStore()
        store.save_cookies("user1", [])
        store.save_cookies("user2", [])
        assert set(store.labels()) == {"user1", "user2"}

    def test_labels_empty_initially(self):
        store = SessionStore()
        assert store.labels() == []


# ---------------------------------------------------------------------------
# has_session / session_cookies
# ---------------------------------------------------------------------------

class TestHasSession:
    @pytest.mark.parametrize("name", _SESSION_KEYWORDS)
    def test_session_keyword_detected(self, name):
        store = SessionStore()
        cookies = [{"name": name, "value": "x"}]
        assert store.has_session(cookies) is True

    def test_no_session_cookies(self):
        store = SessionStore()
        cookies = [{"name": "ga", "value": "x"}, {"name": "fbpixel", "value": "y"}]
        assert store.has_session(cookies) is False

    def test_tracking_cookie_excluded(self):
        store = SessionStore()
        # "session_tracking" contains "session" but also "tracking" -- should be excluded
        cookies = [{"name": "session_tracking", "value": "x"}]
        assert store.has_session(cookies) is False

    def test_empty_cookies(self):
        store = SessionStore()
        assert store.has_session([]) is False

    def test_mixed_cookies(self):
        store = SessionStore()
        cookies = [
            {"name": "ga", "value": "x"},
            {"name": "auth_token", "value": "y"},
        ]
        assert store.has_session(cookies) is True


class TestSessionCookies:
    def test_filters_non_session(self):
        store = SessionStore()
        cookies = [
            {"name": "auth_token", "value": "abc"},
            {"name": "ga", "value": "xyz"},
            {"name": "fbclid", "value": "123"},
        ]
        filtered = store.session_cookies(cookies)
        assert len(filtered) == 1
        assert filtered[0]["name"] == "auth_token"

    def test_excludes_tracking(self):
        store = SessionStore()
        cookies = [{"name": "session_tracking", "value": "x"}]
        assert store.session_cookies(cookies) == []

    def test_empty_list(self):
        store = SessionStore()
        assert store.session_cookies([]) == []

    def test_all_session_cookies(self):
        store = SessionStore()
        cookies = [{"name": kw, "value": "v"} for kw in _SESSION_KEYWORDS]
        filtered = store.session_cookies(cookies)
        assert len(filtered) == len(_SESSION_KEYWORDS)


# ---------------------------------------------------------------------------
# clear()
# ---------------------------------------------------------------------------

class TestClear:
    def test_clear_specific_label(self):
        store = SessionStore()
        store.save_cookies("a", [{"name": "x"}])
        store.save_cookies("b", [{"name": "y"}])
        store.clear("a")
        assert store.load_cookies("a") is None
        assert store.load_cookies("b") is not None

    def test_clear_all(self):
        store = SessionStore()
        store.save_cookies("a", [])
        store.save_cookies("b", [])
        store.clear()
        assert store.labels() == []

    def test_clear_nonexistent_label_noop(self):
        store = SessionStore()
        store.save_cookies("a", [])
        store.clear("nonexistent")
        assert store.load_cookies("a") is not None


# ---------------------------------------------------------------------------
# Persistence (file-based)
# ---------------------------------------------------------------------------

class TestPersistence:
    def test_saves_to_file(self, tmp_path):
        p = str(tmp_path / "cookies.json")
        store = SessionStore(persist_path=p)
        store.save_cookies("u", [{"name": "session", "value": "abc"}])
        assert Path(p).exists()
        data = json.loads(Path(p).read_text())
        assert "u" in data

    def test_loads_from_existing_file(self, tmp_path):
        p = str(tmp_path / "cookies.json")
        # Write data manually
        Path(p).write_text(json.dumps({"u": [{"name": "jwt", "value": "tok"}]}))
        store = SessionStore(persist_path=p)
        assert store.load_cookies("u") is not None
        assert store.load_cookies("u")[0]["name"] == "jwt"

    def test_corrupt_file_ignored(self, tmp_path):
        p = str(tmp_path / "corrupt.json")
        Path(p).write_text("NOT VALID JSON{{{")
        # Should not raise
        store = SessionStore(persist_path=p)
        assert store.labels() == []

    def test_no_persist_path_no_file(self, tmp_path):
        store = SessionStore()
        store.save_cookies("u", [])
        # No file should have been written in tmp_path


# ---------------------------------------------------------------------------
# inject / capture (async, with mocked context)
# ---------------------------------------------------------------------------

class TestInject:
    @pytest.mark.asyncio
    async def test_inject_returns_true_when_cookies_exist(self):
        store = SessionStore()
        store.save_cookies("u", [{"name": "session", "value": "abc"}])
        ctx = MagicMock()
        ctx.add_cookies = AsyncMock()
        result = await store.inject(ctx, "u")
        assert result is True
        ctx.add_cookies.assert_called_once()

    @pytest.mark.asyncio
    async def test_inject_returns_false_when_no_cookies(self):
        store = SessionStore()
        ctx = MagicMock()
        ctx.add_cookies = AsyncMock()
        result = await store.inject(ctx, "nonexistent")
        assert result is False
        ctx.add_cookies.assert_not_called()


class TestCapture:
    @pytest.mark.asyncio
    async def test_capture_saves_cookies(self):
        store = SessionStore()
        cookies = [{"name": "auth", "value": "token123"}]
        ctx = MagicMock()
        ctx.cookies = AsyncMock(return_value=cookies)
        result = await store.capture(ctx, "u")
        assert result == cookies
        assert store.load_cookies("u") == cookies

    @pytest.mark.asyncio
    async def test_capture_empty_does_not_save(self):
        store = SessionStore()
        ctx = MagicMock()
        ctx.cookies = AsyncMock(return_value=[])
        await store.capture(ctx, "u")
        assert store.load_cookies("u") is None


# ---------------------------------------------------------------------------
# is_login_page
# ---------------------------------------------------------------------------

class TestIsLoginPage:
    @pytest.mark.parametrize("path", _LOGIN_PATHS)
    def test_login_paths_detected(self, path):
        url = f"https://example.com{path}"
        assert SessionStore.is_login_page(url) is True

    def test_non_login_page(self):
        assert SessionStore.is_login_page("https://example.com/dashboard") is False

    def test_home_page(self):
        assert SessionStore.is_login_page("https://example.com/") is False

    def test_case_insensitive(self):
        assert SessionStore.is_login_page("https://example.com/Login") is True

    def test_partial_match(self):
        assert SessionStore.is_login_page("https://example.com/user/login/step2") is True
