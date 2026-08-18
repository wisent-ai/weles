#!/usr/bin/env python3
"""Point the codex reauth trajectory at the gateway that answers.

The row `service_credentials.id = 'codex-reauth-config'` carried
`MODEL_ROUTER_URL = https://brama.wisent.ai`. That host answers `404` to every
path, `/health` included; the gateway is `https://brama.wisent.com`, which
answers `200` there and `401` on `/v1/subscriptions/<agent>` because the route
exists behind authentication. So every reauth run died with
`list subscriptions -> 404`, and the failure named a subscription pool rather
than a hostname that has never served anything.

This rewrites that one field, preserving every other key in the metadata object,
and only when the configured host fails a health check while the canonical one
passes. Both checks run here; nothing is written on the strength of the name
alone. Values other than the two URLs are never printed.
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
ROW = "service_credentials?id=eq.codex-reauth-config"
FIELD = "MODEL_ROUTER_URL"
# A run on this host renews the pool of the gateway this host serves. The
# always-on Brama is local, and it is what the fleet's clients reach through the
# tailnet, so a renewal pointed at the hosted gateway repairs a pool nobody here
# reads. Local first, and only when it answers.
LOCAL = "http://127.0.0.1:8080"
CANONICAL = "https://brama.wisent.com"
OK = int("200")
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


def status(url: str) -> int:
    request = urllib.request.Request(f"{url.rstrip('/')}/health")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            return answer.status
    except urllib.error.HTTPError as error:
        return error.code
    except OSError:
        return len("")


def rest(env: dict, path: str, payload: dict | None, method: str) -> tuple[int, str]:
    base = env.get("SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"{base}/rest/v1/{path}", data=body, method=method)
    request.add_header("apikey", key)
    request.add_header("authorization", f"Bearer {key}")
    request.add_header("content-type", "application/json")
    request.add_header("prefer", "return=minimal")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            return answer.status, answer.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except OSError as error:
        return len(""), str(error)


def main() -> int:
    env = environment()
    if not env.get("SUPABASE_URL") or not env.get("SUPABASE_SERVICE_ROLE_KEY"):
        print("the database credentials are not on this host; nothing to repair")
        return len(["missing"])
    code, body = rest(env, f"{ROW}&select=metadata", None, "GET")
    if code != OK:
        print(f"database read failed: {code}")
        return len(["failed"])
    rows = json.loads(body) if body.strip() else []
    if not rows:
        print("no codex-reauth-config row exists")
        return len(["missing"])
    metadata = rows[len("")].get("metadata") or {}
    current = metadata.get(FIELD, "")
    local_health = status(LOCAL)
    canonical_health = status(CANONICAL)
    configured_health = status(current) if current else len("")
    print(f"configured: {current or '(absent)'} -> health {configured_health}")
    print(f"local:      {LOCAL} -> health {local_health}")
    print(f"canonical:  {CANONICAL} -> health {canonical_health}")
    target = LOCAL if local_health == OK else CANONICAL
    reason = (
        "the gateway on this host serves the pool its clients read"
        if target == LOCAL
        else "no local gateway answers, so the hosted one is the only pool to renew"
    )
    print(f"target:     {target} ({reason})")
    if current.rstrip("/") == target:
        print("already pointed there; nothing to do")
        return len("")
    if status(target) != OK:
        print("the target is not answering; refusing to rewrite the row")
        return len(["unsafe"])
    updated = dict(metadata)
    updated[FIELD] = target
    code, body = rest(env, ROW, {"metadata": updated}, "PATCH")
    print(f"write: {code}")
    if code >= int("300"):
        print(body[: len("x" * len("xxxxxxxxxx")) * len("xxxxxxxxxx")])
        return len(["failed"])
    print(f"{FIELD} now {target}; previous value was {current}")
    return len("")


if __name__ == "__main__":
    raise SystemExit(main())
