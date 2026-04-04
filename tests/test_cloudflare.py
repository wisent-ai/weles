"""Unit tests for weles/cloudflare/challenge.py."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from weles.cloudflare.challenge import (
    is_cloudflare_challenge,
    wait_cloudflare,
    bypass_cloudflare,
    CF_KEYWORDS,
    CF_IFRAME_HOST,
    CF_MAX_CHECKS,
    CF_CHECK_INTERVAL,
)


# ---------------------------------------------------------------------------
# is_cloudflare_challenge (pure function -- no mocks needed)
# ---------------------------------------------------------------------------

class TestIsCloudflareChallenge:
    @pytest.mark.parametrize("kw", CF_KEYWORDS)
    def test_detects_each_keyword(self, kw):
        assert is_cloudflare_challenge(f"Some text with {kw} in it") is True

    def test_case_insensitive(self):
        assert is_cloudflare_challenge("Just A Moment") is True
        assert is_cloudflare_challenge("JUST A MOMENT") is True

    def test_false_for_clean_page(self):
        assert is_cloudflare_challenge("Welcome to my website!") is False

    def test_false_for_empty_string(self):
        assert is_cloudflare_challenge("") is False

    def test_partial_keyword_not_matched(self):
        # "just" alone shouldn't match "just a moment"
        assert is_cloudflare_challenge("just checking") is False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

class TestConstants:
    def test_cf_keywords_nonempty(self):
        assert len(CF_KEYWORDS) > 0

    def test_cf_iframe_host(self):
        assert "cloudflare.com" in CF_IFRAME_HOST

    def test_cf_max_checks_positive(self):
        assert CF_MAX_CHECKS > 0

    def test_cf_check_interval_positive(self):
        assert CF_CHECK_INTERVAL > 0


# ---------------------------------------------------------------------------
# wait_cloudflare -- with mocked page
# ---------------------------------------------------------------------------

def _make_clean_page():
    """Page with no CF challenge indicators."""
    page = MagicMock()
    page.frames = []
    page.text_content = AsyncMock(return_value="Welcome to the site!")
    return page


def _make_cf_page():
    """Page stuck on CF challenge forever."""
    page = MagicMock()
    page.frames = []
    page.text_content = AsyncMock(return_value="just a moment")
    return page


def _make_cf_then_clean_page(clear_on_check=2):
    """Page that clears CF challenge after `clear_on_check` iterations."""
    call_count = {"n": 0}
    page = MagicMock()
    page.frames = []

    async def _text_content(selector):
        call_count["n"] += 1
        if call_count["n"] <= clear_on_check:
            return "just a moment, checking your browser"
        return "Welcome to the site!"

    page.text_content = _text_content
    return page


class TestWaitCloudflare:
    @pytest.mark.asyncio
    async def test_clean_page_returns_true_immediately(self):
        page = _make_clean_page()
        result = await wait_cloudflare(page, max_checks=3, interval=0)
        assert result is True

    @pytest.mark.asyncio
    async def test_persistent_cf_returns_false(self):
        page = _make_cf_page()
        result = await wait_cloudflare(page, max_checks=2, interval=0)
        assert result is False

    @pytest.mark.asyncio
    async def test_clears_after_retries(self):
        page = _make_cf_then_clean_page(clear_on_check=2)
        result = await wait_cloudflare(page, max_checks=5, interval=0)
        assert result is True

    @pytest.mark.asyncio
    async def test_calls_text_content_with_body(self):
        page = _make_clean_page()
        await wait_cloudflare(page, max_checks=1, interval=0)
        page.text_content.assert_called_with("body")

    @pytest.mark.asyncio
    async def test_page_error_does_not_crash(self):
        """text_content raising should be silently caught."""
        page = MagicMock()
        page.frames = []
        page.text_content = AsyncMock(side_effect=Exception("page gone"))
        # When text_content raises, body defaults to "" which has no CF keywords
        result = await wait_cloudflare(page, max_checks=1, interval=0)
        assert result is True

    @pytest.mark.asyncio
    async def test_clicks_iframe_when_cf_present(self):
        page = MagicMock()
        page.text_content = AsyncMock(return_value="just a moment")

        frame = MagicMock()
        frame.url = f"https://{CF_IFRAME_HOST}/turnstile/frame"
        body_locator = MagicMock()
        body_locator.click = AsyncMock()
        frame.locator = MagicMock(return_value=body_locator)
        page.frames = [frame]

        # Run only 1 check so it doesn't loop forever
        await wait_cloudflare(page, max_checks=1, interval=0)
        body_locator.click.assert_called_once()


# ---------------------------------------------------------------------------
# bypass_cloudflare
# ---------------------------------------------------------------------------

class TestBypassCloudflare:
    @pytest.mark.asyncio
    async def test_returns_true_when_no_cf(self):
        page = _make_clean_page()
        result = await bypass_cloudflare(page)
        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_when_stuck_no_solver(self):
        page = _make_cf_page()
        result = await bypass_cloudflare(page, solver=None, timeout=3)
        assert result is False
