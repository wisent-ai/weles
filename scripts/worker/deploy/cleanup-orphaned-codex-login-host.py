#!/usr/bin/env python3
"""Stop only stale, orphaned Codex login trees on the managed Weles host."""

from __future__ import annotations

import os
import signal
import subprocess
import time

MIN_AGE_SECONDS = 300


def elapsed_seconds(value: str) -> int:
    parts = value.strip().split("-")
    days = int(parts[0]) if len(parts) == 2 else 0
    clock = parts[-1].split(":")
    clock = [int(part) for part in clock]
    if len(clock) == 3:
        hours, minutes, seconds = clock
    elif len(clock) == 2:
        hours, minutes, seconds = 0, *clock
    else:
        hours, minutes, seconds = 0, 0, clock[0]
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def processes() -> dict[int, dict[str, object]]:
    output = subprocess.check_output(
        ["/bin/ps", "ax", "-o", "pid=,ppid=,etime=,command="],
        text=True,
        errors="replace",
    )
    rows: dict[int, dict[str, object]] = {}
    for line in output.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) != 4:
            continue
        pid, ppid, elapsed, command = parts
        rows[int(pid)] = {
            "ppid": int(ppid),
            "elapsed": elapsed_seconds(elapsed),
            "command": command,
        }
    return rows


def descendants(rows: dict[int, dict[str, object]], root: int) -> set[int]:
    selected = {root}
    changed = True
    while changed:
        changed = False
        for pid, row in rows.items():
            if pid not in selected and row["ppid"] in selected:
                selected.add(pid)
                changed = True
    return selected


def main() -> None:
    rows = processes()
    roots = [
        pid
        for pid, row in rows.items()
        if row["ppid"] == 1
        and row["elapsed"] >= MIN_AGE_SECONDS
        and "/scripts/trajectories/codex/login.mjs" in str(row["command"])
    ]
    if not roots:
        print("orphaned Codex login trees: 0")
        return
    targets: set[int] = set()
    for root in roots:
        targets.update(descendants(rows, root))
    # Children first: let recorders and browser helpers flush before their parent.
    ordered = sorted(targets, key=lambda pid: rows[pid]["elapsed"])
    for pid in ordered:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(3)
    remaining = processes()
    killed = 0
    for pid in ordered:
        if pid not in remaining:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
            killed += 1
        except ProcessLookupError:
            pass
    print(f"orphaned Codex login roots: {len(roots)}")
    print(f"targeted processes: {len(targets)}")
    print(f"required SIGKILL: {killed}")


if __name__ == "__main__":
    main()
