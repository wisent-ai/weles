#!/bin/bash
# macOS launchd wrapper for the Weles HTTP API server.
# Runs trajectories synchronously over HTTP; Stado owns queued execution.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
# base worker runtime (proxy and browser configuration)
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
# Secret acquisition authenticates the workload itself. Set the stable identity
# before the first acquisition rather than only before starting the capability
# broker below.
export SKARBIEC_WORKLOAD_ID="${SKARBIEC_WORKLOAD_ID:-weles-credential-worker-local}"
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
for required_secret in \
  WELES_STADO_OBJECT_API_TOKEN \
  WELES_STADO_MODEL_ROUTER_TOKEN \
  WELES_STADO_MODEL_ROUTER_AGENT_ID \
  WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
do
  if [ -z "${!required_secret:-}" ]; then
    printf 'required startup secret %s is unavailable\n' "$required_secret" >&2
    exit 1
  fi
done
export WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN
export WELES_STADO_MODEL_ROUTER_AGENT_ID WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
mkdir -p "$HOME/weles/var"
# Set unconditionally: the unit's plist injects this variable, so a default
# expression would never win. This is the alias Brama serves.
export WELES_AGENT_MODEL=best
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
