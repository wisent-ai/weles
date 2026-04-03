"""Weles exceptions."""


class WelesError(Exception):
    """Base exception for Weles."""


class FingerprintError(WelesError):
    """Error generating or applying a fingerprint."""
