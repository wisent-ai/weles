#!/bin/bash
# launchd wrapper for the Kimi reauth runner.
# Source worker.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CHROMIUM_PATH,
# etc.) then exec node reauth.mjs. PATH includes ~/.kimi-code/bin because the
# native Kimi Code install lives there on macOS.
export PATH="$HOME/.kimi-code/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_DIR="${WELES_DIR:-$HOME/weles}"
set -a
. "$WELES_DIR/var/worker.env"
set +a
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
mkdir -p "$WELES_DIR/var"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node \
  "$WELES_DIR/scripts/trajectories/kimi/reauth.mjs"
