"""DOM interaction sub-package for the CDP driver."""

from .locator import CDPLocator
from .vision import ask_page, check_page, identify_page

__all__ = ["CDPLocator", "ask_page", "check_page", "identify_page"]
