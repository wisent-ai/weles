"""Abstract base class for captcha solving services."""

from __future__ import annotations

import abc
from typing import Any, Dict, Optional


class CaptchaService(abc.ABC):
    """ABC for a captcha-solving backend.

    Every concrete service must implement :meth:`submit` (send a task) and
    :meth:`poll` (retrieve the result).  The higher-level ``CaptchaSolver``
    orchestrates calling these in a submit-then-poll loop.
    """

    name: str = "base"

    # Captcha types this service supports.  Each entry is a captcha kind
    # string such as ``"turnstile"``, ``"recaptcha_v2"``, ``"hcaptcha"`` etc.
    supported_types: tuple[str, ...] = ()

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    # ------------------------------------------------------------------
    # Abstract interface
    # ------------------------------------------------------------------

    @abc.abstractmethod
    async def submit(
        self,
        task_type: str,
        params: Dict[str, Any],
    ) -> str:
        """Submit a solving task and return the task/job ID."""

    @abc.abstractmethod
    async def poll(
        self,
        task_id: str,
        *,
        max_wait: int = 120,
    ) -> Dict[str, Any]:
        """Poll until the task is solved.  Return the solution dict."""

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def supports(self, captcha_type: str) -> bool:
        """Return *True* if this service can solve *captcha_type*."""
        if not self.supported_types:
            return True  # no restriction declared
        return captcha_type in self.supported_types

    def __repr__(self) -> str:
        return f"<{type(self).__name__} name={self.name!r}>"
