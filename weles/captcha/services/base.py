"""Base captcha service interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional


class CaptchaService(ABC):
    """Abstract base for captcha solving backends."""

    @abstractmethod
    async def solve_recaptcha_v2(self, site_key: str, page_url: str,
                                  **kwargs) -> str:
        """Solve a reCAPTCHA v2 and return the token."""

    @abstractmethod
    async def solve_turnstile(self, site_key: str, page_url: str,
                               **kwargs) -> str:
        """Solve a Cloudflare Turnstile and return the token."""

    @abstractmethod
    async def get_balance(self) -> float:
        """Return the account balance."""
