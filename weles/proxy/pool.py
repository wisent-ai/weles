"""ProxyPool -- rotates through configured proxy providers."""

from __future__ import annotations

import logging
import os
from typing import Dict, List, Optional, Sequence, Set

from .config import ProxyConfig
from .providers import PROVIDERS

logger = logging.getLogger(__name__)


class ProxyPool:
    """High-level proxy manager.

    Discovers which providers have credentials in the environment, then hands
    out :class:`ProxyConfig` instances via :meth:`get` and :meth:`rotate`.

    Parameters:
        providers: Explicit ordered list of provider IDs to try.  When
            *None* (the default), all providers whose env-vars are set are
            used, in registry order.
        country: Default two-letter country code for geo-targeting.
        sticky: Whether to request sticky sessions by default.
        env: Optional mapping to read credentials from instead of
            ``os.environ`` (useful for testing).
    """

    def __init__(
        self,
        providers: Optional[Sequence[str]] = None,
        country: str = "US",
        sticky: bool = True,
        env: Optional[Dict[str, str]] = None,
    ) -> None:
        self._env = env if env is not None else os.environ
        self._default_country = country
        self._default_sticky = sticky

        # Resolve available providers (those with creds present).
        if providers is not None:
            self._provider_ids: List[str] = [
                p for p in providers if self._has_creds(p)
            ]
        else:
            self._provider_ids = [
                pid for pid in PROVIDERS if self._has_creds(pid)
            ]

        self._index: int = 0
        self._current: Optional[ProxyConfig] = None
        self._used_ips: Set[str] = set()
        self._custom_pool: List[ProxyConfig] = []

    # -- Public API ----------------------------------------------------------

    @property
    def available_providers(self) -> List[str]:
        """Provider IDs that have credentials configured."""
        return list(self._provider_ids)

    @property
    def current(self) -> Optional[ProxyConfig]:
        """The most recently issued :class:`ProxyConfig`, or *None*."""
        return self._current

    @property
    def used_ips(self) -> Set[str]:
        """Set of IPs observed via :meth:`test`."""
        return set(self._used_ips)

    def get(
        self,
        provider: Optional[str] = None,
        country: Optional[str] = None,
        sticky: Optional[bool] = None,
    ) -> ProxyConfig:
        """Return a :class:`ProxyConfig` ready for use.

        Parameters:
            provider: Specific provider ID.  When *None*, uses the current
                provider in the rotation (starts at the first available).
            country: Override the default country code.
            sticky: Override the default sticky-session setting.

        Raises:
            RuntimeError: If no providers are available and no custom proxies
                have been added.
        """
        country = country or self._default_country
        sticky = sticky if sticky is not None else self._default_sticky

        # Explicit provider request.
        if provider is not None:
            cfg = self._build(provider, country, sticky)
            self._current = cfg
            return cfg

        # Try the rotation list.
        if self._provider_ids:
            pid = self._provider_ids[self._index % len(self._provider_ids)]
            cfg = self._build(pid, country, sticky)
            self._current = cfg
            return cfg

        # Last resort: use custom pool entries.
        if self._custom_pool:
            cfg = self._custom_pool[self._index % len(self._custom_pool)]
            self._current = cfg
            return cfg

        raise RuntimeError(
            "No proxy providers configured. Set environment variables for at "
            "least one provider (e.g. PINGPROXIES_USERNAME / PINGPROXIES_PASSWORD) "
            "or call add_custom()."
        )

    def rotate(
        self,
        country: Optional[str] = None,
        sticky: Optional[bool] = None,
    ) -> ProxyConfig:
        """Advance to the next provider and return a fresh :class:`ProxyConfig`.

        If only one provider is available, a new sticky session ID is
        generated (giving a different IP on providers that support it).
        """
        self._index += 1
        return self.get(country=country, sticky=sticky)

    def add_custom(self, url: str, **overrides) -> None:
        """Add a custom proxy URL to the reserve pool.

        Parameters:
            url: Full proxy URL (e.g. ``http://user:pass@host:port``).
            **overrides: Extra fields forwarded to :meth:`ProxyConfig.from_url`.
        """
        self._custom_pool.append(ProxyConfig.from_url(url, **overrides))

    async def test(self, httpx_timeout: float = 15.0) -> Dict:
        """Test the current proxy by fetching an IP-echo service.

        Requires *httpx* to be installed (optional dependency).

        Returns a dict with ``ip``, ``ok``, ``provider``, and ``error`` keys.
        """
        if self._current is None:
            return {"ok": False, "ip": None, "provider": None, "error": "No current proxy. Call get() first."}

        try:
            import httpx  # noqa: delayed import -- httpx is optional
        except ImportError:
            return {"ok": False, "ip": None, "provider": self._current.provider, "error": "httpx is not installed"}

        try:
            async with httpx.AsyncClient(
                proxy=self._current.url,
                timeout=httpx_timeout,
            ) as client:
                resp = await client.get("https://httpbin.org/ip")
                if resp.status_code == 200:
                    ip = resp.json().get("origin", "unknown")
                    self._used_ips.add(ip)
                    return {
                        "ok": True,
                        "ip": ip,
                        "provider": self._current.provider,
                        "error": None,
                    }
                return {
                    "ok": False,
                    "ip": None,
                    "provider": self._current.provider,
                    "error": f"HTTP {resp.status_code}",
                }
        except Exception as exc:
            return {
                "ok": False,
                "ip": None,
                "provider": self._current.provider,
                "error": str(exc),
            }

    def list_providers(self) -> List[Dict]:
        """Return info dicts for every registered provider, flagging which are
        configured.
        """
        out = []
        for pid, spec in PROVIDERS.items():
            out.append({
                "id": pid,
                "name": spec["name"],
                "cost_per_gb": spec["cost_per_gb"],
                "configured": self._has_creds(pid),
            })
        return out

    # -- Internals -----------------------------------------------------------

    def _has_creds(self, provider_id: str) -> bool:
        spec = PROVIDERS.get(provider_id)
        if spec is None:
            return False
        return bool(
            self._env.get(spec["env_user"]) and self._env.get(spec["env_pass"])
        )

    def _build(self, provider_id: str, country: str, sticky: bool) -> ProxyConfig:
        spec = PROVIDERS.get(provider_id)
        if spec is None:
            raise ValueError(f"Unknown provider: {provider_id}")

        raw_user = self._env.get(spec["env_user"], "")
        raw_pass = self._env.get(spec["env_pass"], "")
        if not raw_user or not raw_pass:
            raise RuntimeError(
                f"Provider {provider_id!r} is not configured "
                f"(missing {spec['env_user']} or {spec['env_pass']})"
            )

        username, password = spec["build_creds"](raw_user, raw_pass, country, sticky)

        return ProxyConfig(
            host=spec["host"],
            port=spec["port"],
            username=username,
            password=password,
            country=country,
            provider=provider_id,
            sticky=sticky,
        )

    def __repr__(self) -> str:
        avail = ", ".join(self._provider_ids) or "none"
        custom = len(self._custom_pool)
        return f"ProxyPool(providers=[{avail}], custom={custom})"
