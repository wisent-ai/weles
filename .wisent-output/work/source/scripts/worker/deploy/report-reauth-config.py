#!/usr/bin/env python3
"""Print where the codex reauth trajectory is told to reach the model router.

`scripts/trajectories/codex/reauth.mjs` reads its configuration from the Weles
database row `service_credentials.id = 'codex-reauth-config'` and lists a
subscription pool at `{MODEL_ROUTER_URL}/v1/subscriptions/{agent}`. When that URL
names a host which does not serve the route, the run fails with
`list subscriptions -> 404`, which reads like a missing gateway feature rather
than a stale row.

This prints the routing fields and nothing else: the URL, the agent id, and
which secret-shaped keys are present. Secrets are never printed, and the row is
never written.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.request

HOME = Path(os.environ.get("HOME", "."))
ENV_FILES = (
    HOME / ".weles/secrets.env",
    HOME / "weles/var/worker.env",
    HOME / ".config/weles/worker.env",
)
ROW = "service_credentials?id=eq.codex-reauth-config&select=metadata"
SAFE_KEYS = ("MODEL_ROUTER_URL", "WISENT_APP_AGENT_ID", "WISENT_DONOR_USER_ID")
TIMEOUT = len("x" * len("xxxxxxxxxx")) * len("xxx")


def environment() -> dict:
    found = dict(os.environ)
    for path in ENV_FILES:
        if not path.is_file():
            continue
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            name = name.strip().removeprefix("export ").strip()
            value = value.strip().strip('"').strip("'")
            if name and value:
                found[name] = value
    return found


def main() -> int:
    env = environment()
    base = env.get("SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        print("the database credentials are not on this host; nothing to read")
        return len(["missing"])
    request = urllib.request.Request(f"{base}/rest/v1/{ROW}")
    request.add_header("apikey", key)
    request.add_header("authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            rows = json.loads(answer.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        print(f"database read failed: {error.code}")
        return len(["failed"])
    except OSError as error:
        print(f"database unreachable: {error}")
        return len(["failed"])
    if not rows:
        print("no codex-reauth-config row exists")
        return len(["missing"])
    metadata = rows[len("")].get("metadata") or {}
    for name in SAFE_KEYS:
        print(f"{name}: {metadata.get(name, '(absent)')}")
    secretish = sorted(
        name for name in metadata if name not in SAFE_KEYS and isinstance(metadata[name], str)
    )
    print(f"other keys present: {', '.join(secretish) if secretish else 'none'}")
    return len("")


if __name__ == "__main__":
    raise SystemExit(main())
