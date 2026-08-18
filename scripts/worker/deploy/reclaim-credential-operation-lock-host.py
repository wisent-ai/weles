#!/usr/bin/env python3
"""Remove a credential-operation lock left by a run that is no longer alive.

Skarbiec serializes credential operations with a lock file and says, on refusal,
to verify no Weles task is active before removing it. That verification is the
whole point of this helper: it refuses while any Codex or Claude login trajectory
is running, so a lock is never taken away from a live sign-in.
"""

from __future__ import annotations

import os
import pathlib
import re
import subprocess

HOME = pathlib.Path.home()
LOCKS = (
    HOME / ".stado/skarbiec.vault.credential-operation.lock",
    HOME / ".stado/weles-skarbiec.vault.credential-operation.lock",
)
LIVE = re.compile(r"/scripts/trajectories/(codex|claude|kimi)/(login|reauth)\.mjs")


def running_trajectories() -> list[str]:
    output = subprocess.check_output(
        ["/bin/ps", "ax", "-o", "pid=,command="], text=True, errors="replace"
    )
    return [
        " ".join(line.split())[:120]
        for line in output.splitlines()
        if LIVE.search(line)
    ]


def main() -> None:
    live = running_trajectories()
    if live:
        for line in live:
            print("active:", line)
        raise SystemExit("refusing to remove a lock while a login trajectory is running")
    removed = 0
    for lock in LOCKS:
        if not lock.exists():
            continue
        age = int(os.path.getmtime(lock))
        lock.unlink()
        removed += 1
        print(f"removed {lock} (mtime epoch {age})")
    print("locks removed:", removed)


if __name__ == "__main__":
    main()
