#!/bin/bash
# Mac launchd wrapper: sources a per-instance env file then execs node.
# PATH must include /opt/homebrew/bin so worker-spawned trajectories can use bare `node`.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# Required by the patched Firefox Playwright/Juggler path on macOS; mirrors
# .github/workflows/firefox-integration.yml.
export MOZ_DISABLE_CONTENT_SANDBOX="${MOZ_DISABLE_CONTENT_SANDBOX:-1}"
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/weles/var/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ]; then
  echo "missing readable Weles worker env file: $WELES_WORKER_ENV_FILE" >&2
  exit 1
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
mkdir -p "$HOME/weles/var"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$HOME/weles/scripts/worker/run.mjs"
