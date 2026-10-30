#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
if [ "$(basename "$script_dir")" = "bin" ]; then
  root="$(dirname "$script_dir")"
else
  root="$script_dir"
fi
payload="$root/payload/weles-worker.tar.gz"
# The Node runtime Stado runs on its darwin-arm64 hosts, the one its host
# executable allowlist declares (stado-rs deploy/host_exec/allowlist/programs.rs,
# NODE_RUNTIME); this release is built for that platform only.
node_bin=/opt/homebrew/bin/node

# Print why the launch cannot go on and stop it: `false` under `set -e` ends
# the script with the shell's own failure status, so no status is written here.
refuse() {
  printf '%s\n' "$*" >&2
  false
}

if [ ! -f "$payload" ] || [ -L "$payload" ]; then
  refuse "missing regular Weles runtime payload: $payload"
fi
if [ ! -x "$node_bin" ]; then
  refuse "required Node runtime is unavailable: $node_bin"
fi
payload_sha256="$(/usr/bin/shasum -a 256 "$payload")"
payload_sha256="${payload_sha256%% *}"
# Derived files must never change Stado's immutable installed archive.
runtime_cache="$HOME/.stado/var/weles/runtime"
runtime="$runtime_cache/$payload_sha256"
mkdir -p "$runtime_cache"

# Everything src/worker/weles-api-server.mjs loads out of the runtime root
# before it binds its port. `dist/` is the part that matters: the server
# resolves `${REPO}/dist/worker/dispatch.js` and the modules that module
# re-exports at import time, so a tree without them cannot serve, however
# complete the rest of it looks.
runtime_required=(
  package.json
  src/worker/weles-api-launcher.mjs
  src/worker/weles-api-launcher/configuration.mjs
  src/worker/weles-api-launcher/port.mjs
  src/worker/weles-api-launcher/running.mjs
  src/worker/weles-api-launcher/startup.mjs
  src/worker/weles-api-launcher/predecessors.mjs
  src/_shared/skarbiec-runtime.mjs
  src/worker/deploy/acquire/skarbiec-acquire.mjs
  src/worker/deploy/acquire/proof.mjs
  src/worker/deploy/acquire/transport.mjs
  src/worker/deploy/acquire/skarbiec-acquisition-scopes.conf
  src/worker/deploy/weles-capability-routes.json
  src/worker/deploy/weles-action-allowlist.txt
  src/worker/weles-api-server.mjs
  dist/worker/dispatch.js
  dist/worker/params/params-to-env.js
  dist/worker/params-to-env/account-and-task-admission.js
  dist/worker/params-to-env/action-name-dispatch.js
  dist/worker/params-to-env/apple-actions.js
  dist/worker/params-to-env/content-actions.js
  dist/worker/params-to-env/paid-ads-actions.js
  dist/worker/declared/engagements.js
  dist/worker/declared/observations.js
  dist/worker/params/analytics-actions.js
  dist/worker/release/deployment_version.js
  dist/worker/upload-artifacts.js
  dist/agent/browser-evidence-policy/withheld-ledger.js
  dist/agent/browser-evidence-policy/pinned-network.js
  dist/async_api.js
  dist/state/skarbiec-records.js
  dist/runtime/import.js
  dist/utils/login-accounts.js
  dist/secrets/acquire.js
  dist/secrets/acquire/catalog.js
  dist/secrets/scoped-service/contracts.js
  dist/secrets/scoped-service/managed-passwords.js
  dist/secrets/scoped-service.js
  dist/secrets/scoped-service/transport.js
  src/worker/weles-api-server/credentials/service.mjs
  src/worker/weles-api-server/credentials/authority.mjs
  src/worker/weles-api-server/credentials/store.mjs
  src/worker/weles-api-server/credentials/outcome.mjs
  node_modules/@wisent-ai/weles-client/src/credential/input.mjs
  node_modules/@wisent-ai/weles-client/src/credential/response.mjs
)

# The first required entry missing from the tree at $1, or nothing when the
# tree carries all of them. A missing entry returns the status of the printf
# that named it; a complete tree returns false's failure, as there is nothing
# to name.
missing_runtime_entry() {
  local tree="$1" entry
  for entry in "${runtime_required[@]}"; do
    if [ ! -f "$tree/$entry" ]; then
      printf '%s\n' "$entry"
      return
    fi
  done
  for entry in native/jeden/bin/jeden native/jeden/bin/jeden-sandbox-helper; do
    if [ ! -f "$tree/$entry" ] || [ ! -x "$tree/$entry" ]; then
      printf '%s (required native executable)\n' "$entry"
      return
    fi
  done
  for entry in "$tree"/browser-runtime/ffmpeg-*/ffmpeg-mac; do
    if [ -x "$entry" ]; then false; return; fi
  done
  printf 'browser-runtime recording executable\n'
  return
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
  staging="$runtime.staging.$$"
  replaced="$runtime.replaced.$$"
  rm -rf "$staging" "$replaced"
  mkdir -p "$staging"
  tar -xzf "$payload" -C "$staging"
  if incomplete="$(missing_runtime_entry "$staging")"; then
    rm -rf "$staging"
    refuse "Weles runtime payload $payload unpacked without $incomplete"
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
    throw new Error(`${process.argv[1]} names version ${JSON.stringify(value)}, which is not MAJOR.MINOR.PATCH`);
  }
  process.stdout.write(value);
' "$runtime/package.json")"

ln -sfn "$runtime" "$HOME/weles"
export WELES_WORKER_RELEASE_VERSION="$version"
export WELES_WORKER_RELEASE_SHA256="$payload_sha256"
# The Chromium release Weles launches is the one the weles-chromium delivery
# last verified and recorded as selected; find_browser reads only these two
# variables, so without them every browser run is refused.
chromium_root="$HOME/.local/share/weles-chromium"
if [ -n "${WELES_CHROMIUM_DIR+x}" ]; then chromium_root="$WELES_CHROMIUM_DIR"; fi
chromium_selection="$chromium_root/selected"
if [ -e "$chromium_selection" ]; then
  chromium_version="$(sed -n 's/^version=//p' "$chromium_selection")"
  chromium_sha256="$(sed -n 's/^sha256=//p' "$chromium_selection")"
  if [ -z "$chromium_version" ] || [ -z "$chromium_sha256" ]; then
    printf 'weles launcher: Chromium selection %s names no version or sha256; browser runs are refused until a weles-chromium delivery rewrites it\n' "$chromium_selection" >/dev/stderr
  else
    export WELES_CHROMIUM_RELEASE_VERSION="$chromium_version"
    export WELES_CHROMIUM_RELEASE_SHA256="$chromium_sha256"
  fi
else
  printf 'weles launcher: no Chromium selection at %s; browser runs are refused until a weles-chromium delivery installs one\n' "$chromium_selection" >/dev/stderr
fi
# Recording support belongs to the signed release, not an evictable host cache.
export PLAYWRIGHT_BROWSERS_PATH="$runtime/browser-runtime"
# Recordings are runtime state, not release payload. Keeping them under the
# immutable release directory made the authenticated diagnostics endpoint lose
# every run as soon as Stado advanced `current`. Where they go is the host's
# registry entry (`targets[].weles.recordings_dir`), which Stado's
# `weles-recordings` workload writes into this LaunchAgent as
# WELES_RECORDINGS_ROOT, so the writer and Stado's janitor name one place.
if [ -z "${WELES_RECORDINGS_ROOT:+stated}" ]; then
  refuse "WELES_RECORDINGS_ROOT is not set for this LaunchAgent; run Stado's weles-recordings workload for this host with the absolute recordings path"
fi
export WELES_RECORDINGS_ROOT
mkdir -p "$WELES_RECORDINGS_ROOT"
chmod u=rwx,go= "$WELES_RECORDINGS_ROOT"
printf 'release_uri=stado://releases/weles-worker/%s/darwin-arm64/release.tar.gz
archive_sha256=%s
platform=darwin-arm64
' "$version" "$payload_sha256" > "$runtime/.weles-release"

exec "$node_bin" "$runtime/src/worker/weles-api-launcher.mjs"
