#!/bin/bash
# Install and activate one explicitly selected immutable Weles worker release.
# This script never discovers source branches, tags, channels, or provider
# releases. The deployment-owned env file selects every release coordinate.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
STATE_DIR="${WELES_STATE_DIR:-$HOME/.local/state/weles}"
LOG="$STATE_DIR/auto-deploy.log"
mkdir -p "$STATE_DIR"

log() {
  echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"
}

fail() {
  log "ERROR: $*"
  printf '%s\n' "ERROR: $*" > /dev/stderr
  false
}

if [[ ! -r "$WELES_WORKER_ENV_FILE" || -L "$WELES_WORKER_ENV_FILE" ]]; then
  fail "missing owner-controlled regular deployment env file: $WELES_WORKER_ENV_FILE"
fi
if ! bash -n "$WELES_WORKER_ENV_FILE"; then
  fail "deployment env file has invalid shell syntax: $WELES_WORKER_ENV_FILE"
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a

# Operator kill switch. A host stops taking new releases by setting this in the
# deployment env file, without editing or unloading its launchd job.
if [[ "${WELES_AUTO_DEPLOY_ENABLED:-true}" != "true" ]]; then
  log "disabled: WELES_AUTO_DEPLOY_ENABLED=${WELES_AUTO_DEPLOY_ENABLED:-true}"
  exit 0
fi

# Legacy Semantic Scholar follow-up versions copied API keys into the GUI
# launchd environment. Remove both aliases before any worker bootstrap so
# third-party credentials cannot be inherited by unrelated long-lived jobs.
launchctl unsetenv SEMANTIC_SCHOLAR_API_KEY 2> /dev/null || true
launchctl unsetenv S2_API_KEY 2> /dev/null || true
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY

# Keep the encrypted Skarbiec sync mirror ready on every deploy tick. Every
# value comes from the owner-controlled deployment env; Git authentication
# stays in the owner-only credential file and never enters the remote URL.
if [[ -n "${SKARBIEC_SYNC_DIR:-}" && -n "${SKARBIEC_SYNC_REMOTE:-}" ]]; then
  if [[ ! -d "$SKARBIEC_SYNC_DIR/.git" ]]; then
    if [[ -e "$SKARBIEC_SYNC_DIR" ]]; then
      fail "skarbiec-sync: refusing to replace non-repository path $SKARBIEC_SYNC_DIR"
    fi
    GIT_TERMINAL_PROMPT=0 git clone --quiet "$SKARBIEC_SYNC_REMOTE" "$SKARBIEC_SYNC_DIR"
    log "skarbiec-sync: cloned encrypted vault mirror"
  else
    git -C "$SKARBIEC_SYNC_DIR" remote set-url origin "$SKARBIEC_SYNC_REMOTE"
  fi
  if [[ -f "$HOME/.git-credentials-weles" ]]; then
    git -C "$SKARBIEC_SYNC_DIR" config --local --replace-all credential.helper ""
    git -C "$SKARBIEC_SYNC_DIR" config --local --add credential.helper "store --file $HOME/.git-credentials-weles"
  fi
  GIT_TERMINAL_PROMPT=0 git -C "$SKARBIEC_SYNC_DIR" fetch --quiet origin main
  log "skarbiec-sync: repository and non-interactive Git authentication ready"
fi

require() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "$name must be explicitly configured"
}

if [[ -z "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
  require STADO_RELEASE_API_URL
fi
require WELES_WORKER_RELEASE_VERSION
require WELES_WORKER_RELEASE_SHA256
require WELES_CHROMIUM_RELEASE_VERSION
require WELES_CHROMIUM_RELEASE_SHA256
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
case "$WELES_WORKER_RELEASE_VERSION" in
  *[![:alnum:]._-]*|"") fail "invalid WELES_WORKER_RELEASE_VERSION" ;;
esac
HEX_PAIR_PATTERN='[[:xdigit:]][[:xdigit:]]'
HEX_QUAD_PATTERN="$HEX_PAIR_PATTERN$HEX_PAIR_PATTERN"
HEX_OCTET_PATTERN="$HEX_QUAD_PATTERN$HEX_QUAD_PATTERN"
HEX_BLOCK_PATTERN="$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN"
HEX_SHA256_PATTERN="$HEX_BLOCK_PATTERN$HEX_BLOCK_PATTERN"
if [[ ! "$WELES_WORKER_RELEASE_SHA256" =~ ^${HEX_SHA256_PATTERN}$ ]]; then
  fail "WELES_WORKER_RELEASE_SHA256 must be one complete hexadecimal SHA-256 digest"
fi

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s/$uname_m" in
  Darwin/arm64)  PLATFORM="darwin-arm64" ;;
  Darwin/x86_64) PLATFORM="darwin-amd64" ;;
  Linux/x86_64)  PLATFORM="linux-amd64" ;;
  *) fail "unsupported platform $uname_s/$uname_m" ;;
esac

VERSION="$WELES_WORKER_RELEASE_VERSION"
EXPECTED_SHA256="$(printf '%s' "$WELES_WORKER_RELEASE_SHA256" | tr '[:upper:]' '[:lower:]')"
ASSET="weles-worker.tar.gz"
RELEASE_URI="stado://releases/weles-worker/$VERSION/$PLATFORM/$ASSET"
RELEASE_ROOT="${WELES_WORKER_RELEASE_ROOT:-$HOME/.local/share/weles-worker}"
INSTALL_DIR="$RELEASE_ROOT/$VERSION/$PLATFORM"
CURRENT_LINK="${WELES_CURRENT_LINK:-$HOME/weles}"
RECEIPT="$INSTALL_DIR/.weles-release"
EXPECTED_RECEIPT="release_uri=$RELEASE_URI
archive_sha256=$EXPECTED_SHA256
platform=$PLATFORM"

mkdir -p "$RELEASE_ROOT"
if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  fail "$CURRENT_LINK must be an operator-created symlink, not a mutable checkout or directory"
fi

release_ready=false
if [[ -f "$RECEIPT" ]] && [[ "$(cat "$RECEIPT")" == "$EXPECTED_RECEIPT" ]] \
  && [[ -d "$INSTALL_DIR/node_modules" ]] \
  && [[ -f "$INSTALL_DIR/scripts/worker/deploy/launch-keyword-planner-api-mac.sh" ]] \
  && [[ -f "$INSTALL_DIR/scripts/worker/deploy/skarbiec-acquire.mjs" ]] \
  && [[ -f "$INSTALL_DIR/scripts/worker/deploy/skarbiec-acquisition-scopes.conf" ]]; then
  release_ready=true
fi

if ! $release_ready; then
  TMP="$(mktemp -d "$RELEASE_ROOT/.worker-download.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT
  if [[ -n "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
    source_archive="$STADO_RELEASE_LOCAL_ROOT/weles-worker/$VERSION/$PLATFORM/$ASSET"
    [[ -f "$source_archive" && ! -L "$source_archive" ]] \
      || fail "missing regular staged release archive: $source_archive"
    cp "$source_archive" "$TMP/$ASSET"
  else
    log "fetching immutable $RELEASE_URI"
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
  tar -xzf "$TMP/$ASSET" -C "$STAGED"
  [[ -f "$STAGED/scripts/worker/deploy/skarbiec-acquire.mjs" ]] \
    || fail "verified worker archive is missing its Skarbiec acquisition client"
  [[ -f "$STAGED/scripts/worker/deploy/skarbiec-acquisition-scopes.conf" ]] \
    || fail "verified worker archive is missing its exact Skarbiec acquisition scope catalog"
  [[ -f "$STAGED/scripts/worker/deploy/launch-keyword-planner-api-mac.sh" ]] \
    || fail "verified worker archive is missing its keyword-planner launch helper"
  [[ -d "$STAGED/node_modules" ]] \
    || fail "verified worker archive is missing its runtime dependency tree"
  [[ -f "$STAGED/scripts/chromium/download.sh" ]] \
    || fail "verified worker archive is missing scripts/chromium/download.sh"
  [[ -f "$STAGED/scripts/firefox/download.sh" ]] \
    || fail "verified worker archive is missing scripts/firefox/download.sh"
  printf '%s\n' "$EXPECTED_RECEIPT" > "$STAGED/.weles-release"

  BACKUP="$RELEASE_ROOT/.${VERSION}-${PLATFORM}.previous.$$"
  if [[ -e "$INSTALL_DIR" ]]; then
    mv "$INSTALL_DIR" "$BACKUP"
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if ! mv "$STAGED" "$INSTALL_DIR"; then
    if [[ -e "$BACKUP" ]]; then mv "$BACKUP" "$INSTALL_DIR"; fi
    false
  fi
  rm -rf "$BACKUP"
  log "verified worker release staged: $RELEASE_URI"
fi

# Browser installers fail closed on absent coordinates, release objects, or
# checksum mismatches. Do not activate the API services unless both exact
# browser releases are present with matching receipts.
CHROMIUM_BIN="$(bash "$INSTALL_DIR/scripts/chromium/download.sh")" \
  || fail "required Weles Chromium release is unavailable or invalid"
FIREFOX_BIN="$(bash "$INSTALL_DIR/scripts/firefox/download.sh")" \
  || fail "required Weles Firefox release is unavailable or invalid"
CHROMIUM_SHA256="$(printf '%s' "$WELES_CHROMIUM_RELEASE_SHA256" | tr '[:upper:]' '[:lower:]')"
FIREFOX_SHA256="$(printf '%s' "$WELES_FIREFOX_RELEASE_SHA256" | tr '[:upper:]' '[:lower:]')"
CHROMIUM_URI="stado://releases/weles-chromium/$WELES_CHROMIUM_RELEASE_VERSION/$PLATFORM/weles-chromium.tar.gz"
FIREFOX_URI="stado://releases/weles-firefox/$WELES_FIREFOX_RELEASE_VERSION/$PLATFORM/weles-firefox.tar.gz"
DEPLOYMENT_RECEIPT_FILE="$STATE_DIR/deployment.release"
EXPECTED_DEPLOYMENT_RECEIPT="worker_uri=$RELEASE_URI
worker_sha256=$EXPECTED_SHA256
chromium_uri=$CHROMIUM_URI
chromium_sha256=$CHROMIUM_SHA256
firefox_uri=$FIREFOX_URI
firefox_sha256=$FIREFOX_SHA256"
log "verified browser releases ready: chromium=$CHROMIUM_URI firefox=$FIREFOX_URI"

previous_target=""
if [[ -L "$CURRENT_LINK" ]]; then
  previous_target="$(readlink "$CURRENT_LINK")"
fi
previous_deployment=""
if [[ -f "$DEPLOYMENT_RECEIPT_FILE" ]]; then
  previous_deployment="$(cat "$DEPLOYMENT_RECEIPT_FILE")"
fi
ln -sfn "$INSTALL_DIR" "$CURRENT_LINK"
if [[ "$previous_target" == "$INSTALL_DIR" && "$previous_deployment" == "$EXPECTED_DEPLOYMENT_RECEIPT" ]]; then
  exit
fi

# launchd refuses to start a service whose program is not executable and dies
# with exit 78 (EX_CONFIG), which strands a service silently. Restore the exec
# bit on every launcher in the verified release before bootstrapping.
chmod u+x "$INSTALL_DIR"/scripts/worker/deploy/launch-*.sh

mkdir -p "$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
AGENT_DOMAIN="user/$UID_NUM"
for label in weles-api weles-keyword-planner-api; do
  src="$INSTALL_DIR/scripts/worker/deploy/com.wisent.$label.plist"
  dst="$HOME/Library/LaunchAgents/com.wisent.$label.plist"
  if [[ ! -f "$src" ]]; then
    continue
  fi
  # A previous manual verification run may still own the API port; clear it so
  # launchd owns the long-lived process after this deploy.
  case "$label" in
    weles-keyword-planner-api) stale_port=8787 ;;
    weles-api) stale_port=8788 ;;
    *) stale_port="" ;;
  esac
  if [[ -n "$stale_port" ]]; then
    stale_pids="$(lsof -tiTCP:"$stale_port" -sTCP:LISTEN 2> /dev/null || true)"
    if [[ -n "$stale_pids" ]]; then
      kill $stale_pids 2> /dev/null || true
    fi
  fi
  cp "$src" "$dst"
  chmod u=rw,go=r "$dst"
  launchctl bootout "$AGENT_DOMAIN" "$dst" > /dev/null || true
  if ! launchctl bootstrap "$AGENT_DOMAIN" "$dst"; then
    log "launchd bootstrap deferred to Stado service management: $dst"
  fi
done

printf '%s\n' "$EXPECTED_DEPLOYMENT_RECEIPT" > "$DEPLOYMENT_RECEIPT_FILE"
log "deploy ok: activated immutable $RELEASE_URI"
