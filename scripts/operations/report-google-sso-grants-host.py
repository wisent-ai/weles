#!/usr/bin/env python3
"""Report nonsecret grants and runtime files for the Weles Google SSO reader."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

home = Path.home()
environment = dict(os.environ)
environment["SKARBIEC_VAULT_FILE"] = str(home / ".stado" / "skarbiec.vault.json")
process = subprocess.run(
    [str(home / ".stado" / "bin" / "skarbiec"), "tokens"],
    env=environment,
    text=True,
    capture_output=True,
    check=True,
)
rows = json.loads(process.stdout)
grants = []
for row in rows if isinstance(rows, list) else []:
    capabilities = [
        capability for capability in row.get("capabilities", [])
        if capability.get("item") == "weles-google-sso-login"
    ]
    if capabilities:
        grants.append({
            "consumer": row.get("consumer"),
            "expires_at": row.get("expires_at"),
            "workload_bound": row.get("workload_bound"),
            "capabilities": capabilities,
        })
paths = [
    home / ".stado" / "skarbiec.vault.json",
    home / ".stado" / "weles-google-sso-client-skarbiec-token",
    home / "weles" / "scripts" / "worker" / "deploy" / "skarbiec-acquisition-scopes.conf",
]
print(json.dumps({
    "grants": grants,
    "paths": [{"path": str(path), "exists": path.is_file()} for path in paths],
}, indent=2))
