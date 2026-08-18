#!/usr/bin/env python3
"""Remove only named Codex items that do not contain a real Codex token set."""

import json
import os
import pathlib
import subprocess

HOME = pathlib.Path.home()
BINARY = HOME / ".stado/bin/skarbiec"
VAULT = HOME / ".stado/skarbiec.vault.json"
SUFFIXES = ("zuzanna", "bartlomiej", "jakub", "lukasz-wisent-com", "lukasz-gmail", "controlyourai")
ENV = {
    **os.environ,
    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "SKARBIEC_VAULT_FILE": str(VAULT),
}


def valid(document: dict) -> bool:
    try:
        value = document["fields"]["value"]
        auth = json.loads(value)
        tokens = auth["tokens"]
        return all(isinstance(tokens[name], str) and tokens[name] for name in ("access_token", "id_token", "account_id"))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


for suffix in SUFFIXES:
    item = f"provider:codex:brama-sub-wisent-app-codex-{suffix}"
    read = subprocess.run([str(BINARY), "get", item], capture_output=True, text=True, env=ENV)
    if read.returncode:
        print("absent:", item)
        continue
    document = json.loads(read.stdout)
    if valid(document):
        print("kept valid:", item)
        continue
    removed = subprocess.run([str(BINARY), "delete", item], capture_output=True, text=True, env=ENV)
    if removed.returncode:
        raise SystemExit("cannot remove invalid item: " + item)
    print("removed invalid:", item)
