#!/usr/bin/env python3
"""Point Weles credential resolution at the authority that serves its own vault.

Weles login accounts are provisioned into the Weles Skarbiec vault, and only the
authority serving that file can answer for them. When the worker environment
names a different authority every acquisition is refused with `unauthorized`,
which reads as a broken grant while the grant is intact and simply somewhere
else. The endpoint is data: it is delivered in
`$HOME/.stado/weles-credential-authority` and written into the launcher
environment, with the previous file kept beside it for one-edit rollback.
"""

from __future__ import annotations

import pathlib
import re
import shutil
import time

HOME = pathlib.Path.home()
REQUEST = HOME / ".stado/weles-credential-authority"
ENV_FILE = HOME / ".config/weles/worker.env"
KEYS = ("WELES_SKARBIEC_URL", "WELES_CREDENTIAL_SKARBIEC_URL", "WC_SKARBIEC_URL")
LOOPBACK = re.compile(r"^http://127\.0\.0\.1:(\d{2,5})$")


def main() -> None:
    if not REQUEST.is_file():
        raise SystemExit(f"no delivered endpoint at {REQUEST}")
    endpoint = REQUEST.read_text(encoding="utf-8").strip()
    if not LOOPBACK.fullmatch(endpoint):
        raise SystemExit("endpoint must be an authenticated loopback http URL")
    if not ENV_FILE.is_file():
        raise SystemExit(f"no worker environment at {ENV_FILE}")
    original = ENV_FILE.read_text(encoding="utf-8")
    before = {
        key: value
        for line in original.splitlines()
        for key, _, value in [line.strip().partition("=")]
        if key in KEYS
    }
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup = ENV_FILE.with_name(f"{ENV_FILE.name}.before-authority-{stamp}")
    shutil.copyfile(ENV_FILE, backup)
    kept = [
        line
        for line in original.splitlines()
        if line.strip().partition("=")[0] not in KEYS
    ]
    kept.extend(f"{key}={endpoint}" for key in KEYS)
    ENV_FILE.write_text("\n".join(kept) + "\n", encoding="utf-8")
    ENV_FILE.chmod(0o600)
    for key in KEYS:
        print(f"{key}: {before.get(key, '(absent)')} -> {endpoint}")
    print("previous copy:", backup)
    REQUEST.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
