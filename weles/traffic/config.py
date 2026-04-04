"""Configuration constants for traffic fingerprint capture.

Justification: Centralizes all tunable values (ports, paths, timeouts,
environment variable names) so that capture.py, addon.py, and compare.py
stay free of inline magic numbers and strings.
"""

# ---------------------------------------------------------------------------
# Environment variable names
# ---------------------------------------------------------------------------

# Path where the mitmproxy addon writes captured data (JSON).
CAPTURE_PATH_ENV = "WELES_CAPTURE_PATH"

# ---------------------------------------------------------------------------
# Default proxy / mitmdump settings
# ---------------------------------------------------------------------------

DEFAULT_PROXY_PORT = 8080
MITMDUMP_BINARY = "/opt/homebrew/bin/mitmdump"

# Maximum seconds to wait for mitmdump to become ready after launch.
MITMDUMP_STARTUP_TIMEOUT_S = 5

# ---------------------------------------------------------------------------
# Capture limits (prevent unbounded memory use in the addon)
# ---------------------------------------------------------------------------

# Maximum number of requests/responses to record per session.
MAX_CAPTURED_FLOWS = 5000

# Maximum header value length stored (longer values are truncated).
MAX_HEADER_VALUE_LEN = 2000

# Maximum cookie value length stored.
MAX_COOKIE_VALUE_LEN = 1000

# ---------------------------------------------------------------------------
# Comparison thresholds
# ---------------------------------------------------------------------------

# Headers that commonly differ due to caching / session state and are
# excluded from "missing header" diff by default.
IGNORED_DIFF_HEADERS = frozenset([
    "date",
    "age",
    "x-request-id",
    "x-amz-cf-id",
    "x-amz-cf-pop",
    "x-cache",
    "cf-ray",
    "report-to",
    "nel",
    "via",
    "etag",
    "last-modified",
    "expires",
    "x-served-by",
])

# Number of initial requests to compare for ordering analysis.
REQUEST_ORDER_COMPARISON_LEN = 20

# Maximum number of unique sample values to show per header in diffs.
MAX_SAMPLE_VALUES = 5
