#!/bin/bash
# launchd wrapper for the Kimi reauth runner.
# Source the deployment env then exec node reauth.mjs. PATH includes
# ~/.kimi-code/bin because the native Kimi Code install lives there on macOS.
export PATH="$HOME/.kimi-code/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_DIR="${WELES_DIR:-$HOME/weles}"
# The env file moved to the operator's config directory, and sourcing only the
# in-tree copy meant this job died on line 9 every tick with "No such file or
# directory" -- before it could look at the subscription it exists to refresh.
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ] && [ -r "$WELES_DIR/var/worker.env" ]; then
  WELES_WORKER_ENV_FILE="$WELES_DIR/var/worker.env"
fi
if [ ! -r "$WELES_WORKER_ENV_FILE" ]; then
  printf '%s\n' "no readable deployment env file: $WELES_WORKER_ENV_FILE" >/dev/stderr
  exit 1
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

NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
acquire_helper="$WELES_DIR/scripts/worker/deploy/skarbiec-acquire.mjs"
acquire_scopes="$WELES_DIR/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
acquire_url="${WC_SKARBIEC_URL:-${WELES_CREDENTIAL_SKARBIEC_URL:-}}"

# The gateway reads the client identity from a bearer before it looks at the
# signed agent trio, so the trio alone is refused with a bare 401.
if [ -z "${WISENT_APP_MODEL_ROUTER_TOKEN:-}" ]; then
  WISENT_APP_MODEL_ROUTER_TOKEN="$("$NODE_BIN" "$acquire_helper" "$acquire_scopes" \
    weles-wisent-app-router-token-bootstrap wisent-app-model-router token)" || {
    printf '%s\n' "Skarbiec acquisition failed for wisent-app-model-router/token" >/dev/stderr
    exit 1
  }
  export WISENT_APP_MODEL_ROUTER_TOKEN
fi

REAUTH_ENTRY="${REAUTH_ENTRY:-$WELES_DIR/scripts/trajectories/kimi/reauth.mjs}"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$REAUTH_ENTRY"
