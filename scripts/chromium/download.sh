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
REPO="wisent-ai/weles-chromium"
INSTALL_ROOT="${WELES_CHROMIUM_DIR:-$HOME/.local/share/weles-chromium}"
INSTALL_DIR="$INSTALL_ROOT/$VERSION"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s/$uname_m" in
  Darwin/arm64)   ASSET="weles-chromium-${VERSION}-macos-arm64.tar.gz";  BIN="$INSTALL_DIR/Chromium.app/Contents/MacOS/Chromium" ;;
  Darwin/x86_64)  ASSET="weles-chromium-${VERSION}-macos-x86_64.tar.gz"; BIN="$INSTALL_DIR/Chromium.app/Contents/MacOS/Chromium" ;;
  Linux/x86_64)   ASSET="weles-chromium-${VERSION}-linux-x86_64.tar.gz"; BIN="$INSTALL_DIR/chromium/chrome" ;;
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

# wisent-ai/weles is PRIVATE, so the plain releases/download URL 404s without
# auth. Use gh when present, otherwise require a token from the environment or
# git's credential helper. Do not read credentials from git remote URLs; those
# URLs are routinely logged by humans and tools.
gh_token() {
  if [[ -n "${GH_TOKEN:-}" ]]; then printf '%s' "$GH_TOKEN"; return 0; fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then printf '%s' "$GITHUB_TOKEN"; return 0; fi
  { printf 'protocol=https\nhost=github.com\npath=%s\n\n' "$REPO" \
    | git credential fill 2>/dev/null || true; } \
    | awk -F= '/^password=/ { print $2; exit }'
}

# Fetch one release asset to $2. Prefers gh; otherwise the GitHub assets API
# with a bearer token (the only way curl can read a private release asset).
fetch_asset() {
  local name="$1" dest="$2"
  if command -v gh >/dev/null 2>&1; then
    gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$name" --dir "$(dirname "$dest")" >&2
    return $?
  fi
  local tok; tok="$(gh_token)"
  if [[ -z "$tok" ]]; then
    echo "ERROR: no gh CLI and no token (set GH_TOKEN/GITHUB_TOKEN or git credential helper) to read private release $REPO@$RELEASE_TAG" >&2
    return 1
  fi
  local aid
  aid="$(curl -fsSL -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$REPO/releases/tags/$RELEASE_TAG" \
        | python3 -c "import sys,json; print(next((str(a['id']) for a in json.load(sys.stdin).get('assets',[]) if a['name']==sys.argv[1]), ''))" "$name")"
  if [[ -z "$aid" ]]; then echo "ERROR: asset $name absent from release $RELEASE_TAG" >&2; return 1; fi
  curl -fL -H "Authorization: Bearer $tok" -H "Accept: application/octet-stream" \
    "https://api.github.com/repos/$REPO/releases/assets/$aid" -o "$dest" >&2
}

fetch_asset "$ASSET" "$TMP/$ASSET"
fetch_asset "${ASSET}.sha256" "$TMP/${ASSET}.sha256" || true

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
