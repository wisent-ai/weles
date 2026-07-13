#!/bin/bash
# macOS launchd wrapper for the Google Ads Keyword Planner API facade.
# The API starts the persistent google_ads keeper on demand when requests arrive.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
if [ -f "$HOME/weles/var/worker.env" ]; then
  . "$HOME/weles/var/worker.env"
fi
set +a
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
mkdir -p "$HOME/weles/var" "$HOME/.weles/browser_profiles/google_ads"
export WELES_REPO="$HOME/weles"
export WELES_KEYWORD_PLANNER_API_HOST="${WELES_KEYWORD_PLANNER_API_HOST:-0.0.0.0}"
export WELES_KEYWORD_PLANNER_API_PORT="${WELES_KEYWORD_PLANNER_API_PORT:-8787}"
export GOOGLE_ADS_KEEPER_START="${GOOGLE_ADS_KEEPER_START:-1}"
export GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS="${GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS:-90000}"
export GOOGLE_ADS_KEEPER_USER_DATA_DIR="${GOOGLE_ADS_KEEPER_USER_DATA_DIR:-$HOME/.weles/browser_profiles/google_ads}"
export KEEPER_USER_DATA_DIR="$GOOGLE_ADS_KEEPER_USER_DATA_DIR"
export WELES_USER_DATA_DIR="$GOOGLE_ADS_KEEPER_USER_DATA_DIR"
exec /opt/homebrew/bin/node "$HOME/weles/scripts/trajectories/google/ads/ads_keyword_planner_api_server.mjs"
