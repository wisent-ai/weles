"""Unit tests for weles/async_api.py and weles/sync_api.py.

Most tests use mocked Playwright objects to avoid launching a real browser.
Tests that require a real browser are marked @pytest.mark.browser.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call

from weles.async_api import AsyncWeles, AsyncNewBrowser, _CHROMIUM_ARGS as ASYNC_CHROMIUM_ARGS
from weles.sync_api import Weles, NewBrowser, _CHROMIUM_ARGS as SYNC_CHROMIUM_ARGS


# ---------------------------------------------------------------------------
# Shared mock builder
# ---------------------------------------------------------------------------

def _mock_context():
    ctx = MagicMock()
    ctx.add_init_script = AsyncMock()
    ctx.close = AsyncMock()
    ctx._weles_browser = None
    return ctx


def _mock_browser(context=None):
    browser = MagicMock()
    ctx = context or _mock_context()
    browser.new_context = AsyncMock(return_value=ctx)
    browser.close = AsyncMock()
    return browser, ctx


def _mock_playwright(context=None):
    pw = MagicMock()
    browser, ctx = _mock_browser(context)
    pw.firefox.launch = AsyncMock(return_value=browser)
    pw.chromium.launch = AsyncMock(return_value=browser)
    pw.firefox.launch_persistent_context = AsyncMock(return_value=ctx)
    pw.chromium.launch_persistent_context = AsyncMock(return_value=ctx)
    return pw, browser, ctx


def _mock_sync_playwright(context=None):
    pw = MagicMock()
    ctx = context or MagicMock()
    ctx.add_init_script = MagicMock()

    browser = MagicMock()
    browser.new_context = MagicMock(return_value=ctx)
    browser.close = MagicMock()

    pw.firefox.launch = MagicMock(return_value=browser)
    pw.chromium.launch = MagicMock(return_value=browser)
    pw.firefox.launch_persistent_context = MagicMock(return_value=ctx)
    pw.chromium.launch_persistent_context = MagicMock(return_value=ctx)
    return pw, browser, ctx


# ---------------------------------------------------------------------------
# AsyncWeles
# ---------------------------------------------------------------------------

class TestAsyncWelesInit:
    def test_stores_kwargs(self):
        w = AsyncWeles(os="windows", browser="firefox", headless=True)
        assert w.kwargs == {"os": "windows", "browser": "firefox", "headless": True}

    def test_context_starts_none(self):
        w = AsyncWeles()
        assert w._context is None

    def test_pw_starts_none(self):
        w = AsyncWeles()
        assert w._pw is None

    def test_empty_kwargs(self):
        w = AsyncWeles()
        assert w.kwargs == {}


# ---------------------------------------------------------------------------
# Weles (sync)
# ---------------------------------------------------------------------------

class TestWelesInit:
    def test_stores_kwargs(self):
        w = Weles(os="macos", browser="chromium")
        assert w.kwargs == {"os": "macos", "browser": "chromium"}

    def test_context_starts_none(self):
        w = Weles()
        assert w._context is None

    def test_pw_starts_none(self):
        w = Weles()
        assert w._pw is None


# ---------------------------------------------------------------------------
# AsyncNewBrowser -- parameter handling (mocked Playwright)
# ---------------------------------------------------------------------------

class TestAsyncNewBrowserParams:
    @pytest.mark.asyncio
    async def test_firefox_launch_called(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True)
        pw.firefox.launch.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_chromium_launch_called(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="chromium", headless=True)
        pw.chromium.launch.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_headless_false_by_default(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox")
        _, kwargs = pw.firefox.launch.call_args
        assert kwargs.get("headless") is False

    @pytest.mark.asyncio
    async def test_headless_true_when_specified(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True)
        _, kwargs = pw.firefox.launch.call_args
        assert kwargs.get("headless") is True

    @pytest.mark.asyncio
    async def test_init_script_added(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True)
        ctx.add_init_script.assert_awaited_once()
        script = ctx.add_init_script.call_args.args[0]
        assert isinstance(script, str)
        assert len(script) > 100

    @pytest.mark.asyncio
    async def test_init_script_contains_weles_config(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True, os="macos")
        script = ctx.add_init_script.call_args.args[0]
        assert "__weles" in script

    @pytest.mark.asyncio
    async def test_locale_applied_to_context(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True, locale="fr-FR")
        _, ctx_kwargs = browser.new_context.call_args
        assert ctx_kwargs.get("locale") == "fr-FR"

    @pytest.mark.asyncio
    async def test_locale_list_takes_first(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True,
                              locale=["de-DE", "en-US"])
        _, ctx_kwargs = browser.new_context.call_args
        assert ctx_kwargs.get("locale") == "de-DE"

    @pytest.mark.asyncio
    async def test_timezone_applied_to_context(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True,
                              timezone_id="America/New_York")
        _, ctx_kwargs = browser.new_context.call_args
        assert ctx_kwargs.get("timezone_id") == "America/New_York"

    @pytest.mark.asyncio
    async def test_proxy_applied_to_context(self):
        pw, browser, ctx = _mock_playwright()
        proxy = {"server": "http://proxy.example.com:8080"}
        await AsyncNewBrowser(pw, browser="firefox", headless=True, proxy=proxy)
        _, ctx_kwargs = browser.new_context.call_args
        assert ctx_kwargs.get("proxy") == proxy

    @pytest.mark.asyncio
    async def test_chromium_gets_anti_detect_args(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="chromium", headless=True)
        _, kwargs = pw.chromium.launch.call_args
        args = kwargs.get("args", [])
        assert "--disable-blink-features=AutomationControlled" in args

    @pytest.mark.asyncio
    async def test_default_os_is_macos(self):
        """When os=None, should default to 'macos'."""
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, headless=True)
        # Context should be created -- no error means macos was used
        ctx.add_init_script.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_os_list_accepted(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, os=["macos", "windows"], headless=True)
        ctx.add_init_script.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_config_override_applied(self):
        pw, browser, ctx = _mock_playwright()
        overrides = {"canvas": {"noiseSeed": 999}}
        await AsyncNewBrowser(pw, browser="firefox", headless=True, config=overrides)
        script = ctx.add_init_script.call_args.args[0]
        assert "999" in script  # noiseSeed should appear in the serialized JSON

    @pytest.mark.asyncio
    async def test_context_browser_ref_stored(self):
        pw, browser, ctx = _mock_playwright()
        result = await AsyncNewBrowser(pw, browser="firefox", headless=True)
        assert hasattr(result, "_weles_browser")

    @pytest.mark.asyncio
    async def test_user_agent_set_in_context(self):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True, os="macos")
        _, ctx_kwargs = browser.new_context.call_args
        assert "user_agent" in ctx_kwargs
        assert ctx_kwargs["user_agent"] is not None


class TestAsyncNewBrowserPersistentContext:
    @pytest.mark.asyncio
    async def test_persistent_context_firefox(self, tmp_path):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="firefox", headless=True,
                              user_data_dir=str(tmp_path))
        pw.firefox.launch_persistent_context.assert_awaited_once()
        pw.firefox.launch.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_persistent_context_chromium(self, tmp_path):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="chromium", headless=True,
                              user_data_dir=str(tmp_path))
        pw.chromium.launch_persistent_context.assert_awaited_once()
        pw.chromium.launch.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_persistent_context_chromium_gets_anti_detect_args(self, tmp_path):
        pw, browser, ctx = _mock_playwright()
        await AsyncNewBrowser(pw, browser="chromium", headless=True,
                              user_data_dir=str(tmp_path))
        _, kwargs = pw.chromium.launch_persistent_context.call_args
        args = kwargs.get("args", [])
        assert "--disable-blink-features=AutomationControlled" in args


# ---------------------------------------------------------------------------
# NewBrowser (sync) -- parameter handling
# ---------------------------------------------------------------------------

class TestNewBrowserParams:
    def test_firefox_launch_called(self):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="firefox", headless=True)
        pw.firefox.launch.assert_called_once()

    def test_chromium_launch_called(self):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="chromium", headless=True)
        pw.chromium.launch.assert_called_once()

    def test_headless_false_by_default(self):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="firefox")
        _, kwargs = pw.firefox.launch.call_args
        assert kwargs.get("headless") is False

    def test_init_script_added(self):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="firefox", headless=True)
        ctx.add_init_script.assert_called_once()

    def test_chromium_gets_anti_detect_args(self):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="chromium", headless=True)
        _, kwargs = pw.chromium.launch.call_args
        assert "--disable-blink-features=AutomationControlled" in kwargs.get("args", [])

    def test_locale_applied(self):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="firefox", headless=True, locale="ja-JP")
        _, ctx_kwargs = browser.new_context.call_args
        assert ctx_kwargs.get("locale") == "ja-JP"

    def test_timezone_applied(self):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="firefox", headless=True, timezone_id="Asia/Tokyo")
        _, ctx_kwargs = browser.new_context.call_args
        assert ctx_kwargs.get("timezone_id") == "Asia/Tokyo"

    def test_proxy_applied(self):
        pw, browser, ctx = _mock_sync_playwright()
        proxy = {"server": "http://proxy.example.com:3128"}
        NewBrowser(pw, browser="firefox", headless=True, proxy=proxy)
        _, ctx_kwargs = browser.new_context.call_args
        assert ctx_kwargs.get("proxy") == proxy

    def test_persistent_context_firefox(self, tmp_path):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="firefox", headless=True, user_data_dir=str(tmp_path))
        pw.firefox.launch_persistent_context.assert_called_once()

    def test_persistent_context_chromium(self, tmp_path):
        pw, browser, ctx = _mock_sync_playwright()
        NewBrowser(pw, browser="chromium", headless=True, user_data_dir=str(tmp_path))
        pw.chromium.launch_persistent_context.assert_called_once()


# ---------------------------------------------------------------------------
# Chromium args constants
# ---------------------------------------------------------------------------

class TestChromiumArgs:
    def test_async_has_automation_controlled_flag(self):
        assert "--disable-blink-features=AutomationControlled" in ASYNC_CHROMIUM_ARGS

    def test_sync_has_automation_controlled_flag(self):
        assert "--disable-blink-features=AutomationControlled" in SYNC_CHROMIUM_ARGS

    def test_async_and_sync_args_match(self):
        assert set(ASYNC_CHROMIUM_ARGS) == set(SYNC_CHROMIUM_ARGS)

    def test_async_has_no_sandbox(self):
        assert "--no-sandbox" in ASYNC_CHROMIUM_ARGS

    def test_async_has_dev_shm(self):
        assert "--disable-dev-shm-usage" in ASYNC_CHROMIUM_ARGS


# ---------------------------------------------------------------------------
# Browser marker tests (require real browser -- skipped in CI)
# ---------------------------------------------------------------------------

@pytest.mark.browser
async def test_async_weles_context_manager():
    """Full round-trip test with a real Firefox browser."""
    async with AsyncWeles(os="macos", headless=True) as ctx:
        page = await ctx.new_page()
        await page.goto("about:blank")
        ua = await page.evaluate("() => navigator.userAgent")
        assert "Firefox" in ua


@pytest.mark.browser
async def test_async_weles_chromium():
    """Full round-trip test with a real Chromium browser."""
    async with AsyncWeles(os="macos", browser="chromium", headless=True) as ctx:
        page = await ctx.new_page()
        await page.goto("about:blank")
        vendor = await page.evaluate("() => navigator.vendor")
        assert "Google" in vendor


@pytest.mark.browser
def test_weles_sync_context_manager():
    """Sync API round-trip with a real Firefox browser."""
    with Weles(os="windows", headless=True) as ctx:
        page = ctx.new_page()
        page.goto("about:blank")
        platform = page.evaluate("() => navigator.platform")
        assert platform == "Win32"
