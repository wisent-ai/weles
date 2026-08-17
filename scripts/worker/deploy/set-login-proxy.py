#!/usr/bin/env python3
"""Tell the account logins which proxy pool to use on this host.

`claude/login.mjs` reads `CLAUDE_LOGIN_PROXY` and defaults to `residential us`.
That default is right for scraping a hostile site; it is wrong for signing this
fleet's own account in, because the residential pools this installation is
allowed to use are retired by proxy policy and the session refuses to start with
`proxy_unavailable: requested residential us`. Retiring them was deliberate, so
the answer is to name a pool that exists rather than to override the policy.

A login from the always-on host's own address is what a real person's session
looks like anyway, so `none` is the honest selector here.

Writes into the runtime environment file the launchd wrapper already sources,
only when the variable is absent, and never prints a secret.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat

HOME = Path(os.environ.get("HOME", "."))
STORE = HOME / ".weles/secrets.env"
WANTED = (
    ("CLAUDE_LOGIN_PROXY", "none"),
    ("CODEX_LOGIN_PROXY", "none"),
)


def main() -> int:
    existing = STORE.read_text(errors="replace") if STORE.is_file() else ""
    additions = []
    for name, value in WANTED:
        if f"{name}=" in existing:
            print(f"{name}: already set in the runtime environment")
            continue
        additions.append(f"{name}={value}")
        print(f"{name}: set to {value}")
    if not additions:
        print("nothing to add")
        return len("")
    STORE.parent.mkdir(parents=True, exist_ok=True)
    body = existing if not existing or existing.endswith("\n") else existing + "\n"
    STORE.write_text(body + "\n".join(additions) + "\n")
    STORE.chmod(stat.S_IRUSR | stat.S_IWUSR)
    print(f"store: {STORE}")
    print("restart com.wisent.always-on.weles-api for the service to read them")
    return len("")


if __name__ == "__main__":
    raise SystemExit(main())
