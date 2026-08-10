#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"; runtime="$root/runtime"
if [ ! -f "$runtime/.ready" ]; then
  staging="$root/.runtime-staging"; rm -rf "$staging"; mkdir -p "$staging"
  tar -xzf "$root/payload/weles-worker.tar.gz" -C "$staging"; touch "$staging/.ready"; rm -rf "$runtime"; mv "$staging" "$runtime"
fi
ln -sfn "$runtime" "$HOME/weles"
exec bash "$runtime/scripts/worker/deploy/launch-mac.sh"
