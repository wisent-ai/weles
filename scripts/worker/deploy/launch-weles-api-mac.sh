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
# The fleet service directory owns the canonical Skarbiec authority. Reading an
# agent-ingress URL here sent a same-host workload out through Caddy and made
# the Weles startup path disagree with every local Stado verifier. Resolve this
# caller's declared endpoint instead; it is the stable release proxy and never
# a scan or fallback to a second vault.
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
WC_SKARBIEC_URL="$("$STADO_BIN" service directory endpoint skarbiec --json | "$NODE_BIN" -e '
  const endpoint = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const value = endpoint?.url;
  if (typeof value !== "string" || value.length === 0) process.exit(1);
  process.stdout.write(value);
')"
if [ -z "$WC_SKARBIEC_URL" ]; then
  printf 'fleet service directory has no Skarbiec endpoint for this host\n' >&2
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
WELES_PUBLIC_API_BEARER="$(acquire_startup_field weles-spis-public-bearer-bootstrap weles-spis-public-admission token)"
WELES_PUBLIC_API_ORGANIZATION_ID="$(acquire_startup_field weles-spis-public-organization-bootstrap weles-spis-public-admission organization_id)"
WELES_RECEIPT_KEY_ID="$(acquire_startup_field weles-spis-receipt-key-id-bootstrap weles-spis-public-admission receipt_key_id)"
WELES_RECEIPT_KEY_SET_VERSION="$(acquire_startup_field weles-spis-receipt-key-set-version-bootstrap weles-spis-public-admission receipt_key_set_version)"
WELES_RECEIPT_PRIVATE_KEY="$(acquire_startup_field weles-spis-receipt-private-key-bootstrap weles-spis-public-admission receipt_private_key)"
WELES_RECEIPT_PUBLIC_KEYS_JSON="$(acquire_startup_field weles-spis-receipt-public-keys-bootstrap weles-spis-public-admission receipt_public_keys_json)"
for required_secret in \
  WELES_API_TOKEN \
  BRAMA_WELES_REAUTH_TOKEN \
  WELES_STADO_OBJECT_API_TOKEN \
  WELES_STADO_MODEL_ROUTER_TOKEN \
  WELES_STADO_MODEL_ROUTER_AGENT_ID \
  WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET \
  WELES_PUBLIC_API_BEARER \
  WELES_PUBLIC_API_ORGANIZATION_ID \
  WELES_RECEIPT_KEY_ID \
  WELES_RECEIPT_KEY_SET_VERSION \
  WELES_RECEIPT_PRIVATE_KEY \
  WELES_RECEIPT_PUBLIC_KEYS_JSON
do
  if [ -z "${!required_secret:-}" ]; then
    printf 'required startup secret %s is unavailable\n' "$required_secret" >&2
    exit 1
  fi
done
export WELES_API_TOKEN BRAMA_WELES_REAUTH_TOKEN WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN
export WELES_STADO_MODEL_ROUTER_AGENT_ID WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
export WELES_PUBLIC_API_BEARER WELES_PUBLIC_API_ORGANIZATION_ID WELES_RECEIPT_KEY_ID
export WELES_RECEIPT_KEY_SET_VERSION WELES_RECEIPT_PRIVATE_KEY WELES_RECEIPT_PUBLIC_KEYS_JSON
export WELES_PUBLIC_API_ALLOWED_ORIGINS='*'
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
# The API port is the only thing that says which instance is the live one.
# Clearing the socket below is safe only for the instance that owns the
# port: a restart that cleared it first took the path from the instance
# still serving, its own API server then failed EADDRINUSE, and the trap
# further down killed the broker it had just installed - leaving the live
# server pointed at a socket with nothing behind it. Every trajectory that
# asked for a credential from then on read ECONNREFUSED, reported as
# `broker transport failure`, and no restart could repair it because each
# retry repeated the theft. So the port is claimed before anything shared
# is touched, and a losing instance stands by having changed nothing.
lsof_bin=lsof
[ -x /usr/sbin/lsof ] && lsof_bin=/usr/sbin/lsof
if "$lsof_bin" -nP -iTCP:"$WELES_API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "weles api port $WELES_API_PORT is already served: standing by, $SKARBIEC_CAP_SOCKET untouched" >&2
  sleep 30
  exit 0
fi
# A unix socket outlives the process that bound it. Every restart of this
# unit used to inherit the previous broker's file: `bind` then answered
# EADDRINUSE, the broker exited, and the file stayed behind pointing at
# nothing - so trajectories reached a path that connect() refused. The
# socket is this launcher's to own, so the launcher clears it.
rm -f "$SKARBIEC_CAP_SOCKET"
"${SKARBIEC_BIN:-$HOME/.stado/bin/skarbiec}" capability-serve --socket "$SKARBIEC_CAP_SOCKET" &
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
"$NODE_BIN" "$WELES_REPO/scripts/worker/weles-api-server.mjs" &
api_server_pid=$!

# launchd replaces this job with `launchctl kickstart -k`, which signals the job
# and immediately starts its successor. The API server used to be an
# unsupervised child of this script, so the job's own process was this shell
# while the listening socket belonged to the server: the signal ended the shell,
# the server was orphaned still holding the API port, and the successor found it
# taken. That is the `listen EADDRINUSE 0.0.0.0:8788` the unit log filled with,
# and why 0.5.57, 0.5.59 and 0.5.60 each timed out readiness against a port
# their predecessor still owned. Shutting down therefore means ending BOTH
# children and waiting for them, so the port and the broker socket are released
# before the successor tries to claim them.
shutdown_children() {
  trap - EXIT HUP INT TERM
  kill "$api_server_pid" "$capability_broker_pid" 2>/dev/null || true
  wait "$api_server_pid" 2>/dev/null || true
  wait "$capability_broker_pid" 2>/dev/null || true
}
trap shutdown_children EXIT HUP INT TERM

wait "$api_server_pid"
api_server_status=$?
shutdown_children
exit "$api_server_status"
