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
# Local artifacts are preferred before network download:
#   WELES_FIREFOX_TARBALL=/path/to/weles-firefox-...tar.gz
#   WELES_FIREFOX_ARTIFACT_DIR=/path/to/artifacts

set -euo pipefail

RELEASE_TAG="${WELES_FIREFOX_RELEASE:-firefox-142.0a1-weles.5}"
REPO="wisent-ai/weles-firefox"
INSTALL_ROOT="${WELES_FIREFOX_DIR:-$HOME/.local/share/weles-firefox}"
LOCAL_ARTIFACT_DIR="${WELES_FIREFOX_ARTIFACT_DIR:-$HOME/Documents/CodingProjects/Wisent/firefox-build/artifacts}"
LOCAL_TARBALL="${WELES_FIREFOX_TARBALL:-}"

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

if [[ -n "$LOCAL_TARBALL" ]]; then
  if [[ ! -f "$LOCAL_TARBALL" ]]; then
    echo "ERROR: WELES_FIREFOX_TARBALL does not exist: $LOCAL_TARBALL" >&2
    exit 1
  fi
  echo "using local Firefox artifact $LOCAL_TARBALL ..." >&2
  cp "$LOCAL_TARBALL" "$TMP/$ASSET"
elif [[ -f "$LOCAL_ARTIFACT_DIR/$ASSET" ]]; then
  echo "using local Firefox artifact $LOCAL_ARTIFACT_DIR/$ASSET ..." >&2
  cp "$LOCAL_ARTIFACT_DIR/$ASSET" "$TMP/$ASSET"
else
  echo "downloading $ASSET from $REPO@$RELEASE_TAG ..." >&2
  # Prefer `gh release download` — handles auth for private repos + public.
  # Falls back to plain curl for environments without gh installed.
  if command -v gh >/dev/null 2>&1; then
    ( cd "$TMP" && gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$ASSET" )
  else
    URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$ASSET"
    curl -fSL -o "$TMP/$ASSET" "$URL"
  fi
fi
tar -xzf "$TMP/$ASSET" -C "$INSTALL_DIR" --strip-components=0

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: expected binary at $BIN not found after extract" >&2
  exit 1
fi
echo "$BIN"
