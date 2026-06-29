#!/usr/bin/env python3
"""Find a recent Meta/Facebook OTP in local Messages without printing it.

The script only inspects recent Messages rows and searches text/attributed
payloads for Meta/Facebook-style six digit verification codes. It never prints
message bodies or the code. With --run-developer-verify it submits the code to
the Weles Meta developer verification trajectory.
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path


KEYWORD_RE = re.compile(
    r"(meta|facebook|fb|developer|verification|verify|confirmation|code|kod)",
    re.IGNORECASE,
)
CODE_RE = re.compile(r"\b(\d{6})\b")


def printable_chunks(blob: bytes) -> list[str]:
    chunks: list[str] = []
    chunks.extend(
        item.decode("utf-8", "ignore")
        for item in re.findall(rb"[ -~]{4,}", blob)
    )
    chunks.extend(
        item.decode("utf-16le", "ignore")
        for item in re.findall(rb"(?:[ -~]\x00){4,}", blob)
    )
    return chunks


def find_code(db_path: Path, lookback_seconds: int) -> str | None:
    if not db_path.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = con.execute(
            """
            SELECT coalesce(h.id, ''), coalesce(m.text, ''), m.attributedBody
            FROM message m
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.date > ((strftime('%s','now') - ? - 978307200) * 1000000000)
            ORDER BY m.date DESC
            LIMIT 200
            """,
            (lookback_seconds,),
        ).fetchall()
    except sqlite3.Error:
        return None

    for handle, text, attributed_body in rows:
        parts = [handle or "", text or ""]
        if attributed_body:
            parts.extend(printable_chunks(bytes(attributed_body)))
        candidate = " ".join(parts)
        if not KEYWORD_RE.search(candidate):
            continue
        match = CODE_RE.search(candidate)
        if match:
            return match.group(1)
    return None


def run_developer_verify(code: str) -> int:
    env = os.environ.copy()
    env["META_VERIFY_CODE_ONLY"] = "1"
    env["META_VERIFY_CODE"] = code
    result = subprocess.run(
        ["node", "scripts/trajectories/meta/developer_account_verification_accounts_center.mjs"],
        env=env,
        check=False,
    )
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lookback-seconds", type=int, default=3600)
    parser.add_argument("--run-developer-verify", action="store_true")
    args = parser.parse_args()

    db_path = Path.home() / "Library" / "Messages" / "chat.db"
    code = find_code(db_path, args.lookback_seconds)
    if not code:
        print("AUTO_OTP_NOT_FOUND")
        return 2

    print("AUTO_OTP_FOUND: redacted")
    if args.run_developer_verify:
        return run_developer_verify(code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
