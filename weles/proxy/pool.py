"""Proxy pool for rotating proxies across browser sessions."""

from __future__ import annotations

import random
from typing import List, Optional

from .config import ProxyConfig


class ProxyPool:
    """Round-robin or random proxy pool.

    Args:
        proxies: List of ProxyConfig instances.
        strategy: "round-robin" or "random".
    """

    def __init__(self, proxies: Optional[List[ProxyConfig]] = None,
                 strategy: str = "round-robin"):
        self._proxies: List[ProxyConfig] = proxies or []
        self._strategy = strategy
        self._index = 0

    def add(self, proxy: ProxyConfig) -> None:
        """Add a proxy to the pool."""
        self._proxies.append(proxy)

    def next(self) -> Optional[ProxyConfig]:
        """Get the next proxy according to the rotation strategy."""
        if not self._proxies:
            return None
        if self._strategy == "random":
            return random.choice(self._proxies)
        proxy = self._proxies[self._index % len(self._proxies)]
        self._index += 1
        return proxy

    def __len__(self) -> int:
        return len(self._proxies)

    def __bool__(self) -> bool:
        return len(self._proxies) > 0
