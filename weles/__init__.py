"""Weles: Browser fingerprint spoofing for Playwright Firefox."""

from .async_api import AsyncWeles, AsyncNewBrowser
from .sync_api import Weles, NewBrowser
from .capture import Capture
from .proxy import ProxyConfig, ProxyPool
from .captcha import CaptchaSolver, detect_captcha, solve_page_captcha
from .cloudflare import wait_cloudflare, bypass_cloudflare
from .session import SessionStore

__version__ = "0.2.0"
__all__ = [
    "AsyncWeles", "AsyncNewBrowser", "Weles", "NewBrowser", "Capture",
    "ProxyConfig", "ProxyPool", "CaptchaSolver", "detect_captcha",
    "solve_page_captcha", "wait_cloudflare", "bypass_cloudflare", "SessionStore",
]
