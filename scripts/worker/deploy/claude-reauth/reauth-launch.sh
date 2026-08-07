#!/bin/bash
# launchd wrapper for the mac-mini claude reauth runner. Mirrors
# scripts/worker/deploy/launch-mac.sh: source worker.env (SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, CHROMIUM_PATH, proxy creds the trajectory
# may read) then exec node reauth.mjs. PATH must include
# /opt/homebrew/bin so reauth.mjs can spawn the login.mjs child node.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_DIR="${WELES_DIR:-$HOME/weles}"
# The deployment env lives where the deployer keeps it, not inside the release:
# `~/weles` is a symlink into an immutable archive that has no `var/`, so reading
# `$WELES_DIR/var/worker.env` fails on every host deployed that way — silently,
# because launchd records the exit somewhere nobody reads. The older layout is
# still honoured for a host that kept its env beside a checkout.
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ] && [ -r "$WELES_DIR/var/worker.env" ]; then
  WELES_WORKER_ENV_FILE="$WELES_DIR/var/worker.env"
fi
if [ ! -r "$WELES_WORKER_ENV_FILE" ]; then
  printf '%s\n' "no readable deployment env file: $WELES_WORKER_ENV_FILE" >/dev/stderr
  false
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
# An immutable release directory is read-only by design, so state goes where the
# deployer already keeps its own.
WELES_STATE_DIR="${WELES_STATE_DIR:-$HOME/.local/state/weles}"
export WELES_STATE_DIR
mkdir -p "$WELES_STATE_DIR"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node \
  "$WELES_DIR/scripts/trajectories/claude/reauth.mjs"
