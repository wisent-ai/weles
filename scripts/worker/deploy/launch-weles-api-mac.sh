#!/bin/bash
# macOS launchd wrapper for the Weles HTTP API server.
# Runs trajectories synchronously over HTTP (shoot-at-server) instead of the
# Supabase enqueue -> poll queue. Reuses the worker's resolveTrajectory/paramsToEnv.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
# base worker runtime (proxy, chromium path, captcha keys, supabase creds)
if [ -f "$HOME/weles/var/worker.env" ]; then
  . "$HOME/weles/var/worker.env"
fi
# content overrides (yqiz project - trading/stock_context persistence)
if [ -f "$HOME/weles/var/worker-content.env" ]; then
  . "$HOME/weles/var/worker-content.env"
fi
# runtime secret store (vault) - provides WELES_API_TOKEN
if [ -f "$HOME/.weles/secrets.env" ]; then
  . "$HOME/.weles/secrets.env"
fi
set +a
mkdir -p "$HOME/weles/var"
export WELES_REPO="$HOME/weles"
export WELES_API_HOST="${WELES_API_HOST:-0.0.0.0}"
export WELES_API_PORT="${WELES_API_PORT:-8788}"
exec /opt/homebrew/bin/node "$HOME/weles/scripts/worker/weles-api-server.mjs"
