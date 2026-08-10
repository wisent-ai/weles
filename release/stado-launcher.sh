#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"; runtime="$root/runtime"
if [ ! -f "$runtime/.ready" ]; then
  staging="$root/.runtime-staging"; rm -rf "$staging"; mkdir -p "$staging"
  tar -xzf "$root/payload/weles-worker.tar.gz" -C "$staging"; touch "$staging/.ready"; rm -rf "$runtime"; mv "$staging" "$runtime"
fi
ln -sfn "$runtime" "$HOME/weles"
: "${STADO_RELEASE_VERSION:?STADO_RELEASE_VERSION is required}"
: "${STADO_RELEASE_SHA256:?STADO_RELEASE_SHA256 is required}"
export WELES_WORKER_RELEASE_VERSION="$STADO_RELEASE_VERSION"
export WELES_WORKER_RELEASE_SHA256="$STADO_RELEASE_SHA256"
printf 'release_uri=stado://releases/weles-worker/%s/darwin-arm64/weles-worker.tar.gz
archive_sha256=%s
platform=darwin-arm64
' "$STADO_RELEASE_VERSION" "$STADO_RELEASE_SHA256" > "$runtime/.weles-release"
exec bash "$runtime/scripts/worker/deploy/launch-mac.sh"
