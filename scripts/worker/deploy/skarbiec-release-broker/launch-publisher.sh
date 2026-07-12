#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
umask 077

WELES_DIR="${WELES_DIR:-$HOME/weles}"
SECRETS_DIR="$HOME/.weles-secrets"
PUBLISHER="$WELES_DIR/scripts/worker/deploy/skarbiec-release-broker/publish-completed-builds.py"
WORKER_ENV="$WELES_DIR/var/worker.env"
export SKARBIEC_BIN="$SECRETS_DIR/skarbiec-entitlements-router"
export SKARBIEC_VAULT_FILE="$SECRETS_DIR/skarbiec.vault.json"
export SKARBIEC_RELEASE_PUBLISH_STATE="$SECRETS_DIR/skarbiec-release-publish-state.sqlite3"
export SKARBIEC_RELEASE_AUDIT_DIR="$SECRETS_DIR/skarbiec-release-audit"
export SKARBIEC_RELEASE_POLL_STATE="$SECRETS_DIR/skarbiec-release-poller-state.json"

require_owner_only() {
  local path="$1" owner mode
  owner=$(/usr/bin/stat -f '%Su' "$path")
  mode=$(/usr/bin/stat -f '%OLp' "$path")
  if [ "$owner" != "$(/usr/bin/id -un)" ] || [ $((8#$mode & 8#077)) -ne 0 ]; then
    echo "refusing unsafe Skarbiec publisher material: $path" >&2
    exit 1
  fi
}

require_owner_only "$SECRETS_DIR"

SKARBIEC_UNLOCK=$(/usr/bin/security find-generic-password -s skarbiec-vault -w 2>/dev/null || true)
if [ -z "$SKARBIEC_UNLOCK" ]; then
  [ -f "$WORKER_ENV" ] || { echo "Skarbiec unlock is unavailable" >&2; exit 1; }
  require_owner_only "$WORKER_ENV"
  if ! /bin/bash -n "$WORKER_ENV" 2>/dev/null; then
    echo "worker environment has invalid shell syntax" >&2
    exit 1
  fi
  SKARBIEC_UNLOCK=$(/usr/bin/env -i HOME="$HOME" PATH="$PATH" /bin/bash -c \
    '{ . "$1"; } >/dev/null; printf "%s" "${SKARBIEC_UNLOCK:-}"' publisher-unlock "$WORKER_ENV" 2>/dev/null) || {
      echo "Skarbiec unlock could not be read from the owner-only worker environment" >&2
      exit 1
    }
fi
[ -n "$SKARBIEC_UNLOCK" ] || { echo "Skarbiec unlock is empty" >&2; exit 1; }

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
