#!/usr/bin/env python3
"""Provision the six named ChatGPT Business seat logins in Skarbiec.

The fleet vault remains the password source of truth. This helper copies each
login into Weles's authority and grants only its username/password acquisitions.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess

HOME = pathlib.Path.home()
SOURCE_VAULT = pathlib.Path(os.environ.get("SOURCE_VAULT", HOME / ".stado/skarbiec.vault.json"))
# Which authority vault Weles actually resolves logins from. It is delivered as
# data because the answer has moved: a hand-started authority served the Weles
# vault until that file left the host, and the worker environment now names the
# fleet authority. A path baked in here would keep provisioning grants into a
# vault nothing reads.
_TARGET_MARKER = HOME / ".stado/weles-authority-vault"
TARGET_VAULT = pathlib.Path(
    os.environ.get("TARGET_VAULT")
    or (_TARGET_MARKER.read_text(encoding="utf-8").strip() if _TARGET_MARKER.is_file() else "")
    or HOME / ".stado/weles-skarbiec.vault.json"
)
WORKLOAD_KEY = pathlib.Path(
    os.environ.get("WELES_WORKLOAD_PUBLIC_KEY_FILE", HOME / ".stado/weles-credential-workload-public.pem")
)
RUNTIME_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SEATS = (
    ("codex-lukasz-google-sso", "weles-codex-lukasz-gmail-client", "Codex_lukasz_gmail", "lukasz.bartoszcze@gmail.com"),
    ("codex-controlyourai-google-sso", "weles-codex-controlyourai-client", "Codex_controlyourai", "controlyourai@gmail.com"),
    ("codex-bartlomiej-wisent-google-sso", "weles-codex-bartlomiej-wisent-client", "Codex_bartlomiej_wisent", "bartlomiej@wisent.ai"),
    ("codex-jakub-wisent-google-sso", "weles-codex-jakub-wisent-client", "Codex_jakub_wisent", "jakub@wisent.ai"),
    ("codex-zuzanna-google-sso", "weles-codex-zuzanna-gmail-client", "Codex_zuzanna_gmail", "zuzanna.bartoszcze@gmail.com"),
    ("codex-lukasz-wisent-com-google-sso", "weles-codex-lukasz-wisent-com-client", "Codex_lukasz_wisent_com", "lukasz@wisent.com"),
)


def load_environment() -> dict[str, str]:
    values = dict(os.environ)
    candidates = (
        HOME / "weles/var/worker-content.env",
        HOME / ".config/weles/worker.env",
        HOME / ".weles/secrets.env",
        HOME / ".stado/weles-model.env",
    )
    for path in candidates:
        if not path.is_file():
            continue
        for raw in path.read_text(errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip().strip('"').strip("'")
    return values


def skarbiec_binary() -> pathlib.Path:
    candidates = (
        HOME / ".stado/services/brama/current/darwin-arm/bin/skarbiec-entitlements-router",
        HOME / ".stado/bin/skarbiec",
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise SystemExit("no executable Skarbiec binary on this host")


def run_skarbiec(binary: pathlib.Path, vault: pathlib.Path, arguments: list[str], *, stdin: str | None = None) -> str:
    environment = {
        **os.environ,
        "PATH": RUNTIME_PATH,
        "SKARBIEC_VAULT_FILE": str(vault),
    }
    result = subprocess.run(
        [str(binary), *arguments],
        input=stdin,
        text=True,
        capture_output=True,
        env=environment,
    )
    if result.returncode:
        detail = " ".join(result.stderr.split())
        raise SystemExit(f"skarbiec {' '.join(arguments[:2])} failed: {detail}")
    return result.stdout




def main() -> None:
    for path in (SOURCE_VAULT, TARGET_VAULT, WORKLOAD_KEY):
        if not path.is_file():
            raise SystemExit(f"required file is absent: {path}")
    binary = skarbiec_binary()
    for item, consumer_prefix, display_name, email in SEATS:
        payload_text = run_skarbiec(binary, SOURCE_VAULT, ["get", item])
        payload = json.loads(payload_text)
        fields = payload.get("fields") if isinstance(payload, dict) else None
        if not isinstance(fields, dict) or not fields.get("username") or not fields.get("password"):
            raise SystemExit(f"source item is incomplete: {item}")
        if fields["username"].strip().lower() != email.lower():
            raise SystemExit(f"source account does not match its declared seat: {item}")
        run_skarbiec(binary, TARGET_VAULT, ["set-json", item, "--type", "login"], stdin=payload_text)
        for field in ("username", "password"):
            consumer = f"{consumer_prefix}-{field}"
            run_skarbiec(
                binary,
                TARGET_VAULT,
                [
                    "token-mint",
                    consumer,
                    "--capabilities",
                    f"acquire:{item}#{field}",
                    "--workload-public-key-file",
                    str(WORKLOAD_KEY),
                ],
            )
        print(f"provisioned: {item} -> {display_name} ({email})")
    print(f"provisioned seats: {len(SEATS)}")


if __name__ == "__main__":
    main()
