"""CDP page abstraction."""

from .page import CDPPage
from .frame import CDPFrame, FrameTree

__all__ = ["CDPPage", "CDPFrame", "FrameTree"]
