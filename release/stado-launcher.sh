#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
if [ "$(basename "$script_dir")" = "bin" ]; then
  root="$(dirname "$script_dir")"
else
  root="$script_dir"
fi
runtime="$root/runtime"
payload="$root/payload/weles-worker.tar.gz"
node_bin="${NODE_BIN:-/opt/homebrew/bin/node}"

if [ ! -f "$payload" ] || [ -L "$payload" ]; then
  printf 'missing regular Weles runtime payload: %s\n' "$payload" >&2
  exit 1
fi
if [ ! -x "$node_bin" ]; then
  printf 'required Node runtime is unavailable: %s\n' "$node_bin" >&2
  exit 1
fi

if [ ! -f "$runtime/.ready" ]; then
  staging="$root/.runtime-staging"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$payload" -C "$staging"
  if [ ! -f "$staging/package.json" ] \
    || [ ! -f "$staging/scripts/worker/deploy/launch-weles-api-mac.sh" ]; then
    rm -rf "$staging"
    printf '%s\n' "Weles runtime payload is missing its package or API launcher" >&2
    exit 1
  fi
  touch "$staging/.ready"
  rm -rf "$runtime"
  mv "$staging" "$runtime"
fi

version="$("$node_bin" -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    process.exit(1);
  }
  process.stdout.write(value);
' "$runtime/package.json")"
payload_sha256="$(/usr/bin/shasum -a 256 "$payload")"
payload_sha256="${payload_sha256%% *}"

ln -sfn "$runtime" "$HOME/weles"
export WELES_WORKER_RELEASE_VERSION="$version"
export WELES_WORKER_RELEASE_SHA256="$payload_sha256"
printf 'release_uri=stado://releases/weles-worker/%s/darwin-arm64/release.tar.gz
archive_sha256=%s
platform=darwin-arm64
' "$version" "$payload_sha256" > "$runtime/.weles-release"

exec bash "$runtime/scripts/worker/deploy/launch-weles-api-mac.sh"
