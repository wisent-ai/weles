#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
umask 077

WELES_DIR="${WELES_DIR:-$HOME/weles}"
SECRETS_DIR="$HOME/.weles-secrets"
PUBLISHER="$WELES_DIR/scripts/worker/deploy/skarbiec-release-broker/publish-completed-builds.py"
PUBLISHER_ENV="$SECRETS_DIR/skarbiec-release-publisher.env"
export SKARBIEC_BIN="$SECRETS_DIR/skarbiec-entitlements-router"
export SKARBIEC_RELEASE_PUBLISH_STATE="$SECRETS_DIR/skarbiec-release-publish-state.sqlite3"
export SKARBIEC_RELEASE_AUDIT_DIR="$SECRETS_DIR/skarbiec-release-audit"
export SKARBIEC_RELEASE_POLL_STATE="$SECRETS_DIR/skarbiec-release-poller-state.json"

require_owner_only() {
  local path="$1" kind="${2:-any}" owner mode
  [ ! -L "$path" ] || { echo "refusing symlinked Skarbiec publisher material: $path" >&2; exit 1; }
  case "$kind" in
    file) [ -f "$path" ] || { echo "required Skarbiec publisher file is unavailable: $path" >&2; exit 1; } ;;
    directory) [ -d "$path" ] || { echo "required Skarbiec publisher directory is unavailable: $path" >&2; exit 1; } ;;
  esac
  owner=$(/usr/bin/stat -f '%Su' "$path")
  mode=$(/usr/bin/stat -f '%OLp' "$path")
  if [ "$owner" != "$(/usr/bin/id -un)" ] || [ $((8#$mode & 8#077)) -ne 0 ]; then
    echo "refusing unsafe Skarbiec publisher material: $path" >&2
    exit 1
  fi
}

require_owner_only "$SECRETS_DIR" directory
require_owner_only "$PUBLISHER_ENV" file
SKARBIEC_VAULT_FILE=""
SKARBIEC_UNLOCK=""
SEEN_SKARBIEC_VAULT_FILE=false
SEEN_SKARBIEC_UNLOCK=false
while IFS='=' read -r key value || [ -n "$key$value" ]; do
  case "$key" in
    SKARBIEC_VAULT_FILE)
      [ "$SEEN_SKARBIEC_VAULT_FILE" = false ] || { echo "duplicate SKARBIEC_VAULT_FILE" >&2; exit 1; }
      SEEN_SKARBIEC_VAULT_FILE=true
      SKARBIEC_VAULT_FILE="$value"
      ;;
    SKARBIEC_UNLOCK)
      [ "$SEEN_SKARBIEC_UNLOCK" = false ] || { echo "duplicate SKARBIEC_UNLOCK" >&2; exit 1; }
      SEEN_SKARBIEC_UNLOCK=true
      SKARBIEC_UNLOCK="$value"
      ;;
    *) echo "unknown Skarbiec publisher environment key" >&2; exit 1 ;;
  esac
done < "$PUBLISHER_ENV"

case "$SKARBIEC_VAULT_FILE" in
  /*) ;;
  *) echo "SKARBIEC_VAULT_FILE must be absolute" >&2; exit 1 ;;
esac
case "$SKARBIEC_UNLOCK" in
  ''|*[!A-Za-z0-9_-]*) echo "SKARBIEC_UNLOCK is invalid" >&2; exit 1 ;;
esac
require_owner_only "$SKARBIEC_VAULT_FILE" file

exec /usr/bin/env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  SKARBIEC_BIN="$SKARBIEC_BIN" \
  SKARBIEC_VAULT_FILE="$SKARBIEC_VAULT_FILE" \
  SKARBIEC_RELEASE_PUBLISH_STATE="$SKARBIEC_RELEASE_PUBLISH_STATE" \
  SKARBIEC_RELEASE_AUDIT_DIR="$SKARBIEC_RELEASE_AUDIT_DIR" \
  SKARBIEC_RELEASE_POLL_STATE="$SKARBIEC_RELEASE_POLL_STATE" \
  SKARBIEC_UNLOCK="$SKARBIEC_UNLOCK" \
  /usr/bin/python3 "$PUBLISHER"
