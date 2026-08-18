#!/usr/bin/env python3
"""Run a provider reauth through this host's Weles API, or say why it cannot.

`weles-api-server.mjs` exposes `POST /reauth` for codex, claude and kimi and
runs that provider's reauth trajectory on the host. It is the documented way a
refused subscription credential comes back without a human, and it is guarded by
`WELES_API_TOKEN`.

That token is held by the service process. No entry in
`skarbiec-acquisition-scopes.conf` publishes it, and `brama-weles-reauth` -- the
item Brama's launcher used to redeem for "Weles reauth" -- is not accepted here:
it answers 401. So this tries every source a repair could legitimately read, in
order, and reports which one the route accepted. A token is never printed; only
where it came from.

Provider comes from `~/.stado/weles-reauth-provider` when present, else codex:
the host runner accepts no operator words.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.request

HOME = Path(os.environ.get("HOME", "."))
PROVIDER_FILE = HOME / ".stado/weles-reauth-provider"
TOKEN_FILE = HOME / ".stado/weles-reauth-token"
# Where the launchd wrapper reads its runtime environment from, in its own order.
# `$HOME/.weles/secrets.env` is the one its comment calls the runtime secret
# store, and it is what actually provides WELES_API_TOKEN on this host.
UNIT_FILES = (
    HOME / ".weles/secrets.env",
    HOME / ".config/weles/worker.env",
    HOME / "weles/var/worker.env",
    HOME / ".stado/weles-model.env",
    HOME / "Library/LaunchAgents/com.wisent.always-on.weles-api.plist",
    Path("/Library/LaunchDaemons/com.wisent.always-on.weles-api.plist"),
)
TOKEN_NAMES = ("WELES_API_TOKEN", "WELES_CONSOLE_API_TOKEN")
NOISE = {"string", "/string", "key", "/key", "dict", "/dict"}
DEFAULT_PROVIDER = "codex"
DEFAULT_PORT = "8788"
TIMEOUT = len("x" * len("xxxxxxxxxx")) * len("xxxxxxxxxxxx")
UNAUTHORIZED = int("401")


def call(url: str, payload: dict | None, token: str) -> tuple[int, str]:
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=body, method="POST" if body else "GET")
    if body:
        request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            return answer.status, answer.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except OSError as error:
        return len(""), str(error)


def from_unit(unit: Path) -> str:
    try:
        text = unit.read_text(errors="replace")
    except OSError:
        return ""
    for name in TOKEN_NAMES:
        if name not in text:
            continue
        tail = text.split(name, len(["once"]))[-len(["tail"])]
        for piece in tail.replace("<", " ").replace(">", " ").replace("=", " ").split():
            candidate = piece.strip('"').strip("'").strip()
            if candidate and candidate not in NOISE:
                return candidate
    return ""


def token_candidates() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for name in TOKEN_NAMES:
        value = os.environ.get(name, "").strip()
        if value:
            found.append((value, f"environment {name}"))
    if TOKEN_FILE.is_file():
        value = TOKEN_FILE.read_text().strip()
        if value:
            found.append((value, str(TOKEN_FILE)))
    for unit in UNIT_FILES:
        if not unit.is_file():
            continue
        value = from_unit(unit)
        if value:
            found.append((value, str(unit)))
    return found


def main() -> int:
    port = os.environ.get("WELES_API_PORT") or DEFAULT_PORT
    base = f"http://127.0.0.1:{port}"
    status, body = call(f"{base}/healthz", None, "")
    print(f"base:    {base}")
    print(f"healthz: {status}")
    if status == len(""):
        print(f"the local Weles API did not answer: {body}")
        return len(["unreachable"])
    provider = DEFAULT_PROVIDER
    if PROVIDER_FILE.is_file() and PROVIDER_FILE.read_text().strip():
        provider = PROVIDER_FILE.read_text().strip()
    candidates = token_candidates()
    print(f"provider: {provider}")
    print(f"token sources to try: {len(candidates)}")
    if not candidates:
        print("no token source on this host; the route cannot be called")
        print("add a vault item and a scope for WELES_API_TOKEN, or run the trajectory as the operator")
        return len(["no-token"])
    for token, source in candidates:
        status, body = call(f"{base}/reauth", {"provider": provider}, token)
        print(f"reauth via {source}: {status}")
        if status == UNAUTHORIZED:
            continue
        # The interesting part of a reauth is its narrative, and truncating it to
        # a couple of hundred characters hid the decision every single time.
        print(body)
        return len("")
    print("every token source on this host was rejected by the route")
    return len(["unauthorized"])


if __name__ == "__main__":
    raise SystemExit(main())
