"""Weles CDP browser automation."""

from .browser.api import CDPWeles, CDPNewBrowser
from .connection import CDPConnection
from .launcher import launch_chromium
from .page import CDPPage, CDPFrame, FrameTree

__all__ = [
    "CDPWeles", "CDPNewBrowser",
    "CDPConnection", "launch_chromium",
    "CDPPage", "CDPFrame", "FrameTree",
]
