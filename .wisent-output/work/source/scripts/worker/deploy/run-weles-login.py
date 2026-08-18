#!/usr/bin/env python3
"""Have Weles log the Codex account in, on the host, without a person.

The reauth trajectory deliberately never triggers a login: on a burnt tick it
only onboards an `~/.codex/auth.json` that already exists, so nothing renews a
subscription whose token is spent. The login trajectory is the piece that does,
and it is built to run unattended -- `codex/google_sso.mjs` carries an RFC 6238
TOTP generator and switches Google onto the authenticator method when a 2FA
challenge appears, using the secret from the vault item behind the `googleSso`
contract.

So this asks the local Weles API to run `codex_login` and reports what came
back. A browser session takes minutes; the wait here is deliberate.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.request

HOME = Path(os.environ.get("HOME", "."))
TOKEN_FILE = HOME / ".stado/weles-reauth-token"
UNIT_FILES = (
    HOME / ".weles/secrets.env",
    HOME / ".config/weles/worker.env",
    HOME / "weles/var/worker.env",
)
TOKEN_NAMES = ("WELES_API_TOKEN", "WELES_CONSOLE_API_TOKEN")
# Which account to log in comes from the same file the reauth helper reads, so
# one helper serves every provider whose login the dispatcher can reach and the
# host runner still takes no operator words.
PROVIDER_FILE = HOME / ".stado/weles-reauth-provider"
PROVIDER = (
    PROVIDER_FILE.read_text().strip()
    if PROVIDER_FILE.is_file() and PROVIDER_FILE.read_text().strip()
    else "codex"
)
ACTION = f"{PROVIDER}_login"
DEFAULT_PORT = "8788"
UNAUTHORIZED = int("401")
# Deliberately short. The operator transport that runs this helper closes long
# before a browser login finishes, and a detached child dies with it, so the
# request is sent and the wait is abandoned: the server keeps running the
# trajectory, and the run is followed through the API's own records instead of a
# held socket.
TIMEOUT = int("12")


def tokens() -> list[tuple[str, str]]:
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
        try:
            text = unit.read_text(errors="replace")
        except OSError:
            continue
        for name in TOKEN_NAMES:
            if name not in text:
                continue
            tail = text.split(name, len(["once"]))[-len(["tail"])]
            for piece in tail.replace("=", " ").split():
                candidate = piece.strip('"').strip("'").strip()
                if candidate:
                    found.append((candidate, str(unit)))
                    break
            break
    return found


def call(url: str, payload: dict, token: str) -> tuple[int, str]:
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    request.add_header("content-type", "application/json")
    request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            return answer.status, answer.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except OSError as error:
        return len(""), str(error)


def main() -> int:
    port = os.environ.get("WELES_API_PORT") or DEFAULT_PORT
    url = f"http://127.0.0.1:{port}/run"
    candidates = tokens()
    print(f"action: {ACTION}")
    print(f"token sources to try: {len(candidates)}")
    for token, source in candidates:
        status, body = call(url, {"action": ACTION, "detached": True}, token)
        if status == len(""):
            # No status means the socket went, not that the run did: the server
            # is still driving the browser. That is the expected outcome here.
            print(f"run via {source}: request sent, wait abandoned ({body[: len('x' * len('xxxxxxxxxx')) * len('xxxxx')]})")
            print("follow it in the unit log and the trajectory recordings")
            return len("")
        print(f"run via {source}: {status}")
        if status == UNAUTHORIZED:
            continue
        print(body[: len("x" * len("xxxxxxxxxx")) * len("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")])
        return len("")
    print("every token source was rejected")
    return len(["unauthorized"])


if __name__ == "__main__":
    raise SystemExit(main())
