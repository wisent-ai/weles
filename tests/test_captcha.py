"""Unit tests for weles/captcha/ -- solver init, detect constants, service configs."""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from weles.captcha.detect import (
    TYPE_TURNSTILE,
    TYPE_RECAPTCHA,
    TYPE_HCAPTCHA,
    detect_captcha,
)
from weles.captcha.solver import CaptchaSolver, _REGISTRY
from weles.captcha.services.base import CaptchaService
from weles.captcha.services.twocaptcha import (
    TwoCaptchaService,
    AntiCaptchaService,
    CapMonsterService,
    NextCaptchaService,
)
from weles.captcha.services.capsolver import (
    CapsolverService,
    NopeCHAService,
    NoCaptchaAIService,
)


# ---------------------------------------------------------------------------
# Type constants
# ---------------------------------------------------------------------------

class TestTypeConstants:
    def test_turnstile_constant(self):
        assert TYPE_TURNSTILE == "turnstile"

    def test_recaptcha_constant(self):
        assert TYPE_RECAPTCHA == "recaptcha"

    def test_hcaptcha_constant(self):
        assert TYPE_HCAPTCHA == "hcaptcha"

    def test_all_distinct(self):
        types = {TYPE_TURNSTILE, TYPE_RECAPTCHA, TYPE_HCAPTCHA}
        assert len(types) == 3


# ---------------------------------------------------------------------------
# CaptchaSolver initialization
# ---------------------------------------------------------------------------

class TestCaptchaSolverInit:
    def test_no_keys_no_services(self):
        solver = CaptchaSolver(credentials={})
        assert solver.available_services == []

    def test_env_var_picks_up_service(self):
        creds = {"TWOCAPTCHA_API_KEY": "test_key_123"}
        solver = CaptchaSolver(credentials=creds)
        assert "2captcha" in solver.available_services

    def test_multiple_services(self):
        creds = {
            "TWOCAPTCHA_API_KEY": "key1",
            "CAPSOLVER_API_KEY": "key2",
            "ANTICAPTCHA_API_KEY": "key3",
        }
        solver = CaptchaSolver(credentials=creds)
        services = solver.available_services
        assert "2captcha" in services
        assert "capsolver" in services
        assert "anticaptcha" in services

    def test_available_services_returns_list(self):
        solver = CaptchaSolver(credentials={})
        assert isinstance(solver.available_services, list)

    def test_credentials_override_env(self):
        # Even if env var is not set, credentials kwarg should work
        creds = {"CAPMONSTERCLOUD_API_KEY": "cm_key"}
        solver = CaptchaSolver(credentials=creds)
        assert "capmonster" in solver.available_services

    def test_all_seven_services_configurable(self):
        creds = {
            "CAPMONSTERCLOUD_API_KEY": "k1",
            "ANTICAPTCHA_API_KEY": "k2",
            "NEXTCAPTCHA_API_KEY": "k3",
            "CAPSOLVER_API_KEY": "k4",
            "NOPECHA_API_KEY": "k5",
            "TWOCAPTCHA_API_KEY": "k6",
            "NOCAPTCHAAI_API_KEY": "k7",
        }
        solver = CaptchaSolver(credentials=creds)
        assert len(solver.available_services) == 7


# ---------------------------------------------------------------------------
# Registry structure
# ---------------------------------------------------------------------------

class TestRegistry:
    def test_registry_has_seven_entries(self):
        assert len(_REGISTRY) == 7

    def test_registry_entries_are_triples(self):
        for entry in _REGISTRY:
            assert len(entry) == 3
            env_var, name, cls = entry
            assert isinstance(env_var, str)
            assert isinstance(name, str)
            assert isinstance(cls, type)

    def test_registry_classes_are_captcha_services(self):
        for env_var, name, cls in _REGISTRY:
            assert issubclass(cls, CaptchaService), f"{cls} is not a CaptchaService"


# ---------------------------------------------------------------------------
# Service base class
# ---------------------------------------------------------------------------

class TestCaptchaServiceBase:
    def test_twocaptcha_supported_types(self):
        svc = TwoCaptchaService(api_key="k")
        assert "turnstile" in svc.supported_types
        assert "recaptcha_v2" in svc.supported_types
        assert "hcaptcha" in svc.supported_types

    def test_capsolver_supported_types(self):
        svc = CapsolverService(api_key="k")
        assert "turnstile" in svc.supported_types

    def test_nopecha_supported_types(self):
        svc = NopeCHAService(api_key="k")
        assert "hcaptcha" in svc.supported_types
        assert "recaptcha_v2" in svc.supported_types

    def test_supports_method_true(self):
        svc = TwoCaptchaService(api_key="k")
        assert svc.supports("turnstile") is True

    def test_supports_method_false(self):
        svc = NopeCHAService(api_key="k")
        assert svc.supports("funcaptcha") is False

    def test_anticaptcha_service(self):
        svc = AntiCaptchaService(api_key="k")
        assert svc.supports("recaptcha_v2") is True

    def test_capmonster_service(self):
        svc = CapMonsterService(api_key="k")
        assert svc.supports("hcaptcha") is True

    def test_nextcaptcha_service(self):
        svc = NextCaptchaService(api_key="k")
        assert svc.supports("turnstile") is True

    def test_nocaptchaai_service(self):
        svc = NoCaptchaAIService(api_key="k")
        assert svc.supports("hcaptcha") is True


# ---------------------------------------------------------------------------
# detect_captcha -- with mocked page (no real browser)
# ---------------------------------------------------------------------------

def _make_page(frames=None, turnstile_sk=None, recaptcha_sk=None,
               hcaptcha_sk=None, html="<html></html>"):
    """Build a mock Playwright page for captcha detection tests."""
    page = MagicMock()
    page.frames = frames or []
    page.content = AsyncMock(return_value=html)

    async def _evaluate(js):
        if "_JS_DETECT_TURNSTILE" in js or "sk.startsWith('0x')" in js:
            return turnstile_sk
        if "_JS_DETECT_RECAPTCHA" in js or "startsWith('6L')" in js:
            return recaptcha_sk
        if "_JS_DETECT_HCAPTCHA" in js or "h-captcha" in js:
            return hcaptcha_sk
        return None

    page.evaluate = _evaluate
    return page


class TestDetectCaptchaNoResult:
    @pytest.mark.asyncio
    async def test_no_captcha_returns_none_none(self):
        page = _make_page()
        ctype, sitekey = await detect_captcha(page, retries=1, interval=0)
        assert ctype is None
        assert sitekey is None


class TestDetectCaptchaViaIframe:
    @pytest.mark.asyncio
    async def test_turnstile_from_iframe(self):
        frame = MagicMock()
        frame.url = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/0xABCDEF123/something"
        page = _make_page(frames=[frame])
        ctype, sitekey = await detect_captcha(page, retries=1, interval=0)
        assert ctype == TYPE_TURNSTILE
        assert sitekey == "0xABCDEF123"

    @pytest.mark.asyncio
    async def test_recaptcha_from_iframe(self):
        frame = MagicMock()
        frame.url = "https://www.google.com/recaptcha/api2/anchor?k=6LcTestKey&co=abc"
        page = _make_page(frames=[frame])
        ctype, sitekey = await detect_captcha(page, retries=1, interval=0)
        assert ctype == TYPE_RECAPTCHA
        assert sitekey == "6LcTestKey"

    @pytest.mark.asyncio
    async def test_hcaptcha_from_iframe(self):
        frame = MagicMock()
        frame.url = "https://newassets.hcaptcha.com/captcha/v1/xyz/frame?sitekey=abc-def-123"
        page = _make_page(frames=[frame])
        ctype, sitekey = await detect_captcha(page, retries=1, interval=0)
        assert ctype == TYPE_HCAPTCHA
        assert sitekey == "abc-def-123"


class TestDetectCaptchaViaDom:
    @pytest.mark.asyncio
    async def test_turnstile_from_dom(self):
        page = _make_page(turnstile_sk="0xMySiteKey")
        ctype, sitekey = await detect_captcha(page, retries=1, interval=0)
        assert ctype == TYPE_TURNSTILE
        assert sitekey == "0xMySiteKey"

    @pytest.mark.asyncio
    async def test_recaptcha_from_dom(self):
        page = _make_page(recaptcha_sk="6LcSomeRcKey")
        ctype, sitekey = await detect_captcha(page, retries=1, interval=0)
        assert ctype == TYPE_RECAPTCHA
        assert sitekey == "6LcSomeRcKey"

    @pytest.mark.asyncio
    async def test_hcaptcha_from_dom(self):
        page = _make_page(hcaptcha_sk="hc-site-key-xyz")
        ctype, sitekey = await detect_captcha(page, retries=1, interval=0)
        assert ctype == TYPE_HCAPTCHA
        assert sitekey == "hc-site-key-xyz"
