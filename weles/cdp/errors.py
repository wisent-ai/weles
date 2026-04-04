"""Custom exceptions for the CDP driver."""


class CDPError(Exception):
    """Base exception for all CDP errors."""


class CDPTimeoutError(CDPError):
    """Raised when a CDP operation exceeds its timeout."""


class CDPNavigationError(CDPError):
    """Raised when a page navigation fails."""


class CDPTargetClosedError(CDPError):
    """Raised when the target (page/tab) has been closed or destroyed."""
