#!/usr/bin/env bash
# Download the prebuilt weles-patched Firefox binary for the host OS.
#
# Usage:
#   bash scripts/firefox/download.sh          # download if missing
#   bash scripts/firefox/download.sh --force  # re-download even if installed
#
# Installs to: $HOME/.local/share/weles-firefox/<version>/
# Prints the Firefox binary path on stdout when done.
#
# Note: until Phase 2 of scripts/firefox/PATCHING.md ships a prebuilt tarball,
# this script exits with a clear message so callers can fall back to Playwright
# Nightly (which after Phase 1 carries the pref + stub + scrub parity).

set -euo pipefail

RELEASE_TAG="${WELES_FIREFOX_RELEASE:-}"
REPO="wisent-ai/weles-firefox"
INSTALL_ROOT="${WELES_FIREFOX_DIR:-$HOME/.local/share/weles-firefox}"

if [[ -z "$RELEASE_TAG" ]]; then
  echo "WELES_FIREFOX_RELEASE is not set and no default tag exists yet." >&2
  echo "Phase 2 of scripts/firefox/PATCHING.md is not shipped." >&2
  echo "weles WSession.start({ browser: 'firefox' }) falls through to Playwright's" >&2
  echo "bundled Firefox with Phase-1 pref + stub + scrub parity; that is the" >&2
  echo "current supported Firefox path." >&2
  exit 2
fi

VERSION="${RELEASE_TAG#firefox-}"
INSTALL_DIR="$INSTALL_ROOT/$VERSION"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s/$uname_m" in
  Darwin/arm64)   ASSET="weles-firefox-${VERSION}-macos-arm64.tar.gz";   BIN="$INSTALL_DIR/Firefox.app/Contents/MacOS/firefox" ;;
  Darwin/x86_64)  ASSET="weles-firefox-${VERSION}-macos-x86_64.tar.gz";  BIN="$INSTALL_DIR/Firefox.app/Contents/MacOS/firefox" ;;
  Linux/x86_64)   ASSET="weles-firefox-${VERSION}-linux-x86_64.tar.gz";  BIN="$INSTALL_DIR/firefox/firefox" ;;
  *) echo "ERROR: unsupported platform $uname_s/$uname_m" >&2; exit 1 ;;
esac

if [[ $FORCE -eq 0 && -x "$BIN" ]]; then
  echo "$BIN"
  exit 0
fi

mkdir -p "$INSTALL_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$ASSET"
echo "downloading $URL ..." >&2
curl -fSL -o "$TMP/$ASSET" "$URL"
tar -xzf "$TMP/$ASSET" -C "$INSTALL_DIR" --strip-components=0

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: expected binary at $BIN not found after extract" >&2
  exit 1
fi
echo "$BIN"
