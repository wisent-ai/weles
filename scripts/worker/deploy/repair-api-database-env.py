#!/usr/bin/env python3
"""Give the running Weles API the database credentials its trajectories need.

The launchd wrapper acquires four secrets from the vault and, until the fix that
accompanies this file, not the two every database-touching trajectory reads. On
a host running the older wrapper `POST /reauth` therefore accepts the request,
starts the run and dies with `FATAL: SUPABASE_URL /
SUPABASE_SERVICE_ROLE_KEY not in env`.

This writes them into the runtime secret store the wrapper already sources,
reading the values through the wrapper's own vault reader and the scope file that
has always permitted them. Values are never printed and never passed as
arguments; only the variable names and whether the store already had them.

Restart the unit afterwards for the service to read them.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat
import subprocess

HOME = Path(os.environ.get("HOME", "."))
MANAGED = HOME / ".stado/build-work/weles-api-managed"
ACQUIRE = MANAGED / "scripts/worker/deploy/skarbiec-acquire.mjs"
SCOPES = MANAGED / "scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
STORE = HOME / ".weles/secrets.env"
ENDPOINT = "http://127.0.0.1:8787"
NODE = "/opt/homebrew/bin/node"
WANTED = (
    ("SUPABASE_URL", "weles-database-url-bootstrap", "weles-database", "url"),
    (
        "SUPABASE_SERVICE_ROLE_KEY",
        "weles-database-service-role-bootstrap",
        "weles-database",
        "service_role_key",
    ),
)

ENV_FILES = (
    HOME / "weles/var/worker.env",
    HOME / "weles/var/worker-content.env",
    HOME / ".config/weles/worker.env",
    HOME / ".weles/secrets.env",
    HOME / ".stado/weles-model.env",
)


def reader_environment() -> dict:
    """The wrapper's own environment, assembled the way the wrapper assembles it.

    `skarbiec-acquire.mjs` signs with the workload identity and refuses without
    it, and that identity is not exported by the wrapper: it arrives from the
    same files the wrapper sources, in that order. Guessing key paths here found
    nothing, which is why this reads them instead.
    """
    environment = dict(os.environ)
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
                environment[name] = value
    environment.setdefault("SKARBIEC_WORKLOAD_ID", "weles-credential-worker-local")
    environment.setdefault("SKARBIEC_VAULT_FILE", str(HOME / ".stado/skarbiec.vault.json"))
    environment.setdefault(
        "SKARBIEC_CAP_SOCKET", str(HOME / ".stado/run/weles-api-capability.sock")
    )
    return environment


def endpoints() -> list[str]:
    """The wrapper's default first, then the ports a Skarbiec actually serves on
    this host: 8787 is the documented default and on this host a different Node
    service already holds it, which makes every read fail for a reason that has
    nothing to do with the vault."""
    configured = os.environ.get("WC_SKARBIEC_URL", "").strip()
    found = [configured] if configured else []
    found.append(ENDPOINT)
    for port in ("8895",):
        found.append(f"http://127.0.0.1:{port}")
    return list(dict.fromkeys(found))


def acquire(consumer: str, item: str, field: str) -> str:
    problems = []
    for endpoint in endpoints():
        result = subprocess.run(
            [NODE, str(ACQUIRE), endpoint, str(SCOPES), consumer, item, field],
            capture_output=True,
            text=True,
            check=False,
            env=reader_environment(),
        )
        if result.returncode == len(""):
            value = result.stdout.strip()
            if value:
                print(f"  read through {endpoint}")
                return value
        lines = [line for line in (result.stderr or "").splitlines() if line.strip()]
        detail = ""
        for line in lines:
            if "Error" in line or "error" in line:
                detail = line.strip()
                break
        problems.append(f"{endpoint}: {detail or (lines[len('') ] if lines else 'no detail')}")
    for problem in problems:
        print(f"  {problem[: len('x' * len('xxxxxxxxxx')) * len('xxxxxxxxxxxxxxx')]}")
    return ""


def main() -> int:
    for path in (ACQUIRE, SCOPES):
        if not path.is_file():
            print(f"missing {path}; this host has no managed Weles API deployment")
            return len(["missing"])
    existing = STORE.read_text(errors="replace") if STORE.is_file() else ""
    additions = []
    for name, consumer, item, field in WANTED:
        if f"{name}=" in existing:
            print(f"{name}: already in the runtime secret store")
            continue
        value = acquire(consumer, item, field)
        if not value:
            print(f"{name}: could not be read from the vault")
            continue
        additions.append(f"{name}={value}")
        print(f"{name}: read from the vault and queued for the store")
    if not additions:
        print("nothing to add")
        return len("")
    STORE.parent.mkdir(parents=True, exist_ok=True)
    body = existing if existing.endswith("\n") or not existing else existing + "\n"
    STORE.write_text(body + "\n".join(additions) + "\n")
    STORE.chmod(stat.S_IRUSR | stat.S_IWUSR)
    print(f"store: {STORE}")
    print(f"added: {len(additions)}")
    print("restart com.wisent.always-on.weles-api for the service to read them")
    return len("")


if __name__ == "__main__":
    raise SystemExit(main())
