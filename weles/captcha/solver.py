"""High-level captcha solver with multi-service support.

``CaptchaSolver`` orchestrates detection, auto-pass attempts, API solving,
and token injection.  It rotates through services in priority order and
blacklists services that report permanent failures (zero balance, blocked).
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List, Optional, Set

from .detect import detect_captcha, TYPE_TURNSTILE, TYPE_RECAPTCHA, TYPE_HCAPTCHA
from .autopass import try_turnstile_auto, try_hcaptcha_auto
from .inject import inject_token, setup_route_intercept
from .services.base import CaptchaService
from .services.twocaptcha import (
    TwoCaptchaService, AntiCaptchaService, CapMonsterService, NextCaptchaService,
)
from .services.capsolver import CapsolverService, NopeCHAService, NoCaptchaAIService

_DEAD: Set[str] = set()  # permanently broken services
_PERM_ERRS = ("zero balance", "no funds", "blocked by", "been blocked",
               "usage policies", "account banned", "key denied")
_INJECT_WAIT = 2

# (env_var, service_name, class) in priority order
_REGISTRY: list[tuple[str, str, type]] = [
    ("CAPMONSTERCLOUD_API_KEY", "capmonster", CapMonsterService),
    ("ANTICAPTCHA_API_KEY", "anticaptcha", AntiCaptchaService),
    ("NEXTCAPTCHA_API_KEY", "nextcaptcha", NextCaptchaService),
    ("CAPSOLVER_API_KEY", "capsolver", CapsolverService),
    ("NOPECHA_API_KEY", "nopecha", NopeCHAService),
    ("TWOCAPTCHA_API_KEY", "2captcha", TwoCaptchaService),
    ("NOCAPTCHAAI_API_KEY", "nocaptchaai", NoCaptchaAIService),
]

# task_type + solution_key per captcha kind per service
_T = {  # turnstile
    "capsolver": ("AntiTurnstileTaskProxyLess", "token"),
    "2captcha": ("TurnstileTaskProxyless", "token"),
    "anticaptcha": ("TurnstileTaskProxyless", "token"),
    "capmonster": ("TurnstileTaskProxyless", "token"),
    "nextcaptcha": ("TurnstileTaskProxyless", "token"),
}
_R2 = {  # recaptcha v2
    s: ("RecaptchaV2TaskProxyless", "gRecaptchaResponse")
    for s in ("capsolver", "2captcha", "anticaptcha", "capmonster", "nextcaptcha")
}
_R3 = {  # recaptcha v3
    s: ("RecaptchaV3TaskProxyless", "gRecaptchaResponse")
    for s in ("capsolver", "2captcha", "anticaptcha", "capmonster", "nextcaptcha")
}
_H = {  # hcaptcha
    "capsolver": ("HCaptchaTaskProxyLess", "gRecaptchaResponse"),
    "2captcha": ("HCaptchaTaskProxyless", "gRecaptchaResponse"),
    "anticaptcha": ("HCaptchaTaskProxyless", "gRecaptchaResponse"),
    "capmonster": ("HCaptchaTaskProxyless", "gRecaptchaResponse"),
    "nextcaptcha": ("HCaptchaTaskProxyless", "gRecaptchaResponse"),
}
_F = {  # funcaptcha
    s: ("FunCaptchaTaskProxyless", "token")
    for s in ("capsolver", "2captcha", "anticaptcha", "capmonster", "nextcaptcha")
}


class CaptchaSolver:
    """Multi-service captcha solver with automatic service rotation.

    Usage::

        solver = CaptchaSolver()
        token = await solver.solve_turnstile(sitekey, url)
    """

    def __init__(self, *, credentials: Dict[str, str] | None = None) -> None:
        self._svcs: Dict[str, CaptchaService] = {}
        for env_var, name, cls in _REGISTRY:
            if name in _DEAD:
                continue
            key = (credentials or {}).get(env_var) or os.environ.get(env_var)
            if key:
                self._svcs[name] = cls(api_key=key)

    @property
    def available_services(self) -> List[str]:
        return list(self._svcs.keys())

    @staticmethod
    def _blacklist(name: str, err: str) -> None:
        if any(p in err.lower() for p in _PERM_ERRS):
            _DEAD.add(name)
            print(f"  [captcha] Blacklisted {name}")

    async def _task_solve(self, ctype: str, tmap: dict, params: dict) -> Optional[str]:
        """Try each service via createTask/getTaskResult."""
        for name, svc in self._svcs.items():
            if name in _DEAD or not svc.supports(ctype):
                continue
            entry = tmap.get(name)
            if not entry:
                continue
            task_type, sol_key = entry
            try:
                tid = await svc.submit(task_type, params)
                sol = await svc.poll(tid)
                tok = sol.get(sol_key)
                if tok:
                    return tok
            except (NotImplementedError, RuntimeError, TimeoutError) as e:
                self._blacklist(name, str(e))
                print(f"  [captcha] {name}: {e}")
        return None

    async def _direct_hcaptcha(self, sitekey: str, url: str) -> Optional[str]:
        for name in ("nopecha", "nocaptchaai"):
            svc = self._svcs.get(name)
            if not svc or name in _DEAD:
                continue
            try:
                r = await svc.solve_hcaptcha(sitekey, url)
                if r.get("token"):
                    return r["token"]
            except Exception as e:
                self._blacklist(name, str(e))
        return None

    async def _direct_recaptcha(self, sk: str, url: str, v: str) -> Optional[str]:
        for name in ("nopecha", "nocaptchaai"):
            svc = self._svcs.get(name)
            if not svc or name in _DEAD:
                continue
            try:
                r = await svc.solve_recaptcha(sk, url, version=v)
                if r.get("token"):
                    return r["token"]
            except Exception as e:
                self._blacklist(name, str(e))
        return None

    # ── Public API ────────────────────────────────────────────────────

    async def solve_turnstile(self, sitekey: str, url: str) -> Optional[str]:
        return await self._task_solve(
            "turnstile", _T, {"websiteURL": url, "websiteKey": sitekey})

    async def solve_recaptcha_v2(
        self, sitekey: str, url: str, *, enterprise: bool = False,
    ) -> Optional[str]:
        p: Dict[str, Any] = {"websiteURL": url, "websiteKey": sitekey}
        if enterprise:
            p["isEnterprise"] = True
        return (await self._task_solve("recaptcha_v2", _R2, p)
                or await self._direct_recaptcha(sitekey, url, "v2"))

    async def solve_recaptcha_v3(
        self, sitekey: str, url: str, *, action: str = "verify",
        min_score: float = 0.3,
    ) -> Optional[str]:
        p = {"websiteURL": url, "websiteKey": sitekey,
             "pageAction": action, "minScore": min_score}
        return (await self._task_solve("recaptcha_v3", _R3, p)
                or await self._direct_recaptcha(sitekey, url, "v3"))

    async def solve_hcaptcha(
        self, sitekey: str, url: str, *,
        enterprise_payload: Dict[str, Any] | None = None,
    ) -> Optional[str]:
        p: Dict[str, Any] = {"websiteURL": url, "websiteKey": sitekey}
        if enterprise_payload:
            p["isEnterprise"] = True
            if enterprise_payload.get("rqdata"):
                p["enterprisePayload"] = {"rqdata": enterprise_payload["rqdata"]}
        return (await self._task_solve("hcaptcha", _H, p)
                or await self._direct_hcaptcha(sitekey, url))

    async def solve_funcaptcha(
        self, public_key: str, url: str, *,
        subdomain: str | None = None, blob: str | None = None,
    ) -> Optional[str]:
        import json as jm
        p: Dict[str, Any] = {"websiteURL": url, "websitePublicKey": public_key}
        if subdomain:
            p["funcaptchaApiJSSubdomain"] = subdomain
        if blob:
            p["data"] = jm.dumps({"blob": blob})
        return await self._task_solve("funcaptcha", _F, p)


# ── All-in-one convenience ────────────────────────────────────────────

async def solve_page_captcha(
    page, *, solver: CaptchaSolver | None = None,
) -> bool:
    """Detect -> auto-pass -> API solve -> inject, all in one call.

    Returns ``True`` if solved (or no captcha found).
    """
    if await try_turnstile_auto(page):
        return True

    ctype, sitekey = await detect_captcha(page)
    if not sitekey:
        return True

    url = page.url
    s = solver or CaptchaSolver()

    if ctype == TYPE_HCAPTCHA and await try_hcaptcha_auto(page):
        return True

    token: Optional[str] = None
    if ctype == TYPE_TURNSTILE:
        token = await s.solve_turnstile(sitekey, url)
    elif ctype == TYPE_RECAPTCHA:
        token = await s.solve_recaptcha_v2(sitekey, url)
    elif ctype == TYPE_HCAPTCHA:
        token = await s.solve_hcaptcha(sitekey, url)

    if not token:
        return False

    await inject_token(page, ctype, token)
    if ctype == TYPE_TURNSTILE:
        await setup_route_intercept(page, token)
    await asyncio.sleep(_INJECT_WAIT)
    return True
