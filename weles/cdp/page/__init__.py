"""CDP Page and Frame management sub-package."""

from .frame import CDPFrame, FrameTree
from .page import CDPPage
from .screencast import CDPScreencast, CDPVideo

__all__ = ["CDPFrame", "CDPPage", "CDPScreencast", "CDPVideo", "FrameTree"]
