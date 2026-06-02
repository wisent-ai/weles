#!/usr/bin/env bash
# Publish the locally-built weles Chromium as a fresh GitHub release and make
# every host pick it up — fully automated so the published binary can never lag
# the compiled source.
#
# What it does:
#   1. read the version straight from the built binary (source of truth)
#   2. auto-increment the -weles.N tag from existing releases for that version
#   3. tar the Chromium.app + sha256
#   4. gh release create <new-tag> with both assets
#   5. bump the pinned default tag in download.sh
#   6. commit + push that bump → each host's 60s auto-deploy installs it
#
# Usage:
#   bash scripts/chromium/release.sh            # build must already exist
#   bash scripts/chromium/release.sh --dry-run  # show the tag + size, no upload
#
# Env overrides: CHROMIUM_BUILD_OUT (default ../chromium-build/src/out/Weles).

set -euo pipefail

REPO="wisent-ai/weles"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_OUT="${CHROMIUM_BUILD_OUT:-$REPO_ROOT/../chromium-build/src/out/Weles}"
DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; fi

uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s/$uname_m" in
  Darwin/arm64)   ASSET="weles-chromium-147-macos-arm64.tar.gz";  APP="Chromium.app"; BIN="$BUILD_OUT/Chromium.app/Contents/MacOS/Chromium" ;;
  Darwin/x86_64)  ASSET="weles-chromium-147-macos-x86_64.tar.gz"; APP="Chromium.app"; BIN="$BUILD_OUT/Chromium.app/Contents/MacOS/Chromium" ;;
  Linux/x86_64)   ASSET="weles-chromium-147-linux-x86_64.tar.gz"; APP="chromium";     BIN="$BUILD_OUT/chromium/chrome" ;;
  *) echo "ERROR: unsupported platform $uname_s/$uname_m" >&2; exit 1 ;;
esac

if [[ ! -x "$BIN" ]]; then echo "ERROR: built binary not found at $BIN — build first" >&2; exit 1; fi
if ! command -v gh >/dev/null 2>&1; then echo "ERROR: gh CLI required to create releases" >&2; exit 1; fi

# Source of truth: the version the built binary actually reports.
FULLVER="$("$BIN" --version | awk '{print $NF}')"
if [[ -z "$FULLVER" ]]; then echo "ERROR: could not read version from $BIN" >&2; exit 1; fi

# Highest existing -weles.N for this version, then +1 (1 when none yet).
PREFIX="chromium-$FULLVER-weles."
PREFIX_RE="$(printf '%s' "$PREFIX" | sed 's/\./\\./g')"
MAXN="$(gh release list --repo "$REPO" --json tagName -q '.[].tagName' 2>/dev/null \
  | sed -n "s#^${PREFIX_RE}\([0-9][0-9]*\)\$#\1#p" | sort -n | tail -1)"
NEXTN=$(( ${MAXN:-0} + 1 ))
TAG="${PREFIX}${NEXTN}"
echo "[release] built $FULLVER → new tag $TAG" >&2

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "[release] packaging $APP …" >&2
tar -czf "$TMP/$ASSET" -C "$BUILD_OUT" "$APP"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$TMP/$ASSET" | awk '{print $1}' > "$TMP/$ASSET.sha256"
else
  sha256sum "$TMP/$ASSET" | awk '{print $1}' > "$TMP/$ASSET.sha256"
fi

if [[ $DRY -eq 1 ]]; then
  echo "[release] DRY-RUN: would create $TAG — $ASSET ($(du -h "$TMP/$ASSET" | cut -f1)), sha $(cat "$TMP/$ASSET.sha256")" >&2
  exit 0
fi

echo "[release] uploading release $TAG …" >&2
gh release create "$TAG" "$TMP/$ASSET" "$TMP/$ASSET.sha256" \
  --repo "$REPO" --title "$TAG" \
  --notes "Automated weles Chromium $FULLVER (weles.$NEXTN). Built+published by scripts/chromium/release.sh."

# Bump the pinned default so download.sh / auto-deploy fetch the new tag.
DL="$REPO_ROOT/scripts/chromium/download.sh"
sed -i.bak "s#WELES_CHROMIUM_RELEASE:-chromium-[0-9.]*-weles\.[0-9][0-9]*#WELES_CHROMIUM_RELEASE:-$TAG#" "$DL"
rm -f "$DL.bak"
echo "[release] pinned download.sh → $TAG" >&2

git -C "$REPO_ROOT" add scripts/chromium/download.sh
git -C "$REPO_ROOT" commit -m "chromium: release $TAG"
git -C "$REPO_ROOT" push origin HEAD
echo "[release] done — hosts will auto-deploy $TAG within ~60s" >&2
