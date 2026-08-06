#!/usr/bin/env bash
# Package a locally built Chromium for operator publication to one exact Stado
# release coordinate. This script never publishes, discovers a version, mutates
# deployment configuration, or invokes a source/provider CLI.

set -euo pipefail

fail() {
  printf '%s\n' "ERROR: $*" > /dev/stderr
  false
}

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_OUT="${CHROMIUM_BUILD_OUT:-$REPO_ROOT/../chromium-build/src/out/Weles}"
[[ -n "${WELES_CHROMIUM_RELEASE_VERSION:-}" ]] \
  || fail "WELES_CHROMIUM_RELEASE_VERSION must be explicitly configured"
[[ -n "${WELES_CHROMIUM_RELEASE_OUTPUT_DIR:-}" ]] \
  || fail "WELES_CHROMIUM_RELEASE_OUTPUT_DIR must be explicitly configured"
case "$WELES_CHROMIUM_RELEASE_VERSION" in
  *[![:alnum:]._-]*|"") fail "invalid WELES_CHROMIUM_RELEASE_VERSION" ;;
esac

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s/$uname_m" in
  Darwin/arm64)  PLATFORM="darwin-arm64"; PACKAGE_ROOT="Chromium.app"; BIN_REL="Chromium.app/Contents/MacOS/Chromium" ;;
  Darwin/x86_64) PLATFORM="darwin-amd64"; PACKAGE_ROOT="Chromium.app"; BIN_REL="Chromium.app/Contents/MacOS/Chromium" ;;
  Linux/x86_64)  PLATFORM="linux-amd64";  PACKAGE_ROOT="chromium";     BIN_REL="chromium/chrome" ;;
  *) fail "unsupported platform $uname_s/$uname_m" ;;
esac

[[ -x "$BUILD_OUT/$BIN_REL" ]] || fail "built binary not found at $BUILD_OUT/$BIN_REL"
command -v openssl > /dev/null || fail "openssl is required for SHA-256 generation"

VERSION="$WELES_CHROMIUM_RELEASE_VERSION"
OUTPUT_DIR="${WELES_CHROMIUM_RELEASE_OUTPUT_DIR%/}/$VERSION/$PLATFORM"
ASSET="weles-chromium.tar.gz"
ARCHIVE="$OUTPUT_DIR/$ASSET"
RELEASE_URI="stado://releases/weles-chromium/$VERSION/$PLATFORM/$ASSET"
mkdir -p "$OUTPUT_DIR"

tar -czf "$ARCHIVE" -C "$BUILD_OUT" "$PACKAGE_ROOT"
DIGEST_LINE="$(openssl dgst -sha256 -r "$ARCHIVE")"
DIGEST="${DIGEST_LINE%% *}"
printf '%s\n' "$DIGEST" > "$ARCHIVE.sha256"

printf '%s\n' \
  "archive=$ARCHIVE" \
  "sha256=$DIGEST" \
  "publish_uri=$RELEASE_URI"
