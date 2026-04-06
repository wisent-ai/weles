"""2Captcha-compatible service backends."""

from __future__ import annotations

from .base import CaptchaService


class TwoCaptchaService(CaptchaService):
    """2Captcha.com backend."""

    def __init__(self, api_key: str):
        self._api_key = api_key

    async def solve_recaptcha_v2(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def solve_turnstile(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def get_balance(self) -> float:
        raise NotImplementedError


class AntiCaptchaService(CaptchaService):
    """Anti-Captcha.com backend."""

    def __init__(self, api_key: str):
        self._api_key = api_key

    async def solve_recaptcha_v2(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def solve_turnstile(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def get_balance(self) -> float:
        raise NotImplementedError


class CapMonsterService(CaptchaService):
    """CapMonster.cloud backend."""

    def __init__(self, api_key: str):
        self._api_key = api_key

    async def solve_recaptcha_v2(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def solve_turnstile(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def get_balance(self) -> float:
        raise NotImplementedError


class NextCaptchaService(CaptchaService):
    """NextCaptcha.com backend."""

    def __init__(self, api_key: str):
        self._api_key = api_key

    async def solve_recaptcha_v2(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def solve_turnstile(self, site_key: str, page_url: str, **kwargs) -> str:
        raise NotImplementedError

    async def get_balance(self) -> float:
        raise NotImplementedError
