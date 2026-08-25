#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$root/runtime"
[ -f "$runtime/.ready" ] || { printf '%s\n' "Weles runtime is not staged at $runtime" >&2; exit 1; }
ln -sfn "$runtime" "$HOME/weles"
exec bash "$runtime/scripts/worker/deploy/launch-crawler-mac.sh"
