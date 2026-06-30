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

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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

# Keep GitHub tokens out of git remote URLs. If an older host has a tokenized
# origin URL, move that credential into a launchd-safe file helper and rewrite
# the remote before the next fetch. This keeps deploy working for private repos
# without leaving the secret in routine command/log/transcript output.
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || true)
case "$ORIGIN_URL" in
  https://x-access-token:*@github.com/wisent-ai/weles.git)
    GITHUB_REMOTE_TOKEN="${ORIGIN_URL#https://x-access-token:}"
    GITHUB_REMOTE_TOKEN="${GITHUB_REMOTE_TOKEN%@github.com/wisent-ai/weles.git}"
    GITHUB_CREDENTIAL_FILE="$HOME/.git-credentials-weles"
    umask 077
    printf 'https://x-access-token:%s@github.com\n' "$GITHUB_REMOTE_TOKEN" > "$GITHUB_CREDENTIAL_FILE"
    git config --global --replace-all credential.helper "store --file $GITHUB_CREDENTIAL_FILE"
    git remote set-url origin https://github.com/wisent-ai/weles.git
    unset GITHUB_REMOTE_TOKEN
    log "github-auth: moved origin credential into helper and scrubbed remote URL"
    ;;
esac

# launchd cannot read the interactive osxkeychain session, and a repo-local
# helper overrides the global file helper. A blank local helper resets inherited
# system helpers; the following local store helper is then the only one tried.
if [ -f "$HOME/.git-credentials-weles" ]; then
  git config --local --replace-all credential.helper ""
  git config --local --add credential.helper "store --file $HOME/.git-credentials-weles"
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

# Ensure the pinned weles Chromium binary is present. download.sh no-ops when
# the version dir already exists; bumping the pinned tag (WELES_CHROMIUM_RELEASE
# or the script default) on a deploy pulls the new build, and find_browser.ts
# auto-selects the newest installed version. Non-fatal: a download failure must
# not block the code deploy or the worker restart — the worker keeps whatever
# binary is already on disk.
if CHROMIUM_BIN="$(bash "$WELES_DIR/scripts/chromium/download.sh" 2>>"$LOG")"; then
  log "chromium ready: $CHROMIUM_BIN"
else
  log "chromium: download.sh failed (keeping existing on-disk binary)"
fi

# node-pty (claude-reauth drives `claude setup-token` on a real pty
# via it) ships an INCOMPLETE darwin-arm64 prebuild — pty.node but no
# spawn-helper — and `npm ci --ignore-scripts` above skips node-pty's
# own install/build. Without build/Release/spawn-helper, pty.spawn()
# dies "posix_spawnp failed" (observed locally) and the reauth login
# cannot start. Build the native addon explicitly. Idempotent: skips
# when spawn-helper is already present; logs FAILED (not silent) if
# the toolchain is missing so it is diagnosable on the next tick.
# Claude Code CLI (the real `claude` binary) is what login.mjs drives
# via `claude auth login --claudeai` for the reauth flow. Without it,
# login.mjs's existsSync guard fails fast with
# "FAIL: claude binary not at $HOME/.local/bin/claude" and the
# claude-reauth LaunchAgent loops on every tick (observed on mac mini
# 2026-05-19 06:50Z claude-reauth.log). Install via the official
# installer if missing — it places the binary at
# $HOME/.local/bin/claude -> $HOME/.local/share/claude/versions/X.Y.Z,
# the exact path login.mjs resolves. Idempotent: skips when present.
if [ ! -x "$HOME/.local/bin/claude" ]; then
  log "claude-code: installing CLI (missing at \$HOME/.local/bin/claude)"
  if curl -fsSL https://claude.ai/install.sh | bash >> "$LOG" 2>&1; then
    log "claude-code: install ok ($($HOME/.local/bin/claude --version 2>/dev/null | head -1))"
  else
    log "claude-code: install FAILED — claude-reauth will not function until fixed"
  fi
fi

NODE_PTY_DIR="$WELES_DIR/node_modules/node-pty"
if [ -d "$NODE_PTY_DIR" ] && [ ! -x "$NODE_PTY_DIR/build/Release/spawn-helper" ]; then
  log "node-pty: building native addon (spawn-helper missing)"
  if ( cd "$NODE_PTY_DIR" && npx --yes node-gyp rebuild ) >> "$LOG" 2>&1; then
    log "node-pty: build ok"
  else
    log "node-pty: build FAILED — claude-reauth will not function until fixed"
  fi
fi

# Keep the macOS LaunchAgents in source control too. Older hosts had
# ~/Library/LaunchAgents/*.plist and launch-*.sh as hand-written local files,
# so a fresh clone could build successfully but fail at restart or keep using
# drifted wrappers.
WORKER_PLIST_SRC="$WELES_DIR/scripts/worker/deploy/com.wisent.weles-worker.plist"
WORKER_PLIST_DST="$HOME/Library/LaunchAgents/com.wisent.weles-worker.plist"
if [ -f "$WORKER_PLIST_SRC" ]; then
  if [ ! -f "$WORKER_PLIST_DST" ] || ! cmp -s "$WORKER_PLIST_SRC" "$WORKER_PLIST_DST"; then
    cp "$WORKER_PLIST_SRC" "$WORKER_PLIST_DST"
    chmod 644 "$WORKER_PLIST_DST"
    log "worker-launchd: installed LaunchAgent from repo"
  fi
fi

KEYWORD_API_PLIST_SRC="$WELES_DIR/scripts/worker/deploy/com.wisent.weles-keyword-planner-api.plist"
KEYWORD_API_PLIST_DST="$HOME/Library/LaunchAgents/com.wisent.weles-keyword-planner-api.plist"
if [ -f "$KEYWORD_API_PLIST_SRC" ]; then
  if [ ! -f "$KEYWORD_API_PLIST_DST" ] || ! cmp -s "$KEYWORD_API_PLIST_SRC" "$KEYWORD_API_PLIST_DST"; then
    cp "$KEYWORD_API_PLIST_SRC" "$KEYWORD_API_PLIST_DST"
    chmod 644 "$KEYWORD_API_PLIST_DST"
    log "keyword-planner-api: installed LaunchAgent from repo"
  fi
fi
chmod +x "$WELES_DIR/scripts/worker/deploy/launch-mac.sh"
chmod +x "$WELES_DIR/scripts/worker/deploy/launch-keyword-planner-api-mac.sh"


UID_NUM=$(id -u)
PLIST="$HOME/Library/LaunchAgents/com.wisent.weles-worker.plist"
launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
KEYWORD_API_PLIST="$HOME/Library/LaunchAgents/com.wisent.weles-keyword-planner-api.plist"
if [ -f "$KEYWORD_API_PLIST" ]; then
  launchctl bootout "gui/$UID_NUM" "$KEYWORD_API_PLIST" 2>/dev/null || true
  # A previous manual verification run may still own :8787; clear it so launchd
  # owns the long-lived API process after this deploy.
  KEYWORD_API_PIDS=$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$KEYWORD_API_PIDS" ]; then
    kill $KEYWORD_API_PIDS 2>/dev/null || true
  fi
  launchctl bootstrap "gui/$UID_NUM" "$KEYWORD_API_PLIST"
  launchctl list | grep com.wisent.weles-keyword-planner-api >> "$LOG" 2>&1 || true
fi
launchctl list | grep com.wisent.weles-worker >> "$LOG" 2>&1 || true

log "deploy ok: now at $REMOTE"
