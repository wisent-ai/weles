"""Weles: Browser fingerprint spoofing for Playwright Firefox."""

from .async_api import AsyncWeles, AsyncNewBrowser
from .sync_api import Weles, NewBrowser

__version__ = "0.1.0"
__all__ = ["AsyncWeles", "AsyncNewBrowser", "Weles", "NewBrowser"]
