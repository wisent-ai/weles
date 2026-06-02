#!/usr/bin/env bash
# Build the patched weles Chromium and immediately publish it. One command, so
# a rebuild can never leave the published GitHub release behind the source.
#
# This is the ~4h step. It runs autoninja in the chromium-build source tree
# (where the weles C++ fingerprint patch lives) and, on success, chains to
# release.sh which packages, uploads under a fresh -weles.N tag, bumps the
# download.sh pin, and commits+pushes so every host auto-deploys it.
#
# Usage:
#   bash scripts/chromium/build.sh             # build, then publish
#   bash scripts/chromium/build.sh --dry-run   # build, then dry-run release
#
# Env overrides:
#   CHROMIUM_BUILD_SRC    default ../chromium-build/src
#   CHROMIUM_NINJA_TARGET default chrome
#   DEPOT_TOOLS           default ../chromium-build/depot_tools

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHROMIUM_BUILD_SRC:-$REPO_ROOT/../chromium-build/src}"
TARGET="${CHROMIUM_NINJA_TARGET:-chrome}"
DEPOT="${DEPOT_TOOLS:-$REPO_ROOT/../chromium-build/depot_tools}"

if [[ ! -d "$SRC/out/Weles" ]]; then
  echo "ERROR: $SRC/out/Weles missing — expected a configured chromium-build tree" >&2
  exit 1
fi
if [[ -d "$DEPOT" ]]; then export PATH="$DEPOT:$PATH"; fi
if ! command -v autoninja >/dev/null 2>&1; then
  echo "ERROR: autoninja not on PATH (set DEPOT_TOOLS to your depot_tools dir)" >&2
  exit 1
fi

echo "[build] autoninja -C out/Weles $TARGET  (this is the long step) …" >&2
( cd "$SRC" && autoninja -C out/Weles "$TARGET" )

echo "[build] build ok → publishing" >&2
exec bash "$REPO_ROOT/scripts/chromium/release.sh" "$@"
