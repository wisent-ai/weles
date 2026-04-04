"""Capsolver, NopeCHA, and NoCaptchaAI service backends.

Capsolver uses the same createTask/getTaskResult protocol as 2Captcha but
with slightly different response formats (faster polling, different solution
keys).  NopeCHA and NoCaptchaAI have entirely custom APIs.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict

import httpx

from .base import CaptchaService

# ── Capsolver ─────────────────────────────────────────────────────────


class CapsolverService(CaptchaService):
    """Capsolver  (https://capsolver.com).

    Same createTask/getTaskResult protocol as 2Captcha but polls every 3 s
    instead of 5 s (Capsolver is faster) and solution keys differ slightly.
    """

    name = "capsolver"
    base_url = "https://api.capsolver.com"
    poll_interval = 3

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

        if data.get("errorId"):
            desc = data.get("errorDescription", data.get("errorCode", "unknown"))
            raise RuntimeError(f"Capsolver submit error: {desc}")

        task_id = data.get("taskId")
        if task_id is None:
            raise RuntimeError(f"Capsolver: no taskId in response: {data}")
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
                    raise RuntimeError(f"Capsolver poll error: {desc}")

                if data.get("status") == "ready":
                    return data.get("solution", {})

        raise TimeoutError(f"Capsolver: timed out after {max_wait}s")


# ── NopeCHA ───────────────────────────────────────────────────────────


class NopeCHAService(CaptchaService):
    """NopeCHA  (https://nopecha.com).

    Uses a Bearer-auth token API with job-based polling.  Supports hCaptcha
    (including Enterprise) and reCAPTCHA v2/v3.
    """

    name = "nopecha"
    base_url = "https://api.nopecha.com"
    poll_interval = 5

    supported_types = ("hcaptcha", "recaptcha_v2", "recaptcha_v3")

    # -- internal helpers ---------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def _submit_and_poll(
        self,
        endpoint: str,
        payload: Dict[str, Any],
        max_wait: int,
    ) -> Dict[str, Any]:
        timeout = httpx.Timeout(30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            # Submit
            resp = await client.post(
                f"{self.base_url}/v1/token/{endpoint}",
                headers=self._headers(),
                json=payload,
            )
            data = resp.json()
            if "error" in data:
                msg = data.get("message", data.get("error"))
                raise RuntimeError(f"NopeCHA error: {msg}")
            job_id = data.get("data")
            if not job_id:
                raise RuntimeError(f"NopeCHA: no job ID: {data}")

            # Poll
            iterations = max(1, max_wait // self.poll_interval)
            for _ in range(iterations):
                await asyncio.sleep(self.poll_interval)
                resp = await client.get(
                    f"{self.base_url}/v1/token/{endpoint}",
                    headers=self._headers(),
                    params={"id": job_id},
                )
                data = resp.json()
                if "error" in data:
                    if data.get("error") == 14:  # incomplete
                        continue
                    raise RuntimeError(
                        f"NopeCHA poll error: {data.get('message', data.get('error'))}"
                    )
                token = data.get("data")
                if isinstance(token, str) and len(token) > 50:
                    return {"token": token}

        raise TimeoutError(f"NopeCHA: timed out after {max_wait}s")

    # -- public interface (duck-types with submit/poll but also has
    #    direct solve methods used by CaptchaSolver) -----------------------

    async def submit(
        self,
        task_type: str,
        params: Dict[str, Any],
    ) -> str:
        # NopeCHA doesn't use a separate submit; solve goes through
        # _submit_and_poll.  We store params so poll() can use them.
        raise NotImplementedError(
            "NopeCHA uses direct solve methods; call solve_hcaptcha / "
            "solve_recaptcha instead."
        )

    async def poll(self, task_id: str, *, max_wait: int = 120) -> Dict[str, Any]:
        raise NotImplementedError("NopeCHA uses direct solve methods.")

    async def solve_hcaptcha(
        self,
        sitekey: str,
        url: str,
        *,
        enterprise_payload: Dict[str, Any] | None = None,
        max_wait: int = 300,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"sitekey": sitekey, "url": url}
        if enterprise_payload and enterprise_payload.get("rqdata"):
            payload["data"] = {"rqdata": enterprise_payload["rqdata"]}
        return await self._submit_and_poll("hcaptcha", payload, max_wait)

    async def solve_recaptcha(
        self,
        sitekey: str,
        url: str,
        *,
        version: str = "v2",
        max_wait: int = 300,
    ) -> Dict[str, Any]:
        endpoint = "recaptcha2" if version == "v2" else "recaptcha3"
        return await self._submit_and_poll(
            endpoint, {"sitekey": sitekey, "url": url}, max_wait
        )


# ── NoCaptchaAI ───────────────────────────────────────────────────────


class NoCaptchaAIService(CaptchaService):
    """NoCaptchaAI  (https://nocaptchaai.com).

    Uses ``apikey`` header auth.  Supports hCaptcha and reCAPTCHA (v2/v3).
    """

    name = "nocaptchaai"
    base_url = "https://token.nocaptchaai.com"
    poll_interval = 5

    supported_types = ("hcaptcha", "recaptcha_v2", "recaptcha_v3")

    def _headers(self) -> Dict[str, str]:
        return {"apikey": self.api_key}

    async def _solve(
        self,
        endpoint: str,
        sitekey: str,
        url: str,
        max_wait: int,
    ) -> Dict[str, Any]:
        timeout = httpx.Timeout(30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{self.base_url}/{endpoint}",
                headers=self._headers(),
                json={"sitekey": sitekey, "url": url},
            )
            data = resp.json()

            if data.get("status") == "solved":
                return {"token": data["token"]}

            if data.get("status") == "processing":
                task_id = data.get("id")
                iterations = max(1, max_wait // self.poll_interval)
                for _ in range(iterations):
                    await asyncio.sleep(self.poll_interval)
                    resp = await client.get(
                        f"{self.base_url}/status/{task_id}",
                        headers=self._headers(),
                    )
                    data = resp.json()
                    if data.get("status") == "solved":
                        return {"token": data["token"]}
                    if data.get("status") == "failed":
                        raise RuntimeError(
                            f"NoCaptchaAI failed: {data.get('message')}"
                        )

            raise RuntimeError(
                f"NoCaptchaAI error: {data.get('message', 'unknown')}"
            )

    # -- public interface ---------------------------------------------------

    async def submit(
        self,
        task_type: str,
        params: Dict[str, Any],
    ) -> str:
        raise NotImplementedError(
            "NoCaptchaAI uses direct solve methods; call solve_hcaptcha / "
            "solve_recaptcha instead."
        )

    async def poll(self, task_id: str, *, max_wait: int = 120) -> Dict[str, Any]:
        raise NotImplementedError("NoCaptchaAI uses direct solve methods.")

    async def solve_hcaptcha(
        self,
        sitekey: str,
        url: str,
        *,
        max_wait: int = 120,
    ) -> Dict[str, Any]:
        return await self._solve("hcaptcha", sitekey, url, max_wait)

    async def solve_recaptcha(
        self,
        sitekey: str,
        url: str,
        *,
        version: str = "v2",
        max_wait: int = 120,
    ) -> Dict[str, Any]:
        endpoint = "recaptcha" if version == "v2" else "recaptchav3"
        return await self._solve(endpoint, sitekey, url, max_wait)
