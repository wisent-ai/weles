#!/bin/bash
# launchd wrapper for the mac-mini claude reauth runner. Mirrors
# scripts/worker/deploy/launch-mac.sh: source worker.env (SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, CHROMIUM_PATH, proxy creds the trajectory
# may read) then exec node reauth.mjs. PATH must include
# /opt/homebrew/bin so reauth.mjs can spawn the login.mjs child node.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_DIR="${WELES_DIR:-$HOME/weles}"
set -a
. "$WELES_DIR/var/worker.env"
set +a
mkdir -p "$WELES_DIR/var"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node \
  "$WELES_DIR/scripts/trajectories/claude/reauth.mjs"
