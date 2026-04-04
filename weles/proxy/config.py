"""Proxy configuration dataclass."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional
from urllib.parse import urlparse


@dataclass
class ProxyConfig:
    """Single proxy endpoint configuration.

    Attributes:
        host: Proxy hostname or IP.
        port: Proxy port number.
        username: Authentication username (already formatted for the provider).
        password: Authentication password (already formatted for the provider).
        protocol: Connection protocol -- ``"http"``, ``"https"``, or ``"socks5"``.
        country: Two-letter country code this proxy targets (e.g. ``"US"``).
        provider: Name of the provider that created this config.
        sticky: Whether a sticky session ID was embedded in the credentials.
    """

    host: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None
    protocol: str = "http"
    country: Optional[str] = None
    provider: Optional[str] = None
    sticky: bool = False

    # -- Derived helpers -----------------------------------------------------

    @property
    def url(self) -> str:
        """Full proxy URL (``protocol://user:pass@host:port``)."""
        if self.username and self.password:
            return f"{self.protocol}://{self.username}:{self.password}@{self.host}:{self.port}"
        return f"{self.protocol}://{self.host}:{self.port}"

    def to_playwright(self) -> Dict[str, str]:
        """Return a dict accepted by Playwright's *proxy* launch option.

        Example return value::

            {"server": "http://host:port", "username": "u", "password": "p"}
        """
        cfg: Dict[str, str] = {
            "server": f"{self.protocol}://{self.host}:{self.port}",
        }
        if self.username:
            cfg["username"] = self.username
        if self.password:
            cfg["password"] = self.password
        return cfg

    # -- Factory -------------------------------------------------------------

    @classmethod
    def from_url(cls, url: str, **overrides) -> "ProxyConfig":
        """Parse a proxy URL into a :class:`ProxyConfig`.

        Accepted formats::

            http://host:port
            http://user:pass@host:port
            socks5://user:pass@host:port

        Any extra keyword arguments are forwarded to the constructor and
        override values parsed from the URL.
        """
        parsed = urlparse(url)
        kwargs = {
            "host": parsed.hostname or "",
            "port": parsed.port or 80,
            "username": parsed.username,
            "password": parsed.password,
            "protocol": parsed.scheme or "http",
        }
        kwargs.update(overrides)
        return cls(**kwargs)

    # -- Dunder helpers ------------------------------------------------------

    def __str__(self) -> str:
        label = self.provider or self.host
        masked = f"{self.protocol}://{self.host}:{self.port}"
        if self.country:
            masked += f" [{self.country}]"
        return f"ProxyConfig({label} -> {masked})"
