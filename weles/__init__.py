"""Weles: Stealth browser automation with fingerprint spoofing."""

import os as _os

from .async_api import AsyncWeles, AsyncNewBrowser
from .sync_api import Weles, NewBrowser
from .capture import Capture
from .proxy import ProxyConfig, ProxyPool
from .captcha import CaptchaSolver, detect_captcha, solve_page_captcha
from .cloudflare import wait_cloudflare, bypass_cloudflare
from .session import SessionStore
from .testing import isolate_failure
from .cdp import CDPWeles, CDPNewBrowser

__version__ = "0.3.0"
__all__ = [
    "AsyncWeles", "AsyncNewBrowser", "Weles", "NewBrowser", "Capture",
    "CDPWeles", "CDPNewBrowser",
    "ProxyConfig", "ProxyPool", "CaptchaSolver", "detect_captcha",
    "solve_page_captcha", "wait_cloudflare", "bypass_cloudflare", "SessionStore",
    "prune_recordings",
]

# All weles input is human-like by default. Set WELES_INSTANT_INPUT=1 to
# disable Bezier-curve mouse motion and per-character typing delays for
# tests where speed matters more than realism.


def prune_recordings(path: str, max_bytes: int) -> None:
    """Delete oldest files in `path` until total size is under `max_bytes`.

    Walks `path` recursively and removes files (oldest mtime first) when
    cumulative size exceeds the budget. Sidecar files sharing the same
    stem as a deleted file are removed alongside their parent. Failures
    (file in use, permission denied) are silently skipped.
    """
    try:
        if not _os.path.isdir(path):
            return
        files = []
        for root, _, names in _os.walk(path):
            for name in names:
                fp = _os.path.join(root, name)
                try:
                    st = _os.stat(fp)
                    files.append((st.st_mtime, st.st_size, fp))
                except OSError:
                    pass
        files.sort()  # oldest first
        total = sum(sz for _, sz, _ in files)
        if total <= max_bytes:
            return
        sidecar_exts = (".json", ".txt", ".log", ".png", ".webm", ".har")
        for _, size, fp in files:
            if total <= max_bytes:
                break
            try:
                _os.unlink(fp)
                total -= size
            except OSError:
                continue
            stem, _ext = _os.path.splitext(fp)
            for sc_ext in sidecar_exts:
                sc = stem + sc_ext
                if sc != fp and _os.path.exists(sc):
                    try:
                        sc_size = _os.path.getsize(sc)
                        _os.unlink(sc)
                        total -= sc_size
                    except OSError:
                        pass
    except Exception:
        pass
