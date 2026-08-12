#!/usr/bin/env python3
"""Summarize the newest Cloudflare task DOM without printing credential material."""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path

root = Path.home() / ".stado" / "build-work" / "weles-api-managed" / "recordings"
results = sorted(root.rglob("generic_task_result.json"), key=lambda path: path.stat().st_mtime)
if not results:
    raise SystemExit("Cloudflare task result is unavailable")
run_root = results[-1].parent
paths = sorted(
    [*run_root.glob("session_dom_*.html"), *run_root.glob("after_*_dom.html")],
    key=lambda path: path.stat().st_mtime,
)
if not paths:
    raise SystemExit("Cloudflare DOM artifact is unavailable")
path = paths[-1]


class Inspector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.controls = []
        self.text = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in {"input", "button", "form", "iframe", "a"}:
            allowed = {"type", "name", "id", "aria-label", "role", "disabled"}
            clean = {key: value for key, value in attributes.items() if key in allowed}
            self.controls.append({"tag": tag, "attributes": clean})

    def handle_data(self, data):
        value = " ".join(data.split())
        if value:
            self.text.append(value)


source = path.read_text(errors="replace")
inspector = Inspector()
inspector.feed(source)
visible_text = " ".join(inspector.text)
phrases = [
    "Try another way",
    "Enter your password",
    "Use your password",
    "Use your passkey",
    "Continue",
    "Next",
    "Confirm",
    "Verify",
]
signals = [phrase for phrase in phrases if re.search(re.escape(phrase), visible_text, flags=re.IGNORECASE)]
match = re.search(r".{0,100}Try another way.{0,300}", source, flags=re.IGNORECASE | re.DOTALL)
markup = match.group(0) if match else ""
markup = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[email]", markup, flags=re.IGNORECASE)
markup = re.sub(r"""(\bvalue=)(["']).*?\2""", r'\1"[redacted]"', markup, flags=re.DOTALL)
markup = " ".join(markup.split())
print(json.dumps({
    "path": path.name,
    "text_signals": signals,
    "try_another_markup": markup[:500],
}, indent=2))
