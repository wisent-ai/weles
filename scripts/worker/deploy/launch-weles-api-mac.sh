#!/bin/bash
# macOS launchd wrapper for the Weles HTTP API server.
# Runs trajectories synchronously over HTTP (shoot-at-server) instead of the
# Supabase enqueue -> poll queue. Reuses the worker's resolveTrajectory/paramsToEnv.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
# release pins and workload identity owned by the managed worker deployment
if [ -f "$HOME/.config/weles/worker.env" ]; then
  . "$HOME/.config/weles/worker.env"
fi
# base worker runtime (proxy, chromium path, captcha keys, supabase creds)
if [ -f "$HOME/weles/var/worker.env" ]; then
  . "$HOME/weles/var/worker.env"
fi
# content overrides (yqiz project - trading/stock_context persistence)
if [ -f "$HOME/weles/var/worker-content.env" ]; then
  . "$HOME/weles/var/worker-content.env"
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
export WC_SKARBIEC_URL='http://127.0.0.1:8787'
export WELES_REPO="$HOME/.stado/build-work/weles-api-managed"
NODE_BIN=/opt/homebrew/bin/node
acquire_startup_field() {
  local consumer="$1" item="$2" field="$3"
  local scopes="$WELES_REPO/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
  local helper="$WELES_REPO/scripts/worker/deploy/skarbiec-acquire.mjs"
  local value
  value="$("$NODE_BIN" "$helper" "$WC_SKARBIEC_URL" "$scopes" "$consumer" "$item" "$field")"
  [ -n "$value" ] || { printf '%s\n' "empty Skarbiec field $item/$field" >&2; return 1; }
  printf '%s' "$value"
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
export WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN
export WELES_STADO_MODEL_ROUTER_AGENT_ID WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
mkdir -p "$HOME/weles/var"
export WELES_AGENT_MODEL=weles/agent/primary
export STADO_MODEL_ROUTER_URL='http://127.0.0.1:8080'
export STADO_API_URL='https://lukaszs-macbook-pro-4007-2.tail6443b3.ts.net'
export STADO_API_TOKEN="$WELES_STADO_OBJECT_API_TOKEN"
export SKARBIEC_VAULT_FILE="$HOME/.stado/weles-skarbiec.vault.json"
export SKARBIEC_CAPABILITY_FILE="$HOME/.stado/weles-api-capabilities.json"
export SKARBIEC_CAPABILITY_ROUTES_FILE="$HOME/.stado/weles-api-capability-routes.json"
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
