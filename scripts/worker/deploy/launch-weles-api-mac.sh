#!/bin/bash
# macOS launchd wrapper for the Weles HTTP API server.
# Runs trajectories synchronously over HTTP (shoot-at-server) instead of the
# Supabase enqueue -> poll queue. Reuses the worker's resolveTrajectory/paramsToEnv.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
# base worker runtime (proxy, chromium path, captcha keys, supabase creds)
if [ -f "$HOME/weles/var/worker.env" ]; then
  . "$HOME/weles/var/worker.env"
fi
# content overrides (yqiz project - trading/stock_context persistence)
if [ -f "$HOME/weles/var/worker-content.env" ]; then
  . "$HOME/weles/var/worker-content.env"
fi
# release pins and workload identity owned by the managed worker deployment
if [ -f "$HOME/.config/weles/worker.env" ]; then
  . "$HOME/.config/weles/worker.env"
fi
# runtime secret store (vault) - provides WELES_API_TOKEN
if [ -f "$HOME/.weles/secrets.env" ]; then
  . "$HOME/.weles/secrets.env"
fi
# deployment-local model identity installed through `stado host install-secret`
if [ -f "$HOME/.stado/weles-model.env" ]; then
  . "$HOME/.stado/weles-model.env"
fi
set +a
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
# The vault endpoint is established by reading through it, not by probing a port.
# It was pinned to 8787, which on the always-on host is held by another Node
# service, so every acquisition failed with ECONNREFUSED and the wrapper carried
# on with empty values: `empty Skarbiec field weles-object-api/token` in the log
# from a service presenting itself as configured. A port probe was not enough --
# something answers on 8787 and refuses the protocol -- so each candidate is
# tried with the real read and the first that returns a value wins.
SKARBIEC_ENDPOINTS='http://127.0.0.1:8787 http://127.0.0.1:8895 http://127.0.0.1:19095'
WC_SKARBIEC_URL="${WC_SKARBIEC_URL:-}"
export WELES_REPO="$HOME/weles"
NODE_BIN=/opt/homebrew/bin/node
acquire_startup_field() {
  local consumer="$1" item="$2" field="$3"
  local scopes="$WELES_REPO/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
  local helper="$WELES_REPO/scripts/worker/deploy/skarbiec-acquire.mjs"
  local value endpoint
  for endpoint in ${WC_SKARBIEC_URL:-$SKARBIEC_ENDPOINTS}; do
    value="$("$NODE_BIN" "$helper" "$endpoint" "$scopes" "$consumer" "$item" "$field" 2>/dev/null)" \
      || value=''
    if [ -n "$value" ]; then
      WC_SKARBIEC_URL="$endpoint"
      export WC_SKARBIEC_URL
      printf '%s' "$value"
      return 0
    fi
  done
  printf '%s\n' "empty Skarbiec field $item/$field through: ${WC_SKARBIEC_URL:-$SKARBIEC_ENDPOINTS}" >&2
  return 1
}
if [ -z "${WELES_STADO_OBJECT_API_TOKEN:-}" ]; then
  WELES_STADO_OBJECT_API_TOKEN="$(acquire_startup_field weles-object-token-bootstrap weles-object-api token)"
fi
if [ -z "${WELES_STADO_MODEL_ROUTER_TOKEN:-}" ] \
  || [ -z "${WELES_STADO_MODEL_ROUTER_AGENT_ID:-}" ] \
  || [ -z "${WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET:-}" ]; then
  WELES_STADO_MODEL_ROUTER_TOKEN="$(acquire_startup_field weles-model-router-token-bootstrap weles-model-router token)"
  WELES_STADO_MODEL_ROUTER_AGENT_ID="$(acquire_startup_field weles-model-agent-id-bootstrap weles-model-agent-auth id)"
  WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET="$(acquire_startup_field weles-model-agent-secret-bootstrap weles-model-agent-auth agent_auth_secret)"
fi
# Every trajectory that reads or writes the Weles database needs these two, and
# the reauth trajectories are trajectories: without them `POST /reauth` accepts
# the request, starts the run and dies with
# `FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in env`, which reads like
# a broken provider rather than a service started without its database. The
# scopes for both have existed in skarbiec-acquisition-scopes.conf all along;
# only the acquisition was missing.
if [ -z "${SUPABASE_URL:-}" ]; then
  SUPABASE_URL="$(acquire_startup_field weles-database-url-bootstrap weles-database url)"
fi
if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  SUPABASE_SERVICE_ROLE_KEY="$(acquire_startup_field weles-database-service-role-bootstrap weles-database service_role_key)"
fi
export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
export WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN
export WELES_STADO_MODEL_ROUTER_AGENT_ID WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
mkdir -p "$HOME/weles/var"
export WELES_AGENT_MODEL=weles/agent/primary
export STADO_MODEL_ROUTER_URL='http://127.0.0.1:8080'
export STADO_API_URL='https://lukaszs-macbook-pro-4007-2.tail6443b3.ts.net'
export STADO_API_TOKEN="$WELES_STADO_OBJECT_API_TOKEN"
export SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json"
export SKARBIEC_CAPABILITY_FILE="$HOME/.stado/weles-api-capabilities.json"
export SKARBIEC_CAPABILITY_ROUTES_FILE="$HOME/.stado/weles-api-capability-routes.json"
install -m 600 \
  "$WELES_REPO/scripts/worker/deploy/weles-capability-routes.json" \
  "$SKARBIEC_CAPABILITY_ROUTES_FILE"
export SKARBIEC_CAP_SOCKET="$HOME/.stado/run/weles-api-capability.sock"
export SKARBIEC_WORKLOAD_ID='weles-credential-worker-local'
mkdir -p "$(dirname "$SKARBIEC_CAP_SOCKET")"
export WELES_API_HOST="${WELES_API_HOST:-0.0.0.0}"
export WELES_API_PORT="${WELES_API_PORT:-8788}"
"$HOME/.stado/bin/skarbiec" capability-serve --socket "$SKARBIEC_CAP_SOCKET" &
capability_broker_pid=$!
stop_capability_broker() {
  kill "$capability_broker_pid" || true
}
trap stop_capability_broker EXIT HUP INT TERM
"$NODE_BIN" "$WELES_REPO/scripts/worker/weles-api-server.mjs"
