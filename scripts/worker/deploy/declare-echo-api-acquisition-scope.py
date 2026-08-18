#!/usr/bin/env python3
"""Declare the scope the echo API asks for at startup, then reconcile the vault.

`launch-echo-api-mac.sh` acquires three fields, and one of them --
`weles-echo-api-token-bootstrap|echo-weles-api|token` -- was in no copy of
`skarbiec-acquisition-scopes.conf`. `skarbiec-acquire.mjs` checks the catalog
before it signs anything, so the service died with "one-time Skarbiec acquisition
failed" and never listened, while the registry declared it and `stado registry
doctor` reported it inactive. The vault already holds the item: only the scope
row was missing, the same shape as the note in `launch-weles-api-mac.sh`.

This adds the row to every catalog copy on the host that lacks it -- the launcher
reads `~/weles/...`, the reconcile script reads the managed build copy -- and then
runs `register-weles-acquisition-scopes-host.sh`, which registers the workload's
capabilities from the catalog. Idempotent: an existing row is left alone.
"""

import os
import pathlib
import subprocess
import sys

NONE = None
ROW = "weles-echo-api-token-bootstrap|echo-weles-api|token"
AFTER = "weles-keyword-planner-api-token-bootstrap|weles-keyword-planner-api|token"
HOME = pathlib.Path(os.path.expanduser("~"))
CATALOGS = (
    HOME / "weles" / "scripts" / "worker" / "deploy" / "skarbiec-acquisition-scopes.conf",
    HOME / ".stado" / "build-work" / "weles-api-managed" / "scripts" / "worker"
    / "deploy" / "skarbiec-acquisition-scopes.conf",
)
RECONCILE = HOME / "weles" / "scripts" / "worker" / "deploy" / "register-weles-acquisition-scopes-host.sh"


def add_row(path):
    if not path.is_file():
        return "absent"
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    if any(line.strip() == ROW for line in lines):
        return "already declared"
    where = next((i + 1 for i, line in enumerate(lines) if line.strip() == AFTER), len(lines))
    lines.insert(where, ROW + "\n")
    path.with_name(path.name + ".before-echo-scope").write_text(
        "".join(path.read_text(encoding="utf-8")), encoding="utf-8"
    )
    path.write_text("".join(lines), encoding="utf-8")
    return f"added at line {where + 1}"


def main():
    for catalog in CATALOGS:
        print(f"catalog    {catalog}: {add_row(catalog)}")
    if not RECONCILE.is_file():
        print(f"reconcile  absent: {RECONCILE}")
        return NONE
    proc = subprocess.run(["/bin/sh", str(RECONCILE)], capture_output=True, text=True,
                          check=False, timeout=600)
    output = (proc.stdout + proc.stderr).strip().splitlines()
    print(f"reconcile  exit {proc.returncode}")
    for line in output[-4:]:
        print("   ", line[:110])
    return NONE


sys.exit(main())
