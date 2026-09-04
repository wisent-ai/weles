#!/bin/bash
# launchd wrapper for the mac-mini Claude reauth runner. Account material comes
# from Skarbiec and model traffic goes through Brama.
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

NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
acquire_helper="$WELES_DIR/scripts/worker/deploy/skarbiec-acquire.mjs"
acquire_scopes="$WELES_DIR/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
WC_SKARBIEC_URL="$("$NODE_BIN" "$WELES_DIR/scripts/_shared/skarbiec-runtime.mjs" endpoint)"
export WC_SKARBIEC_URL
# The gateway resolves the caller's client identity from a bearer and only then
# checks the signed agent trio against it, so the trio alone is refused before the
# signature is read — `401 unauthorized`, which says none of that. The donating
# agent's own router token is what makes the two agree.
if [ -z "${WISENT_APP_MODEL_ROUTER_TOKEN:-}" ]; then
  WISENT_APP_MODEL_ROUTER_TOKEN="$("$NODE_BIN" "$acquire_helper" "$acquire_scopes" \
    weles-wisent-app-router-token-bootstrap wisent-app-model-router token)" || {
    printf '%s\n' "Skarbiec acquisition failed for wisent-app-model-router/token" >/dev/stderr
    false
  }
  export WISENT_APP_MODEL_ROUTER_TOKEN
fi
# The env this launcher assembles is the only place the login helper can run
# with what it needs, so the entry point is overridable: exercising `login.mjs`
# on its own is how its failure gets a reason instead of a stack.
REAUTH_ENTRY="${REAUTH_ENTRY:-$WELES_DIR/scripts/trajectories/claude/reauth.mjs}"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$REAUTH_ENTRY"
