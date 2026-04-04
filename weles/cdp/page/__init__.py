"""CDP Page and Frame management sub-package."""

from .frame import CDPFrame, FrameTree
from .page import CDPPage

__all__ = ["CDPFrame", "CDPPage", "FrameTree"]
