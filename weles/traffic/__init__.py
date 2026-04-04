"""Traffic fingerprint capture and comparison.

Justification: Package init that exports the two main public symbols —
``TrafficCapture`` for recording browser sessions through mitmproxy, and
``compare_captures`` for diffing a real vs automated capture.

Usage:
    from weles.traffic import TrafficCapture, compare_captures

    # Record
    tc = TrafficCapture()
    tc.start(port=8090)
    # ... run browser through proxy ...
    tc.stop()
    tc.save("capture.json")

    # Compare
    diff = compare_captures("real.json", "automated.json")
"""

from .capture import TrafficCapture
from .compare import compare_captures

__all__ = ["TrafficCapture", "compare_captures"]
