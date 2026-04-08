"""Weles agent layer: declarative high-level Task API.

Application code uses this module instead of touching weles internals.
Adding a new account/service is one row of config and zero per-site code.

Example:
    from weles.agent import FetchAccountValue

    balance = await FetchAccountValue(
        service="oxylabs",
        url="https://dashboard.oxylabs.io",
        username_env="OXYLABS_USERNAME",
        password_env="OXYLABS_PASSWORD",
        what="the current account credit balance",
    ).run()
"""

from . import discover, login, vision
from .tasks import FetchAccountValue

__all__ = [
    "FetchAccountValue",
    "vision",
    "login",
    "discover",
]
