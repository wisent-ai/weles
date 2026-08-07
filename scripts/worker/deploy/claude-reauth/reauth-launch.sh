#!/bin/bash
# launchd wrapper for the mac-mini claude reauth runner. Mirrors
# scripts/worker/deploy/launch-mac.sh: source worker.env (SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, CHROMIUM_PATH, proxy creds the trajectory
# may read) then exec node reauth.mjs. PATH must include
# /opt/homebrew/bin so reauth.mjs can spawn the login.mjs child node.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_DIR="${WELES_DIR:-$HOME/weles}"
# The deployment env lives where the deployer keeps it, not inside the release:
# `~/weles` is a symlink into an immutable archive that has no `var/`, so reading
# `$WELES_DIR/var/worker.env` fails on every host deployed that way — silently,
# because launchd records the exit somewhere nobody reads. The older layout is
# still honoured for a host that kept its env beside a checkout.
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ] && [ -r "$WELES_DIR/var/worker.env" ]; then
  WELES_WORKER_ENV_FILE="$WELES_DIR/var/worker.env"
fi
if [ ! -r "$WELES_WORKER_ENV_FILE" ]; then
  printf '%s\n' "no readable deployment env file: $WELES_WORKER_ENV_FILE" >/dev/stderr
  false
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
# An immutable release directory is read-only by design, so state goes where the
# deployer already keeps its own.
WELES_STATE_DIR="${WELES_STATE_DIR:-$HOME/.local/state/weles}"
export WELES_STATE_DIR
mkdir -p "$WELES_STATE_DIR"

# The trajectory reads the Weles database through SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY, and the deployment env deliberately holds neither: a
# service-role key on disk is what the acquisition client exists to avoid. The
# main launcher acquires the same two values from the same scoped consumers, so
# this does too rather than asking an operator to paste them somewhere.
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
acquire_helper="$WELES_DIR/scripts/worker/deploy/skarbiec-acquire.mjs"
acquire_scopes="$WELES_DIR/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
acquire_url="${WC_SKARBIEC_URL:-${WELES_CREDENTIAL_SKARBIEC_URL:-}}"
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  if [ ! -f "$acquire_helper" ] || [ -z "$acquire_url" ]; then
    printf '%s\n' "no Skarbiec acquisition client or URL, so the Weles database cannot be reached" >/dev/stderr
    false
  fi
  SUPABASE_URL="$("$NODE_BIN" "$acquire_helper" "$acquire_url" "$acquire_scopes" \
    weles-database-url-bootstrap weles-database url)" || {
    printf '%s\n' "Skarbiec acquisition failed for weles-database/url" >/dev/stderr
    false
  }
  SUPABASE_SERVICE_ROLE_KEY="$("$NODE_BIN" "$acquire_helper" "$acquire_url" "$acquire_scopes" \
    weles-database-service-role-bootstrap weles-database service_role_key)" || {
    printf '%s\n' "Skarbiec acquisition failed for weles-database/service_role_key" >/dev/stderr
    false
  }
  export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
fi

# The gateway resolves the caller's client identity from a bearer and only then
# checks the signed agent trio against it, so the trio alone is refused before the
# signature is read — `401 unauthorized`, which says none of that. The donating
# agent's own router token is what makes the two agree.
if [ -z "${WISENT_APP_MODEL_ROUTER_TOKEN:-}" ]; then
  WISENT_APP_MODEL_ROUTER_TOKEN="$("$NODE_BIN" "$acquire_helper" "$acquire_url" "$acquire_scopes" \
    weles-wisent-app-router-token-bootstrap wisent-app-model-router token)" || {
    printf '%s\n' "Skarbiec acquisition failed for wisent-app-model-router/token" >/dev/stderr
    false
  }
  export WISENT_APP_MODEL_ROUTER_TOKEN
fi
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node \
  "$WELES_DIR/scripts/trajectories/claude/reauth.mjs"
