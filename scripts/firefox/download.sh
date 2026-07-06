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
  echo "[download-firefox] Fetching $ASSET from $REPO@$RELEASE_TAG" >&2

  gh_token() {
    if [[ -n "${GH_TOKEN:-}" ]]; then printf '%s' "$GH_TOKEN"; return 0; fi
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then printf '%s' "$GITHUB_TOKEN"; return 0; fi
    { printf 'protocol=https\nhost=github.com\npath=%s\n\n' "$REPO" \
      | git credential fill 2>/dev/null || true; } \
      | awk -F= '/^password=/ { print $2; exit }'
  }

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
fi

if [[ -f "$TMP/${ASSET}.sha256" ]]; then
  echo "[download-firefox] Verifying SHA256..." >&2
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

tar -xzf "$TMP/$ASSET" -C "$INSTALL_DIR" --strip-components=0

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: expected binary at $BIN not found after extract" >&2
  exit 1
fi

if [[ "$uname_s" == "Darwin" ]]; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
fi
echo "$BIN"
