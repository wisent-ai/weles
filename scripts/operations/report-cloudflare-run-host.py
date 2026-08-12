#!/usr/bin/env python3
"""Report the newest Cloudflare task result without exposing credentials."""
from __future__ import annotations

import json
from pathlib import Path

roots = [Path.home() / ".stado" / "build-work" / "weles-api-managed" / "recordings", Path.home() / "recordings"]
candidates = []
for root in roots:
    if not root.exists():
        continue
    for path in root.rglob("generic_task_result.json"):
        try:
            document = json.loads(path.read_text(errors="replace"))
        except Exception:
            continue
        if document.get("url") != "https://dash.cloudflare.com/login":
            continue
        candidates.append((path.stat().st_mtime, path, document))
if not candidates:
    raise SystemExit("no Cloudflare task result found")
_, path, document = max(candidates)
run_root = path.parent
history = document.get("history") or []
artifacts = []
for candidate in sorted(run_root.rglob("*")):
    if not candidate.is_file() or candidate == path:
        continue
    suffix = candidate.suffix.lower()
    if suffix not in {".html", ".json", ".txt"}:
        continue
    artifacts.append({
        "name": str(candidate.relative_to(run_root)),
        "bytes": candidate.stat().st_size,
    })
print(json.dumps({
    "path": path.name,
    "ok": document.get("ok"),
    "final_path": str(document.get("final_url") or "").split("?", 1)[0],
    "error": str(document.get("error") or "")[:300],
    "completed_at": document.get("completed_at"),
    "steps": len(history),
    "last_steps": [{"tool": row.get("tool"), "result": str(row.get("result") or "")[:120]} for row in history[-4:]],
    "artifacts": [row["name"] for row in artifacts[-20:]],
}, indent=2))
