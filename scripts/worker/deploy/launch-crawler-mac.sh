#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
for env_file in \
  "$HOME/weles/var/worker.env" \
  "$HOME/weles/var/worker-content.env" \
  "$HOME/.config/weles/worker.env" \
  "$HOME/.weles/secrets.env" \
  "$HOME/.stado/weles-model.env"
do
  if [ -f "$env_file" ]; then . "$env_file"; fi
done
set +a
: "${WELES_CRAWLER_TOKEN:=${WELES_API_TOKEN:-}}"
: "${WELES_CRAWLER_TOKEN:?WELES_CRAWLER_TOKEN or WELES_API_TOKEN is required}"
export WELES_CRAWLER_TOKEN
export WELES_CRAWLER_HOST="${WELES_CRAWLER_HOST:-127.0.0.1}"
export WELES_CRAWLER_PORT="${WELES_CRAWLER_PORT:-8795}"
export WELES_REPO="$HOME/weles"
mkdir -p "$HOME/.stado/weles-crawler-runs" "$HOME/weles/var"
exec /opt/homebrew/bin/node "$HOME/weles/scripts/worker/weles-crawler-server.mjs"
