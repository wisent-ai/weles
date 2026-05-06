#!/bin/bash
# Polled auto-deploy for the mac-mini weles worker. Runs on a 60-second
# launchd schedule (com.wisent.weles-auto-deploy.plist). Each tick:
#   1. fetch origin/main
#   2. if local HEAD != origin/main, git reset --hard, npm ci if
#      package-lock changed, npm run build
#   3. bootout + bootstrap the weles-worker LaunchAgent so the new
#      dist/ goes live in the running worker.
#
# This replaces a self-hosted GitHub Actions runner (which fails on
# macOS 26 with CoreCLR HRESULT 0x8007000C — bundled .NET incompat
# with the new OS). The polling design is fully self-contained on
# the mac-mini and doesn't need an externally-reachable webhook.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
WELES_DIR="${WELES_DIR:-$HOME/weles}"
LOG="$WELES_DIR/var/auto-deploy.log"
mkdir -p "$WELES_DIR/var"

log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

cd "$WELES_DIR"

# Avoid clobbering uncommitted work on the mac-mini if someone is
# debugging there. If status shows tracked-file modifications, log
# and skip this tick.
if ! git diff --quiet HEAD --; then
  log "skip: uncommitted tracked changes in $WELES_DIR"
  exit 0
fi

git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

log "deploy: $LOCAL → $REMOTE"

BEFORE_LOCK=$(shasum package-lock.json 2>/dev/null | awk '{print $1}' || echo none)
git reset --hard origin/main
AFTER_LOCK=$(shasum package-lock.json 2>/dev/null | awk '{print $1}' || echo none)
if [ "$BEFORE_LOCK" != "$AFTER_LOCK" ]; then
  log "package-lock.json changed — running npm ci"
  npm ci --ignore-scripts >> "$LOG" 2>&1
fi
npm run build >> "$LOG" 2>&1

UID_NUM=$(id -u)
PLIST="$HOME/Library/LaunchAgents/com.wisent.weles-worker.plist"
launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl list | grep com.wisent.weles-worker >> "$LOG" 2>&1 || true

log "deploy ok: now at $REMOTE"
