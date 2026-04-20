"""Unit tests for weles/human/ -- mouse movement and keyboard input helpers."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from weles.human.mouse import _bezier_points, move_to, click_at, random_movements
from weles.human.keyboard import type_text, human_delay, human_think


# ---------------------------------------------------------------------------
# _bezier_points (pure function)
# ---------------------------------------------------------------------------

class TestBezierPoints:
    def test_returns_list(self):
        pts = _bezier_points((0, 0), (100, 100))
        assert isinstance(pts, list)

    def test_all_points_are_tuples_of_ints(self):
        pts = _bezier_points((0, 0), (100, 100))
        for pt in pts:
            assert isinstance(pt, tuple)
            assert len(pt) == 2
            assert isinstance(pt[0], int)
            assert isinstance(pt[1], int)

    def test_first_point_near_start(self):
        pts = _bezier_points((10, 20), (200, 300))
        # First point should be the start
        assert pts[0] == (10, 20)

    def test_last_point_near_end(self):
        pts = _bezier_points((10, 20), (200, 300))
        # Last point should be the end
        assert pts[-1] == (200, 300)

    def test_custom_steps(self):
        pts = _bezier_points((0, 0), (100, 100), steps=5)
        assert len(pts) == 6  # steps + 1

    def test_default_steps_scales_with_distance(self):
        short = _bezier_points((0, 0), (10, 0))
        long_ = _bezier_points((0, 0), (1000, 0))
        assert len(long_) > len(short)

    def test_same_start_end(self):
        pts = _bezier_points((50, 50), (50, 50))
        assert len(pts) >= 2


# ---------------------------------------------------------------------------
# move_to (mocked page)
# ---------------------------------------------------------------------------

def _make_page(width=1920, height=1080):
    page = MagicMock()
    page.viewport_size = {"width": width, "height": height}
    page.mouse = MagicMock()
    page.mouse.move = AsyncMock()
    page.mouse.click = AsyncMock()
    return page


class TestMoveTo:
    @pytest.mark.asyncio
    async def test_calls_mouse_move(self):
        page = _make_page()
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            await move_to(page, 100, 200, start_x=0, start_y=0)
        assert page.mouse.move.await_count > 0

    @pytest.mark.asyncio
    async def test_accepts_explicit_start(self):
        page = _make_page()
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            await move_to(page, 500, 500, start_x=10, start_y=10)
        page.mouse.move.assert_awaited()

    @pytest.mark.asyncio
    async def test_uses_viewport_when_no_start(self):
        page = _make_page(width=800, height=600)
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            await move_to(page, 400, 300)
        assert page.mouse.move.await_count > 0

    @pytest.mark.asyncio
    async def test_custom_steps_parameter(self):
        page = _make_page()
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            await move_to(page, 100, 100, start_x=0, start_y=0, steps=3)
        # With steps=3, should call move 4 times (steps+1)
        assert page.mouse.move.await_count == 4


class TestClickAt:
    @pytest.mark.asyncio
    async def test_calls_mouse_click(self):
        page = _make_page()
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            await click_at(page, 100, 200, start_x=0, start_y=0)
        page.mouse.click.assert_awaited()

    @pytest.mark.asyncio
    async def test_click_includes_jitter(self):
        """Click target should be ±2 from the requested position."""
        page = _make_page()
        clicks = []
        original_click = page.mouse.click

        async def capture_click(x, y):
            clicks.append((x, y))

        page.mouse.click = capture_click
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            # Run several times to observe jitter variation
            for _ in range(5):
                await click_at(page, 100, 200, start_x=0, start_y=0)
        for cx, cy in clicks:
            assert abs(cx - 100) <= 2
            assert abs(cy - 200) <= 2


class TestRandomMovements:
    @pytest.mark.asyncio
    async def test_performs_movements(self):
        page = _make_page()
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            await random_movements(page, count=3)
        assert page.mouse.move.await_count > 0

    @pytest.mark.asyncio
    async def test_default_count_between_2_and_5(self):
        """Without explicit count, should make at least 2 movements."""
        page = _make_page()
        with patch("weles.human.mouse.asyncio.sleep", new=AsyncMock()):
            await random_movements(page)
        # Each movement calls move_to which calls mouse.move multiple times
        assert page.mouse.move.await_count >= 2


# ---------------------------------------------------------------------------
# human_delay / human_think
# ---------------------------------------------------------------------------

class TestHumanDelayAndThink:
    @pytest.mark.asyncio
    async def test_human_delay_sleeps(self):
        slept = []
        async def fake_sleep(t):
            slept.append(t)
        with patch("weles.human.keyboard.asyncio.sleep", fake_sleep):
            await human_delay(min_ms=100, max_ms=200)
        assert len(slept) == 1
        assert 0.1 <= slept[0] <= 0.2

    @pytest.mark.asyncio
    async def test_human_think_sleeps_longer(self):
        slept = []
        async def fake_sleep(t):
            slept.append(t)
        with patch("weles.human.keyboard.asyncio.sleep", fake_sleep):
            await human_think(min_ms=1000, max_ms=2000)
        assert len(slept) == 1
        assert 1.0 <= slept[0] <= 2.0

    @pytest.mark.asyncio
    async def test_human_delay_defaults(self):
        """Default range is 500-2000 ms."""
        slept = []
        async def fake_sleep(t):
            slept.append(t)
        with patch("weles.human.keyboard.asyncio.sleep", fake_sleep):
            await human_delay()
        assert 0.5 <= slept[0] <= 2.0

    @pytest.mark.asyncio
    async def test_human_think_defaults(self):
        """Default range is 1000-4000 ms."""
        slept = []
        async def fake_sleep(t):
            slept.append(t)
        with patch("weles.human.keyboard.asyncio.sleep", fake_sleep):
            await human_think()
        assert 1.0 <= slept[0] <= 4.0


# ---------------------------------------------------------------------------
# type_text (mocked page)
# ---------------------------------------------------------------------------

class TestTypeText:
    def _make_type_page(self):
        page = MagicMock()
        locator = MagicMock()
        locator.click = AsyncMock()
        locator.fill = AsyncMock()
        first_locator = MagicMock()
        first_locator.click = AsyncMock()
        first_locator.fill = AsyncMock()
        locator.first = first_locator
        page.locator = MagicMock(return_value=locator)
        page.keyboard = MagicMock()
        page.keyboard.type = AsyncMock()
        return page

    @pytest.mark.asyncio
    async def test_types_each_character(self):
        page = self._make_type_page()
        text = "hello"
        await type_text(page, "input", text)
        assert page.keyboard.type.await_count == len(text)

    @pytest.mark.asyncio
    async def test_clears_field_when_clear_true(self):
        page = self._make_type_page()
        await type_text(page, "input", "hi", clear=True)
        page.locator.return_value.first.fill.assert_awaited_with("")

    @pytest.mark.asyncio
    async def test_no_clear_when_false(self):
        page = self._make_type_page()
        await type_text(page, "input", "hi", clear=False)
        page.locator.return_value.first.fill.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_text_types_nothing(self):
        page = self._make_type_page()
        await type_text(page, "input", "")
        page.keyboard.type.assert_not_awaited()
