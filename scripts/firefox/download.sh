#!/usr/bin/env bash
# Install one explicitly selected Weles Firefox release from Stado.
#
# Required nonsecret deployment coordinates:
#   STADO_RELEASE_LOCAL_ROOT or STADO_RELEASE_API_URL
#   WELES_FIREFOX_RELEASE_VERSION
#   WELES_FIREFOX_RELEASE_SHA256
#
# The operator must publish:
#   stado://releases/weles-firefox/<version>/<platform>/weles-firefox.tar.gz

set -euo pipefail

fail() {
  printf '%s\n' "ERROR: $*" > /dev/stderr
  false
}

require() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "$name must be explicitly configured"
}

if [[ -z "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
  require STADO_RELEASE_API_URL
fi
require WELES_FIREFOX_RELEASE_VERSION
require WELES_FIREFOX_RELEASE_SHA256

if [[ -n "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
  case "$STADO_RELEASE_LOCAL_ROOT" in
    /*) ;;
    *) fail "STADO_RELEASE_LOCAL_ROOT must be an absolute path" ;;
  esac
elif [[ "${STADO_RELEASE_API_URL:-}" != https://* ]]; then
  fail "STADO_RELEASE_API_URL must use HTTPS"
fi
case "$WELES_FIREFOX_RELEASE_VERSION" in
  *[![:alnum:]._-]*|"") fail "invalid WELES_FIREFOX_RELEASE_VERSION" ;;
esac
HEX_PAIR_PATTERN='[[:xdigit:]][[:xdigit:]]'
HEX_QUAD_PATTERN="$HEX_PAIR_PATTERN$HEX_PAIR_PATTERN"
HEX_OCTET_PATTERN="$HEX_QUAD_PATTERN$HEX_QUAD_PATTERN"
HEX_BLOCK_PATTERN="$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN"
HEX_SHA256_PATTERN="$HEX_BLOCK_PATTERN$HEX_BLOCK_PATTERN"
if [[ ! "$WELES_FIREFOX_RELEASE_SHA256" =~ ^${HEX_SHA256_PATTERN}$ ]]; then
  fail "WELES_FIREFOX_RELEASE_SHA256 must be one complete hexadecimal SHA-256 digest"
fi

VERSION="$WELES_FIREFOX_RELEASE_VERSION"
EXPECTED_SHA256="$(printf '%s' "$WELES_FIREFOX_RELEASE_SHA256" | tr '[:upper:]' '[:lower:]')"
INSTALL_ROOT="${WELES_FIREFOX_DIR:-$HOME/.local/share/weles-firefox}"
INSTALL_DIR="$INSTALL_ROOT/$VERSION"
ASSET="weles-firefox.tar.gz"

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s/$uname_m" in
  Darwin/arm64)  PLATFORM="darwin-arm64"; BIN_REL="Firefox.app/Contents/MacOS/firefox" ;;
  Darwin/x86_64) PLATFORM="darwin-amd64"; BIN_REL="Firefox.app/Contents/MacOS/firefox" ;;
  Linux/x86_64)  PLATFORM="linux-amd64";  BIN_REL="firefox/firefox" ;;
  *) fail "unsupported platform $uname_s/$uname_m" ;;
esac

RELEASE_URI="stado://releases/weles-firefox/$VERSION/$PLATFORM/$ASSET"
BIN="$INSTALL_DIR/$BIN_REL"
RECEIPT="$INSTALL_DIR/.weles-release"
EXPECTED_RECEIPT="release_uri=$RELEASE_URI
archive_sha256=$EXPECTED_SHA256
platform=$PLATFORM"

FORCE=false
if [[ "${*:-}" == "--force" ]]; then
  FORCE=true
elif [[ -n "${*:-}" ]]; then
  fail "unsupported arguments: $*"
fi

if ! $FORCE && [[ -x "$BIN" && -f "$RECEIPT" ]] \
  && [[ "$(cat "$RECEIPT")" == "$EXPECTED_RECEIPT" ]]; then
  echo "$BIN"
  exit
fi

mkdir -p "$INSTALL_ROOT"
TMP="$(mktemp -d "$INSTALL_ROOT/.firefox-download.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

if [[ -n "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
  SOURCE_ARCHIVE="$STADO_RELEASE_LOCAL_ROOT/weles-firefox/$VERSION/$PLATFORM/$ASSET"
  [[ -f "$SOURCE_ARCHIVE" && ! -L "$SOURCE_ARCHIVE" ]] \
    || fail "missing regular staged release archive: $SOURCE_ARCHIVE"
  cp "$SOURCE_ARCHIVE" "$TMP/$ASSET"
else
  echo "[download-firefox] Fetching immutable $RELEASE_URI" > /dev/stderr
  curl --fail --silent --show-error --location --get \
    --data-urlencode "uri=$RELEASE_URI" \
    "${STADO_RELEASE_API_URL%/}/api/release/object" \
    --output "$TMP/$ASSET"
fi

command -v openssl > /dev/null || fail "openssl is required for SHA-256 verification"
ACTUAL_SHA256_LINE="$(openssl dgst -sha256 -r "$TMP/$ASSET")"
ACTUAL_SHA256="${ACTUAL_SHA256_LINE%% *}"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  fail "SHA-256 mismatch for $RELEASE_URI: expected=$EXPECTED_SHA256 actual=$ACTUAL_SHA256"
fi

STAGED="$TMP/install"
mkdir -p "$STAGED"
echo "[download-firefox] Checksum verified; extracting to $INSTALL_DIR" > /dev/stderr
tar -xzf "$TMP/$ASSET" -C "$STAGED"
[[ -x "$STAGED/$BIN_REL" ]] || fail "verified archive did not contain executable $BIN_REL"
printf '%s\n' "$EXPECTED_RECEIPT" > "$STAGED/.weles-release"

BACKUP="$INSTALL_ROOT/.${VERSION}.previous.$$"
if [[ -e "$INSTALL_DIR" ]]; then
  mv "$INSTALL_DIR" "$BACKUP"
fi
if ! mv "$STAGED" "$INSTALL_DIR"; then
  if [[ -e "$BACKUP" ]]; then mv "$BACKUP" "$INSTALL_DIR"; fi
  false
fi
rm -rf "$BACKUP"

if [[ "$uname_s" == "Darwin" ]]; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" || true
fi

echo "[download-firefox] Installed verified $RELEASE_URI at $BIN" > /dev/stderr
echo "$BIN"
