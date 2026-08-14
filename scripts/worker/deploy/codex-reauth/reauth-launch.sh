#!/bin/bash
# launchd wrapper for the mac-mini codex reauth runner.
# Source the deployment env then exec node reauth.mjs.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_DIR="${WELES_DIR:-$HOME/weles}"
# The env file moved to the operator's config directory, and sourcing only the
# in-tree copy meant this job died on its first line while the claude and kimi
# launchers -- which already look in both places -- kept running. Prefer the
# operator's file, accept the in-tree one, and say so rather than failing blind.
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ] && [ -r "$WELES_DIR/var/worker.env" ]; then
  WELES_WORKER_ENV_FILE="$WELES_DIR/var/worker.env"
fi
if [ ! -r "$WELES_WORKER_ENV_FILE" ]; then
  printf '%s\n' "no readable deployment env file: $WELES_WORKER_ENV_FILE" >/dev/stderr
  exit 1
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
WELES_STATE_DIR="${WELES_STATE_DIR:-$HOME/.local/state/weles}"
export WELES_STATE_DIR
mkdir -p "$WELES_STATE_DIR"
# Exercising one step on its own is how a failure inside it gets a reason.
REAUTH_ENTRY="${REAUTH_ENTRY:-$WELES_DIR/scripts/trajectories/codex/reauth.mjs}"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$REAUTH_ENTRY"
