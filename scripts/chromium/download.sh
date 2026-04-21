#!/usr/bin/env bash
# Download the prebuilt weles custom Chromium binary for the host OS.
#
# Usage:
#   bash scripts/chromium/download.sh          # download if missing
#   bash scripts/chromium/download.sh --force  # re-download even if installed
#
# Installs to: $HOME/.local/share/weles-chromium/<version>/
# Prints the Chromium binary path on stdout when done.
# wsession.ts findCustomChromium() picks it up from that path automatically.

set -euo pipefail

RELEASE_TAG="${WELES_CHROMIUM_RELEASE:-chromium-147.0.7727.108-weles.1}"
VERSION="${RELEASE_TAG#chromium-}"
REPO="wisent-ai/weles"
INSTALL_ROOT="${WELES_CHROMIUM_DIR:-$HOME/.local/share/weles-chromium}"
INSTALL_DIR="$INSTALL_ROOT/$VERSION"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s/$uname_m" in
  Darwin/arm64)   ASSET="weles-chromium-147-macos-arm64.tar.gz";   BIN="$INSTALL_DIR/Chromium.app/Contents/MacOS/Chromium" ;;
  Darwin/x86_64)  ASSET="weles-chromium-147-macos-x86_64.tar.gz";  BIN="$INSTALL_DIR/Chromium.app/Contents/MacOS/Chromium" ;;
  Linux/x86_64)   ASSET="weles-chromium-147-linux-x86_64.tar.gz";  BIN="$INSTALL_DIR/chromium/chrome" ;;
  *) echo "ERROR: unsupported platform $uname_s/$uname_m" >&2; exit 1 ;;
esac

if [[ $FORCE -eq 0 && -x "$BIN" ]]; then
  echo "$BIN"
  exit 0
fi

mkdir -p "$INSTALL_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[download-chromium] Fetching $ASSET from $REPO@$RELEASE_TAG" >&2

if command -v gh >/dev/null 2>&1; then
  # gh release download uses -D (dir) + -p (pattern); there is no --output.
  gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$ASSET" --dir "$TMP" >&2
  gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "${ASSET}.sha256" --dir "$TMP" >&2 || true
else
  URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$ASSET"
  curl -fL --progress-bar "$URL" -o "$TMP/$ASSET" >&2
  curl -fL "$URL.sha256" -o "$TMP/${ASSET}.sha256" 2>/dev/null || true
fi

if [[ -f "$TMP/${ASSET}.sha256" ]]; then
  echo "[download-chromium] Verifying SHA256..." >&2
  expected=$(awk '{print $1}' < "$TMP/${ASSET}.sha256")
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
  else
    actual=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
  fi
  if [[ "$expected" != "$actual" ]]; then
    echo "ERROR: sha256 mismatch: expected=$expected actual=$actual" >&2
    exit 1
  fi
fi

echo "[download-chromium] Extracting to $INSTALL_DIR" >&2
tar -xzf "$TMP/$ASSET" -C "$INSTALL_DIR"

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: expected binary not found after extract: $BIN" >&2
  exit 1
fi

# Clear macOS Gatekeeper quarantine so the binary launches without a prompt
if [[ "$uname_s" == "Darwin" ]]; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
fi

echo "[download-chromium] Installed: $BIN" >&2
echo "$BIN"
