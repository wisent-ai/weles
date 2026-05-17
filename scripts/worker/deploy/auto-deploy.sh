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

# Ensure the gcloud CLI has an active service account so the worker's
# `gcloud storage cp` calls in scripts/trajectories/*/persist*.mjs can
# upload artifacts to GCS without a manual `gcloud auth login`. This
# block runs BEFORE the new-commit check so the activation is verified
# on every 60-second tick, not just on deploy ticks. Self-heals across
# reboots, macOS upgrades, `brew upgrade google-cloud-sdk`, `gcloud
# auth revoke`, full disk reprovisioning, and service-account key
# rotations — anything that wipes ~/.config/gcloud/ gets caught at the
# next tick rather than waiting for the next git commit to land.
# Without this, `gcloud auth list` returns "No credentialed accounts"
# and every persist call fails with `gcloud storage cp failed (1):
# You do not currently have an active account selected.` — which is
# exactly the silent failure mode that ate the 2026-05-13 UW
# screenshot uploads.
GCLOUD_SA_KEY="$HOME/.config/gcloud/application_default_credentials.json"
GCLOUD_SA_MIRROR_DIR="$HOME/.weles-secrets"
GCLOUD_SA_MIRROR="$GCLOUD_SA_MIRROR_DIR/droid-441-adc.json"
mkdir -p "$GCLOUD_SA_MIRROR_DIR"
chmod 700 "$GCLOUD_SA_MIRROR_DIR"

# Self-heal layer 1: mirror the canonical ADC to a stable secondary
# location each tick so an accidental wipe of ~/.config/gcloud/ is
# recoverable. Only writes when the contents differ — no churn.
if [ -f "$GCLOUD_SA_KEY" ]; then
  if [ ! -f "$GCLOUD_SA_MIRROR" ] || ! cmp -s "$GCLOUD_SA_KEY" "$GCLOUD_SA_MIRROR"; then
    cp "$GCLOUD_SA_KEY" "$GCLOUD_SA_MIRROR"
    chmod 600 "$GCLOUD_SA_MIRROR"
    log "gcloud: mirrored ADC to $GCLOUD_SA_MIRROR"
  fi
fi

# Self-heal layer 2: if the canonical ADC was deleted (or the
# ~/.config/gcloud/ dir was wiped by macOS upgrade) but the mirror
# survives, restore the canonical from the mirror before activation.
if [ ! -f "$GCLOUD_SA_KEY" ] && [ -f "$GCLOUD_SA_MIRROR" ]; then
  mkdir -p "$(dirname "$GCLOUD_SA_KEY")"
  cp "$GCLOUD_SA_MIRROR" "$GCLOUD_SA_KEY"
  chmod 600 "$GCLOUD_SA_KEY"
  log "gcloud: restored ADC from mirror $GCLOUD_SA_MIRROR -> $GCLOUD_SA_KEY"
fi

# Self-heal layer 3: ensure gcloud CLI has an active service account.
# Runs even when ADC is missing — gcloud will emit an actionable error
# to the log if the activate call has no key to read, rather than
# silently no-oping. With layers 1+2 above, ADC is present in all
# scenarios except simultaneous wipe of both canonical and mirror —
# which is below the threshold of automatable recovery and is the only
# state requiring out-of-band SA key provisioning.
if [ -f "$GCLOUD_SA_KEY" ]; then
  ACTIVE_SA=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)
  if [ -z "$ACTIVE_SA" ]; then
    log "gcloud: no active account — activating from $GCLOUD_SA_KEY"
    gcloud auth activate-service-account --key-file="$GCLOUD_SA_KEY" >> "$LOG" 2>&1
  fi
else
  log "gcloud: BOTH $GCLOUD_SA_KEY and $GCLOUD_SA_MIRROR missing — uploads will fail until provisioning runs"
fi

# Ensure the claude-reauth LaunchAgent is installed and current. Like
# the gcloud self-heal above, this runs every tick (BEFORE the
# no-new-commit early-exit) so the agent survives reboots / accidental
# bootout without waiting for the next commit. Acts ONLY when the
# installed plist differs from the repo copy, so steady-state ticks are
# a no-op and never bootout an in-flight reauth run.
REAUTH_SRC="$WELES_DIR/scripts/worker/deploy/claude-reauth/com.wisent.claude-reauth.plist"
REAUTH_DST="$HOME/Library/LaunchAgents/com.wisent.claude-reauth.plist"
if [ -f "$REAUTH_SRC" ]; then
  if [ ! -f "$REAUTH_DST" ] || ! cmp -s "$REAUTH_SRC" "$REAUTH_DST"; then
    cp "$REAUTH_SRC" "$REAUTH_DST"
    chmod 644 "$REAUTH_DST"
    chmod +x "$WELES_DIR/scripts/worker/deploy/claude-reauth/reauth-launch.sh"
    RU_UID=$(id -u)
    launchctl bootout "gui/$RU_UID" "$REAUTH_DST" 2>/dev/null || true
    launchctl bootstrap "gui/$RU_UID" "$REAUTH_DST"
    log "claude-reauth: (re)installed LaunchAgent from repo"
  fi
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
