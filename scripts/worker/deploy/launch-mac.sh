#!/bin/bash
# Mac launchd wrapper: sources a per-instance env file, self-provisions the
# skarbiec binary, rebuilds the local encrypted vault from the authoring store,
# then execs node. Every skarbiec dependency self-heals on each launch (mirrors
# the gcloud SA self-heal in auto-deploy.sh) so no manual step ever runs here.
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
# Reject a syntactically broken env file up front. Sourcing `set -a`-style
# aborts mid-file on an unquoted value (e.g. a regex with `(` or `|`), which
# would export only the vars before the bad line and silently start the worker
# with a half-loaded env — the exact cause of a content worker claiming jobs
# outside its WELES_ACTION_ALLOW_RE scope. Fail loud instead.
if ! bash -n "$WELES_WORKER_ENV_FILE" 2>/dev/null; then
  echo "Weles worker env file has a syntax error (quote values with regex/special chars): $WELES_WORKER_ENV_FILE" >&2
  exit 1
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
mkdir -p "$HOME/weles/var"
SECRETS_DIR="$HOME/.weles-secrets"
mkdir -p "$SECRETS_DIR"; chmod go-rwx "$SECRETS_DIR"
SKARBIEC_LOG="$HOME/weles/var/skarbiec.log"

# --- skarbiec binary self-provision (pull-only; no SSH) --------------------
# Download the CI-built arm64 binary from the entitlements-rotator rolling
# release and verify its checksum before trusting it. gh uses the ambient
# value loaded above. Best-effort: on any failure the previous binary is kept.
SKARBIEC_BIN="${SKARBIEC_BIN:-$SECRETS_DIR/skarbiec-entitlements-router}"
SKARBIEC_REPO="${SKARBIEC_REPO:-lbartoszcze/entitlements-rotator}"
if command -v gh >/dev/null; then
  STAGE="$(mktemp -d)"
  if gh release download skarbiec-bin-latest -R "$SKARBIEC_REPO" -D "$STAGE" -p 'skarbiec-entitlements-router' -p 'skarbiec-entitlements-router.sha256' --clobber >>"$SKARBIEC_LOG" 2>&1; then
    WANT="$(cat "$STAGE/skarbiec-entitlements-router.sha256" 2>/dev/null)"
    GOT="$(openssl dgst -sha256 "$STAGE/skarbiec-entitlements-router" 2>/dev/null | awk '{print $NF}')"
    if [ -n "$WANT" ] && [ "$WANT" = "$GOT" ]; then
      chmod +x "$STAGE/skarbiec-entitlements-router"
      mv -f "$STAGE/skarbiec-entitlements-router" "$SKARBIEC_BIN"
    fi
  fi
  rm -rf "$STAGE"
fi

# --- skarbiec vault: rebuild from the authoring store each launch ----------
# The worker vault is a local encrypted materialization of the Supabase
# service_credentials store (where rows are authored by the sync workflow and
# trajectory updates). It is rebuilt fresh each launch so it is always current.
# The keypair is generated once on the first launch and reused after (init is
# idempotent on keys); the private half is created here and never leaves the box.
# The unlock value gates a protected key: a login-keychain item if an operator
# set one, else the SKARBIEC_UNLOCK from the env file, else empty (unprotected).
export SKARBIEC_VAULT_FILE="${SKARBIEC_VAULT_FILE:-$SECRETS_DIR/skarbiec.vault.json}"
SKARBIEC_VIEW="${SKARBIEC_VIEW:-$HOME/weles/var/skarbiec-weles.json}"
UNLOCK="$(security find-generic-password -s skarbiec-vault -w 2>/dev/null || printf '%s' "${SKARBIEC_UNLOCK:-}")"
if [ -x "$SKARBIEC_BIN" ] && [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  ROWS="$(mktemp)"
  APIHDR="apikey: $SUPABASE_SERVICE_ROLE_KEY"
  AUTHHDR="Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
  if curl -fsS "$SUPABASE_URL/rest/v1/service_credentials?select=*" -H "$APIHDR" -H "$AUTHHDR" > "$ROWS" 2>>"$SKARBIEC_LOG"; then
    rm -f "$SKARBIEC_VAULT_FILE"
    if SKARBIEC_UNLOCK="$UNLOCK" "$SKARBIEC_BIN" init skarbiec-owner >>"$SKARBIEC_LOG" 2>&1        && SKARBIEC_UNLOCK="$UNLOCK" "$SKARBIEC_BIN" import "$ROWS" >>"$SKARBIEC_LOG" 2>&1        && SKARBIEC_UNLOCK="$UNLOCK" "$SKARBIEC_BIN" export "$SKARBIEC_VIEW" >>"$SKARBIEC_LOG" 2>&1; then
      export WELES_SERVICE_CREDENTIALS_FILE="$SKARBIEC_VIEW"
    fi
  fi
  rm -f "$ROWS"
fi
unset UNLOCK

exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$HOME/weles/scripts/worker/run.mjs"
