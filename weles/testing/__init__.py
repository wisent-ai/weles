"""Failure reason testing: isolate scripts and compare traffic fingerprints."""

from .isolate import isolate_failure
from .fingerprint_diff import on_failure as fingerprint_diff_on_failure

__all__ = ["isolate_failure", "fingerprint_diff_on_failure"]
