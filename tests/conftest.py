"""Shared fixtures and configuration for the weles test suite."""

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "browser: mark test as requiring a real browser (skip in CI with -m 'not browser')",
    )
