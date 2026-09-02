#!/bin/bash
# macOS launchd wrapper for the Weles HTTP API server.
# Runs trajectories synchronously over HTTP; Stado owns queued execution.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
managed_worker_version="${WELES_WORKER_RELEASE_VERSION:-}"
managed_worker_sha256="${WELES_WORKER_RELEASE_SHA256:-}"
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
if [ -n "$managed_worker_version" ] && [ -n "$managed_worker_sha256" ]; then
  export WELES_WORKER_RELEASE_VERSION="$managed_worker_version"
  export WELES_WORKER_RELEASE_SHA256="$managed_worker_sha256"
fi
# Secret acquisition authenticates the workload itself. Set the stable identity
# before the first acquisition rather than only before starting the capability
# broker below.
export SKARBIEC_WORKLOAD_ID="${SKARBIEC_WORKLOAD_ID:-weles-credential-worker-local}"
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
# The fleet Stado config owns the canonical Skarbiec authority. Reading several
# local ports silently selected an obsolete vault when more than one broker was
# present, so Brama and Weles acquired different values for the same item.
STADO_BIN="${STADO_BIN:-$HOME/.stado/bin/stado}"
if [ ! -x "$STADO_BIN" ]; then
  printf 'required Stado binary is unavailable: %s\n' "$STADO_BIN" >&2
  exit 1
fi
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  printf 'required Node runtime is unavailable: %s\n' "$NODE_BIN" >&2
  exit 1
fi
WC_SKARBIEC_URL="$("$STADO_BIN" config show | "$NODE_BIN" -e '
  const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const value = config?.resolved?.agent_skarbiec_url;
  if (typeof value !== "string" || value.length === 0) process.exit(1);
  process.stdout.write(value);
')"
if [ -z "$WC_SKARBIEC_URL" ]; then
  printf 'fleet Stado config has no agent_skarbiec_url\n' >&2
  exit 1
fi
export WC_SKARBIEC_URL
# Resolve the repository from this launcher's immutable release tree. Keeping a
# second build-work copy made the API server and its trajectories lag the
# release that launchd had activated.
WELES_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export WELES_REPO
WELES_ACTION_ALLOWLIST="$("$NODE_BIN" -e '
  const actions = require("node:fs").readFileSync(process.argv[1], "utf8")
    .split(/\r?\n/).map((action) => action.trim()).filter(Boolean);
  if (!actions.length
      || new Set(actions).size !== actions.length
      || actions.some((action) => !/^[a-z_]+$/.test(action))) {
    throw new Error("invalid exact Weles action catalog");
  }
  process.stdout.write(actions.join(","));
' "$WELES_REPO/scripts/worker/deploy/weles-action-allowlist.txt")"
export WELES_ACTION_ALLOWLIST
acquire_startup_field() {
  local consumer="$1" item="$2" field="$3"
  local scopes="$WELES_REPO/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
  local helper="$WELES_REPO/scripts/worker/deploy/skarbiec-acquire.mjs"
  local value
  value="$("$NODE_BIN" "$helper" "$scopes" "$consumer" "$item" "$field")"
  if [ -z "$value" ]; then
    printf '%s\n' "empty Skarbiec field $item/$field through: $WC_SKARBIEC_URL" >&2
    return 1
  fi
  printf '%s' "$value"
}
# The synchronous API and every Stado caller share one Skarbiec-owned bearer.
# Never retain a host-local token from secrets.env as a second authority.
WELES_API_TOKEN="$(acquire_startup_field weles-echo-api-token-bootstrap echo-weles-api token)"
BRAMA_WELES_REAUTH_TOKEN="$(acquire_startup_field weles-brama-reauth-token-bootstrap brama-weles-reauth token)"
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
  WELES_API_TOKEN \
  BRAMA_WELES_REAUTH_TOKEN \
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
export WELES_API_TOKEN BRAMA_WELES_REAUTH_TOKEN WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN
export WELES_STADO_MODEL_ROUTER_AGENT_ID WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
mkdir -p "$HOME/weles/var"
# Set unconditionally: the unit's plist injects this variable, so a default
# expression would never win. This is the alias Brama serves.
export WELES_AGENT_MODEL=best
export STADO_MODEL_ROUTER_URL='http://127.0.0.1:17601'
export STADO_API_URL='http://127.0.0.1:17603'
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
# A unix socket outlives the process that bound it. Every restart of this
# unit used to inherit the previous broker's file: `bind` then answered
# EADDRINUSE, the broker exited, and the file stayed behind pointing at
# nothing - so trajectories reached a path that connect() refused. The
# socket is this launcher's to own, so the launcher clears it.
rm -f "$SKARBIEC_CAP_SOCKET"
"$HOME/.stado/bin/skarbiec" capability-serve --socket "$SKARBIEC_CAP_SOCKET" &
capability_broker_pid=$!
# Starting the API server before the broker accepts is a race the API loses
# once, silently, on the first trajectory that asks for a credential.
broker_ready=no
for _ in $(seq 1 50); do
  if [ -S "$SKARBIEC_CAP_SOCKET" ]; then broker_ready=yes; break; fi
  if ! kill -0 "$capability_broker_pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if [ "$broker_ready" != yes ]; then
  echo "capability broker never bound $SKARBIEC_CAP_SOCKET" >&2
  kill "$capability_broker_pid" 2>/dev/null || true
  exit 1
fi
echo "capability broker listening on $SKARBIEC_CAP_SOCKET"
stop_capability_broker() {
  kill "$capability_broker_pid" || true
}
trap stop_capability_broker EXIT HUP INT TERM
"$NODE_BIN" "$WELES_REPO/scripts/worker/weles-api-server.mjs"
