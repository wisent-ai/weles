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

# Legacy Semantic Scholar follow-up versions copied API keys into the GUI
# launchd environment. Remove both aliases before any worker bootstrap so
# third-party credentials cannot be inherited by unrelated long-lived jobs.
launchctl unsetenv SEMANTIC_SCHOLAR_API_KEY 2>/dev/null || true
launchctl unsetenv S2_API_KEY 2>/dev/null || true
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true

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

# Keep the encrypted Skarbiec sync mirror ready on every deploy tick. All
# values come from the owner-only worker.env; Git authentication remains in
# the existing owner-only Weles credential file and never enters the remote URL.
SKARBIEC_WORKER_ENV="$WELES_DIR/var/worker.env"
if [ -f "$SKARBIEC_WORKER_ENV" ] && [ ! -L "$SKARBIEC_WORKER_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SKARBIEC_WORKER_ENV"
  set +a
  if [ -n "${SKARBIEC_SYNC_DIR:-}" ] && [ -n "${SKARBIEC_SYNC_REMOTE:-}" ]; then
    if [ ! -d "$SKARBIEC_SYNC_DIR/.git" ]; then
      if [ -e "$SKARBIEC_SYNC_DIR" ]; then
        log "skarbiec-sync: refusing to replace non-repository path $SKARBIEC_SYNC_DIR"
        exit 1
      fi
      GIT_TERMINAL_PROMPT=0 git clone --quiet "$SKARBIEC_SYNC_REMOTE" "$SKARBIEC_SYNC_DIR"
      log "skarbiec-sync: cloned encrypted vault mirror"
    else
      git -C "$SKARBIEC_SYNC_DIR" remote set-url origin "$SKARBIEC_SYNC_REMOTE"
    fi
    if [ -f "$HOME/.git-credentials-weles" ]; then
      git -C "$SKARBIEC_SYNC_DIR" config --local --replace-all credential.helper ""
      git -C "$SKARBIEC_SYNC_DIR" config --local --add credential.helper "store --file $HOME/.git-credentials-weles"
    fi
    GIT_TERMINAL_PROMPT=0 git -C "$SKARBIEC_SYNC_DIR" fetch --quiet origin main
    log "skarbiec-sync: repository and non-interactive Git authentication ready"
  fi
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

# Ensure the codex-reauth LaunchAgent is installed, executable, and healthy on
# every tick (BEFORE the no-new-commit early-exit). Unlike a plist-diff-gated
# heal, the wrapper chmod +x runs UNCONDITIONALLY: the wrapper is committed
# 0644 in older trees and a `git reset --hard` strips the exec bit, so launchd
# cannot exec it (exit 78 EX_CONFIG) with the plist unchanged — the exact fault
# that stranded codex-reauth and let the token expire. `test -x` before the
# chmod detects that state and forces a re-bootstrap; a positive post-bootstrap
# load check alerts loudly instead of silently claiming "healed".
CODEX_REAUTH_SRC="$WELES_DIR/scripts/worker/deploy/codex-reauth/com.wisent.codex-reauth.plist"
CODEX_REAUTH_DST="$HOME/Library/LaunchAgents/com.wisent.codex-reauth.plist"
CODEX_REAUTH_WRAPPER="$WELES_DIR/scripts/worker/deploy/codex-reauth/reauth-launch.sh"
if [ -f "$CODEX_REAUTH_SRC" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  CODEX_REAUTH_NEEDS_BOOTSTRAP=0
  if [ ! -x "$CODEX_REAUTH_WRAPPER" ]; then
    CODEX_REAUTH_NEEDS_BOOTSTRAP=1
    log "codex-reauth: wrapper was not executable (launchd exit 78 cause) — fixing + re-bootstrapping"
  fi
  chmod +x "$CODEX_REAUTH_WRAPPER" 2>/dev/null || true
  CR_UID=$(id -u)
  if [ ! -f "$CODEX_REAUTH_DST" ] || ! cmp -s "$CODEX_REAUTH_SRC" "$CODEX_REAUTH_DST"; then
    cp "$CODEX_REAUTH_SRC" "$CODEX_REAUTH_DST"
    chmod 644 "$CODEX_REAUTH_DST"
    CODEX_REAUTH_NEEDS_BOOTSTRAP=1
  fi
  if ! launchctl print "gui/$CR_UID/com.wisent.codex-reauth" >/dev/null 2>&1; then
    CODEX_REAUTH_NEEDS_BOOTSTRAP=1
  fi
  if [ "$CODEX_REAUTH_NEEDS_BOOTSTRAP" = "1" ]; then
    launchctl bootout "gui/$CR_UID" "$CODEX_REAUTH_DST" 2>/dev/null || true
    launchctl bootstrap "gui/$CR_UID" "$CODEX_REAUTH_DST"
    log "codex-reauth: (re)installed LaunchAgent from repo"
    sleep 3
    if launchctl print "gui/$CR_UID/com.wisent.codex-reauth" >/dev/null 2>&1; then
      if [ ! -x "$CODEX_REAUTH_WRAPPER" ]; then
        log "codex-reauth: ALERT wrapper still not executable after chmod — NOT healthy"
      fi
    else
      log "codex-reauth: ALERT not loaded after bootstrap — check worker.env / codex-reauth.log"
    fi
  fi
fi

# Ensure the keyword-planner API LaunchAgent is installed and loaded on every
# tick. The first deploy that introduces this file is still running the old
# script body, so the self-heal must live before the no-new-commit early-exit.
KEYWORD_API_PLIST_SRC_PRE="$WELES_DIR/scripts/worker/deploy/com.wisent.weles-keyword-planner-api.plist"
KEYWORD_API_PLIST_DST_PRE="$HOME/Library/LaunchAgents/com.wisent.weles-keyword-planner-api.plist"
if [ -f "$KEYWORD_API_PLIST_SRC_PRE" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  KEYWORD_API_NEEDS_BOOTSTRAP=0
  if [ ! -f "$KEYWORD_API_PLIST_DST_PRE" ] || ! cmp -s "$KEYWORD_API_PLIST_SRC_PRE" "$KEYWORD_API_PLIST_DST_PRE"; then
    cp "$KEYWORD_API_PLIST_SRC_PRE" "$KEYWORD_API_PLIST_DST_PRE"
    chmod 644 "$KEYWORD_API_PLIST_DST_PRE"
    chmod +x "$WELES_DIR/scripts/worker/deploy/launch-keyword-planner-api-mac.sh"
    KEYWORD_API_NEEDS_BOOTSTRAP=1
  fi
  KU_UID=$(id -u)
  if ! launchctl print "gui/$KU_UID/com.wisent.weles-keyword-planner-api" >/dev/null 2>&1; then
    KEYWORD_API_NEEDS_BOOTSTRAP=1
  fi
  if [ "$KEYWORD_API_NEEDS_BOOTSTRAP" = "1" ]; then
    launchctl bootout "gui/$KU_UID" "$KEYWORD_API_PLIST_DST_PRE" 2>/dev/null || true
    KEYWORD_API_PIDS_PRE=$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$KEYWORD_API_PIDS_PRE" ]; then
      kill $KEYWORD_API_PIDS_PRE 2>/dev/null || true
    fi
    launchctl bootstrap "gui/$KU_UID" "$KEYWORD_API_PLIST_DST_PRE"
    log "keyword-planner-api: ensured LaunchAgent from repo"
  fi
fi

# Ensure the Echo scrape worker LaunchAgent is installed. It uses a
# separate env file and an action allowlist, so the existing Weles worker keeps
# serving the legacy queue while this scoped worker serves Byk/content scrapes.
CONTENT_WORKER_PLIST_SRC="$WELES_DIR/scripts/worker/deploy/com.wisent.weles-content-worker.plist"
CONTENT_WORKER_PLIST_DST="$HOME/Library/LaunchAgents/com.wisent.weles-content-worker.plist"
if [ -f "$CONTENT_WORKER_PLIST_SRC" ] && [ -f "$WELES_DIR/var/worker-content.env" ]; then
  CONTENT_WORKER_NEEDS_BOOTSTRAP=0
  if [ ! -f "$CONTENT_WORKER_PLIST_DST" ] || ! cmp -s "$CONTENT_WORKER_PLIST_SRC" "$CONTENT_WORKER_PLIST_DST"; then
    cp "$CONTENT_WORKER_PLIST_SRC" "$CONTENT_WORKER_PLIST_DST"
    chmod 644 "$CONTENT_WORKER_PLIST_DST"
    chmod +x "$WELES_DIR/scripts/worker/deploy/launch-mac.sh"
    CONTENT_WORKER_NEEDS_BOOTSTRAP=1
  fi
  CW_UID=$(id -u)
  if ! launchctl print "gui/$CW_UID/com.wisent.weles-content-worker" >/dev/null 2>&1; then
    CONTENT_WORKER_NEEDS_BOOTSTRAP=1
  fi
  if [ "$CONTENT_WORKER_NEEDS_BOOTSTRAP" = "1" ]; then
    launchctl bootout "gui/$CW_UID" "$CONTENT_WORKER_PLIST_DST" 2>/dev/null || true
    launchctl bootstrap "gui/$CW_UID" "$CONTENT_WORKER_PLIST_DST"
    log "content-worker: ensured LaunchAgent from repo"
  fi
fi

# Ensure the pinned weles browser binaries are present. download.sh no-ops when
# the version dir already exists; bumping the pinned tag in scripts/{chromium,
# firefox}/download.sh pulls the new build, and find_browser.ts auto-selects
# the newest installed version. Runs before the no-new-commit early exit so a
# host with missing binaries self-heals even when code is already current.
# Non-fatal: a download failure must not block deploy or worker restart — the
# worker keeps whatever binary is already on disk, and missing-browser errors
# stay visible in worker.log.
ensure_browser_binaries() {
  if CHROMIUM_BIN="$(bash "$WELES_DIR/scripts/chromium/download.sh" 2>>"$LOG")"; then
    log "chromium ready: $CHROMIUM_BIN"
  else
    log "chromium: download.sh failed (keeping existing on-disk binary)"
  fi
  if FIREFOX_BIN="$(bash "$WELES_DIR/scripts/firefox/download.sh" 2>>"$LOG")"; then
    log "firefox ready: $FIREFOX_BIN"
  else
    log "firefox: download.sh failed (keeping existing on-disk binary)"
  fi
}

ensure_browser_binaries

# Ensure the Weles HTTP API LaunchAgent is installed and loaded on every tick.
# Same self-heal pattern as keyword-planner-api: must run before the
# no-new-commit early-exit so a reboot/bootout is repaired without a commit.
WELES_API_PLIST_SRC_PRE="$WELES_DIR/scripts/worker/deploy/com.wisent.weles-api.plist"
WELES_API_PLIST_DST_PRE="$HOME/Library/LaunchAgents/com.wisent.weles-api.plist"
if [ -f "$WELES_API_PLIST_SRC_PRE" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  WELES_API_NEEDS_BOOTSTRAP=0
  if [ ! -f "$WELES_API_PLIST_DST_PRE" ] || ! cmp -s "$WELES_API_PLIST_SRC_PRE" "$WELES_API_PLIST_DST_PRE"; then
    cp "$WELES_API_PLIST_SRC_PRE" "$WELES_API_PLIST_DST_PRE"
    chmod 644 "$WELES_API_PLIST_DST_PRE"
    chmod +x "$WELES_DIR/scripts/worker/deploy/launch-weles-api-mac.sh"
    WELES_API_NEEDS_BOOTSTRAP=1
  fi
  WA_UID=$(id -u)
  if ! launchctl print "gui/$WA_UID/com.wisent.weles-api" >/dev/null 2>&1; then
    WELES_API_NEEDS_BOOTSTRAP=1
  fi
  if [ "$WELES_API_NEEDS_BOOTSTRAP" = "1" ]; then
    launchctl bootout "gui/$WA_UID" "$WELES_API_PLIST_DST_PRE" 2>/dev/null || true
    WELES_API_PIDS_PRE=$(lsof -tiTCP:8788 -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$WELES_API_PIDS_PRE" ]; then
      kill $WELES_API_PIDS_PRE 2>/dev/null || true
    fi
    launchctl bootstrap "gui/$WA_UID" "$WELES_API_PLIST_DST_PRE"
    log "weles-api: ensured LaunchAgent from repo"
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

ensure_browser_binaries

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

CONTENT_WORKER_PLIST_SRC="$WELES_DIR/scripts/worker/deploy/com.wisent.weles-content-worker.plist"
CONTENT_WORKER_PLIST_DST="$HOME/Library/LaunchAgents/com.wisent.weles-content-worker.plist"
if [ -f "$CONTENT_WORKER_PLIST_SRC" ] && [ -f "$WELES_DIR/var/worker-content.env" ]; then
  if [ ! -f "$CONTENT_WORKER_PLIST_DST" ] || ! cmp -s "$CONTENT_WORKER_PLIST_SRC" "$CONTENT_WORKER_PLIST_DST"; then
    cp "$CONTENT_WORKER_PLIST_SRC" "$CONTENT_WORKER_PLIST_DST"
    chmod 644 "$CONTENT_WORKER_PLIST_DST"
    log "content-worker: installed LaunchAgent from repo"
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

WELES_API_PLIST_SRC="$WELES_DIR/scripts/worker/deploy/com.wisent.weles-api.plist"
WELES_API_PLIST_DST="$HOME/Library/LaunchAgents/com.wisent.weles-api.plist"
if [ -f "$WELES_API_PLIST_SRC" ]; then
  if [ ! -f "$WELES_API_PLIST_DST" ] || ! cmp -s "$WELES_API_PLIST_SRC" "$WELES_API_PLIST_DST"; then
    cp "$WELES_API_PLIST_SRC" "$WELES_API_PLIST_DST"
    chmod 644 "$WELES_API_PLIST_DST"
    log "weles-api: installed LaunchAgent from repo"
  fi
fi
chmod +x "$WELES_DIR/scripts/worker/deploy/launch-weles-api-mac.sh"


UID_NUM=$(id -u)
PLIST="$HOME/Library/LaunchAgents/com.wisent.weles-worker.plist"
launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
CONTENT_WORKER_PLIST="$HOME/Library/LaunchAgents/com.wisent.weles-content-worker.plist"
if [ -f "$CONTENT_WORKER_PLIST" ] && [ -f "$WELES_DIR/var/worker-content.env" ]; then
  launchctl bootout "gui/$UID_NUM" "$CONTENT_WORKER_PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$CONTENT_WORKER_PLIST"
  launchctl list | grep com.wisent.weles-content-worker >> "$LOG" 2>&1 || true
fi
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
WELES_API_PLIST="$HOME/Library/LaunchAgents/com.wisent.weles-api.plist"
if [ -f "$WELES_API_PLIST" ]; then
  launchctl bootout "gui/$UID_NUM" "$WELES_API_PLIST" 2>/dev/null || true
  # A previous manual verification run may still own :8788; clear it so launchd
  # owns the long-lived API process after this deploy.
  WELES_API_PIDS=$(lsof -tiTCP:8788 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$WELES_API_PIDS" ]; then
    kill $WELES_API_PIDS 2>/dev/null || true
  fi
  launchctl bootstrap "gui/$UID_NUM" "$WELES_API_PLIST"
  launchctl list | grep com.wisent.weles-api >> "$LOG" 2>&1 || true
fi
launchctl list | grep com.wisent.weles-worker >> "$LOG" 2>&1 || true

log "deploy ok: now at $REMOTE"
