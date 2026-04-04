"""Provider registry -- knows how to build credentials for every supported
proxy vendor.

Each provider is a dict with:
    name        Human-readable label.
    host        Proxy gateway hostname.
    port        Proxy gateway port.
    env_user    Environment variable holding the raw username / customer ID.
    env_pass    Environment variable holding the raw password.
    cost_per_gb Approximate cost in USD.  0 = unlimited / flat-rate plan.
    build_creds Callable(raw_user, raw_pass, country, sticky) -> (username, password)
"""

from __future__ import annotations

import random
from typing import Callable, Dict, Tuple

# Type alias for the credential builder used by every provider.
CredBuilder = Callable[[str, str, str, bool], Tuple[str, str]]


def _session_id() -> int:
    return random.randint(1_000_000, 9_999_999)


# ---------------------------------------------------------------------------
# Per-provider credential builders
# ---------------------------------------------------------------------------

def _pingproxies(user: str, pwd: str, country: str, sticky: bool) -> Tuple[str, str]:
    username = f"{user}_c_{country.lower()}"
    if sticky:
        username += f"_s_{_session_id()}"
    return username, pwd


def _oxylabs_dc(user: str, pwd: str, country: str, sticky: bool) -> Tuple[str, str]:
    username = f"user-{user}"
    return username, pwd


def _oxylabs_residential(user: str, pwd: str, country: str, sticky: bool) -> Tuple[str, str]:
    username = f"customer-{user}-cc-{country.lower()}"
    if sticky:
        username += f"-sessid-{_session_id()}"
    return username, pwd


def _oxylabs_mobile(user: str, pwd: str, country: str, sticky: bool) -> Tuple[str, str]:
    username = f"customer-{user}-cc-{country.upper()}"
    if sticky:
        username += f"-sessid-{_session_id()}"
    return username, pwd


def _smartproxy(user: str, pwd: str, country: str, sticky: bool) -> Tuple[str, str]:
    username = f"user-{user}-country-{country.lower()}"
    if sticky:
        username += f"-session-{_session_id()}"
    return username, pwd


def _iproyal(user: str, pwd: str, country: str, sticky: bool) -> Tuple[str, str]:
    password = f"{pwd}_country-{country.lower()}"
    if sticky:
        password += f"_session-{_session_id()}"
    return user, password


def _packetstream(user: str, pwd: str, country: str, sticky: bool) -> Tuple[str, str]:
    password = f"{pwd}_country-{country.upper()}"
    if sticky:
        password += f"_session-{_session_id()}"
    return user, password


# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

PROVIDERS: Dict[str, Dict] = {
    "pingproxies": {
        "name": "Pingproxies",
        "host": "residential.pingproxies.com",
        "port": 8000,
        "env_user": "PINGPROXIES_USERNAME",
        "env_pass": "PINGPROXIES_PASSWORD",
        "cost_per_gb": 0.0,
        "build_creds": _pingproxies,
    },
    "oxylabs_dc": {
        "name": "Oxylabs DC",
        "host": "dc.oxylabs.io",
        "port": 8000,
        "env_user": "OXYLABS_DC_USERNAME",
        "env_pass": "OXYLABS_DC_PASSWORD",
        "cost_per_gb": 0.0,
        "build_creds": _oxylabs_dc,
    },
    "oxylabs": {
        "name": "Oxylabs Residential",
        "host": "pr.oxylabs.io",
        "port": 7777,
        "env_user": "OXYLABS_USERNAME",
        "env_pass": "OXYLABS_PASSWORD",
        "cost_per_gb": 15.0,
        "build_creds": _oxylabs_residential,
    },
    "oxylabs_mobile": {
        "name": "Oxylabs Mobile",
        "host": "pr.oxylabs.io",
        "port": 7777,
        "env_user": "OXYLABS_MOBILE_USERNAME",
        "env_pass": "OXYLABS_MOBILE_PASSWORD",
        "cost_per_gb": 20.0,
        "build_creds": _oxylabs_mobile,
    },
    "smartproxy": {
        "name": "Smartproxy",
        "host": "gate.smartproxy.com",
        "port": 7000,
        "env_user": "SMARTPROXY_USERNAME",
        "env_pass": "SMARTPROXY_PASSWORD",
        "cost_per_gb": 12.0,
        "build_creds": _smartproxy,
    },
    "iproyal": {
        "name": "IPRoyal",
        "host": "geo.iproyal.com",
        "port": 12321,
        "env_user": "IPROYAL_USERNAME",
        "env_pass": "IPROYAL_PASSWORD",
        "cost_per_gb": 7.0,
        "build_creds": _iproyal,
    },
    "packetstream": {
        "name": "PacketStream",
        "host": "proxy.packetstream.io",
        "port": 31112,
        "env_user": "PACKETSTREAM_USERNAME",
        "env_pass": "PACKETSTREAM_PASSWORD",
        "cost_per_gb": 1.0,
        "build_creds": _packetstream,
    },
}
