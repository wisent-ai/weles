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

# Everything scripts/worker/weles-api-server.mjs loads out of the runtime root
# before it binds its port. `dist/` is the part that matters: the server
# resolves `${REPO}/dist/worker/dispatch.js` and two more compiled modules at
# import time, so a tree without them cannot serve, however complete the rest
# of it looks.
runtime_required=(
  package.json
  scripts/worker/deploy/launch-weles-api-mac.sh
  scripts/worker/weles-api-server.mjs
  dist/worker/dispatch.js
  dist/worker/deployment_version.js
  dist/utils/login-accounts.js
)

# The first required entry missing from the tree at $1, or nothing when the
# tree carries all of them.
missing_runtime_entry() {
  local tree="$1" entry
  for entry in "${runtime_required[@]}"; do
    if [ ! -f "$tree/$entry" ]; then
      printf '%s\n' "$entry"
      return 0
    fi
  done
  return 1
}

# `.ready` on its own used to be the whole test, and the unpack guard behind it
# checked two files, neither under `dist/`. A tree that lost its compiled
# modules was therefore still treated as ready and never re-derived: the API
# server died on its first import on every KeepAlive cycle, and no later
# release could repair the host because the marker kept insisting the runtime
# was fine. The marker is now only believed together with the files the server
# actually imports, so an incomplete runtime is rebuilt instead of pinned.
needs_unpack=yes
if [ -f "$runtime/.ready" ]; then
  if incomplete="$(missing_runtime_entry "$runtime")"; then
    printf 'Weles runtime %s is marked ready but has no %s; re-deriving it from the payload\n' \
      "$runtime" "$incomplete" >&2
  else
    needs_unpack=no
  fi
fi

if [ "$needs_unpack" = yes ]; then
  # A staging path of this process's own. launchd can start a second instance
  # of this launcher while the first is still unpacking, and one shared
  # staging directory let each instance delete the tree the other was
  # extracting into and then publish whatever was left of it.
  staging="$root/.runtime-staging.$$"
  replaced="$root/.runtime-replaced.$$"
  rm -rf "$staging" "$replaced"
  mkdir -p "$staging"
  tar -xzf "$payload" -C "$staging"
  if incomplete="$(missing_runtime_entry "$staging")"; then
    rm -rf "$staging"
    printf 'Weles runtime payload %s unpacked without %s\n' "$payload" "$incomplete" >&2
    exit 1
  fi
  # Marked ready only once the tree has been shown complete, and published by
  # rename, so `.ready` never appears on a half-built runtime and no reader
  # sees one under its final name.
  touch "$staging/.ready"
  if [ -e "$runtime" ]; then
    mv "$runtime" "$replaced"
  fi
  if [ -e "$runtime" ]; then
    # A concurrent launcher published a complete runtime while this one was
    # staging. Its tree came out of the same payload, so keep it.
    rm -rf "$staging"
  else
    mv "$staging" "$runtime"
  fi
  rm -rf "$replaced"
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
# Recordings are runtime state, not release payload. Keeping them under the
# immutable release directory made the authenticated diagnostics endpoint lose
# every run as soon as Stado advanced `current`.
export WELES_RECORDINGS_ROOT="${WELES_RECORDINGS_ROOT:-$HOME/.stado/var/weles/recordings}"
mkdir -p "$WELES_RECORDINGS_ROOT"
chmod 700 "$WELES_RECORDINGS_ROOT"
printf 'release_uri=stado://releases/weles-worker/%s/darwin-arm64/release.tar.gz
archive_sha256=%s
platform=darwin-arm64
' "$version" "$payload_sha256" > "$runtime/.weles-release"

exec bash "$runtime/scripts/worker/deploy/launch-weles-api-mac.sh"
