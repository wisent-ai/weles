"""CDP (Chrome DevTools Protocol) driver for weles."""

from .browser import CDPBrowserContext
from .browser.api import CDPWeles, CDPNewBrowser
from .connection import CDPConnection
from .dom import CDPLocator
from .emulation import set_user_agent, set_viewport
from .errors import CDPError, CDPNavigationError, CDPTargetClosedError, CDPTimeoutError
from .input import CDPKeyboard, CDPMouse
from .launcher import launch_chromium
from .net import CDPNetworkManager, CDPRequest, CDPRoute
from .page import CDPFrame, CDPPage, FrameTree

__all__ = [
    "CDPBrowserContext",
    "CDPWeles",
    "CDPNewBrowser",
    "CDPConnection",
    "CDPError",
    "CDPFrame",
    "CDPKeyboard",
    "CDPLocator",
    "CDPMouse",
    "CDPNavigationError",
    "CDPNetworkManager",
    "CDPPage",
    "CDPRequest",
    "CDPRoute",
    "CDPTargetClosedError",
    "CDPTimeoutError",
    "FrameTree",
    "launch_chromium",
    "set_user_agent",
    "set_viewport",
]
