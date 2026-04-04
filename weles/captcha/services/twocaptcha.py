"""2Captcha-compatible services.

2Captcha, AntiCaptcha, CapMonster Cloud, and NextCaptcha all share the same
``createTask`` / ``getTaskResult`` JSON protocol (with minor differences in
base URL).  This module implements all four via a single base class.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict

import httpx

from .base import CaptchaService


class _CreateTaskService(CaptchaService):
    """Shared implementation for createTask/getTaskResult services."""

    base_url: str = ""
    poll_interval: int = 5
    max_timeout: int = 300

    supported_types = (
        "turnstile",
        "recaptcha_v2",
        "recaptcha_v3",
        "hcaptcha",
        "funcaptcha",
    )

    async def submit(
        self,
        task_type: str,
        params: Dict[str, Any],
    ) -> str:
        timeout = httpx.Timeout(60.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{self.base_url}/createTask",
                json={
                    "clientKey": self.api_key,
                    "task": {"type": task_type, **params},
                },
            )
            data = resp.json()

        error_id = data.get("errorId", 0)
        if error_id:
            desc = data.get("errorDescription", data.get("errorCode", "unknown"))
            raise RuntimeError(f"{self.name} submit error: {desc}")

        task_id = data.get("taskId")
        if task_id is None:
            raise RuntimeError(f"{self.name}: no taskId in response: {data}")
        return str(task_id)

    async def poll(
        self,
        task_id: str,
        *,
        max_wait: int = 120,
    ) -> Dict[str, Any]:
        iterations = max(1, max_wait // self.poll_interval)
        timeout = httpx.Timeout(30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            for _ in range(iterations):
                await asyncio.sleep(self.poll_interval)
                resp = await client.post(
                    f"{self.base_url}/getTaskResult",
                    json={
                        "clientKey": self.api_key,
                        "taskId": task_id,
                    },
                )
                data = resp.json()

                if data.get("errorId"):
                    desc = data.get("errorDescription", "unknown")
                    raise RuntimeError(f"{self.name} poll error: {desc}")

                if data.get("status") == "ready":
                    return data.get("solution", {})

        raise TimeoutError(f"{self.name}: solve timed out after {max_wait}s")


# ── 2Captcha ──────────────────────────────────────────────────────────


class TwoCaptchaService(_CreateTaskService):
    """2Captcha  (https://2captcha.com)."""

    name = "2captcha"
    base_url = "https://api.2captcha.com"
    poll_interval = 5


# ── AntiCaptcha ───────────────────────────────────────────────────────


class AntiCaptchaService(_CreateTaskService):
    """AntiCaptcha  (https://anti-captcha.com)."""

    name = "anticaptcha"
    base_url = "https://api.anti-captcha.com"
    poll_interval = 5


# ── CapMonster Cloud ──────────────────────────────────────────────────


class CapMonsterService(_CreateTaskService):
    """CapMonster Cloud  (https://capmonster.cloud)."""

    name = "capmonster"
    base_url = "https://api.capmonster.cloud"
    poll_interval = 5


# ── NextCaptcha ───────────────────────────────────────────────────────


class NextCaptchaService(_CreateTaskService):
    """NextCaptcha  (https://nextcaptcha.com)."""

    name = "nextcaptcha"
    base_url = "https://api.nextcaptcha.com"
    poll_interval = 5
