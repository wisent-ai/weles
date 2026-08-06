#!/usr/bin/env bash
# Build the patched Weles Chromium and package it locally for operator
# publication. The packaging step requires an explicit immutable release
# version and output directory; it does not upload or change deployment state.
#
# Usage:
#   WELES_CHROMIUM_RELEASE_VERSION=... \
#   WELES_CHROMIUM_RELEASE_OUTPUT_DIR=... \
#   bash scripts/chromium/build.sh
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

echo "[build] build ok; packaging exact Stado release artifact" > /dev/stderr
exec bash "$REPO_ROOT/scripts/chromium/release.sh" "$@"
