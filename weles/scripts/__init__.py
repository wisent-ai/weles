"""Load and assemble JS spoofing scripts."""

import json
from pathlib import Path
from typing import Any, Dict

_SCRIPTS_DIR = Path(__file__).parent
_SCRIPT_ORDER = [
    "automation.js",
    "navigator.js",
    "webgl.js",
]


def build_init_script(config: Dict[str, Any]) -> str:
    """Assemble all JS spoofing scripts into a single init script."""
    parts = [
        f"const __weles = {json.dumps(config)};",
    ]
    for name in _SCRIPT_ORDER:
        path = _SCRIPTS_DIR / name
        if path.exists():
            parts.append(path.read_text())
    parts.append("delete window.__weles;")
    return f"(function(){{\n{chr(10).join(parts)}\n}})();"
