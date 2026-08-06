#!/bin/bash
set -e -o pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"

if [ ! -r "$WELES_WORKER_ENV_FILE" ] || ! bash -n "$WELES_WORKER_ENV_FILE"; then
  printf '%s\n' "missing or invalid Weles worker env file: $WELES_WORKER_ENV_FILE" > /dev/stderr
  false
fi
if [ ! -x "$NODE_BIN" ]; then
  printf '%s\n' "missing Node runtime" > /dev/stderr
  false
fi

set -a
. "$WELES_WORKER_ENV_FILE"
set +a

unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_SERVICE_KEY
unset WELES_SUPABASE_URL WELES_SUPABASE_SERVICE_ROLE_KEY
unset NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY
unset WC_SKARBIEC_CONSUMER WC_SKARBIEC_TOKEN_FILE STADO_CONFIG
unset SKARBIEC_VAULT_FILE SKARBIEC_UNLOCK WELES_SERVICE_CREDENTIALS_FILE

if [ -z "${WC_SKARBIEC_URL:-}" ] || [ -z "${SKARBIEC_WORKLOAD_ID:-}" ] \
  || [ -z "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:-}" ]; then
  printf '%s\n' "WC_SKARBIEC_URL and workload identity must be explicitly configured" > /dev/stderr
  false
fi

acquire_startup_field() {
  local consumer="$1"
  local item="$2"
  local field="$3"
  local scope_file="$HOME/weles/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
  local helper="$HOME/weles/scripts/worker/deploy/skarbiec-acquire.mjs"
  local value
  if ! value="$("$NODE_BIN" "$helper" \
    "$WC_SKARBIEC_URL" "$scope_file" "$consumer" "$item" "$field")"; then
    printf '%s\n' "one-time Skarbiec acquisition failed for $consumer/$item/$field" > /dev/stderr
    false
    return $?
  fi
  if [ -z "$value" ]; then
    printf '%s\n' "Skarbiec returned an empty $item/$field value for $consumer" > /dev/stderr
    false
    return $?
  fi
  printf '%s' "$value"
}

WELES_DATABASE_URL="$(acquire_startup_field \
  weles-database-url-bootstrap weles-database url)"
WELES_DATABASE_TOKEN="$(acquire_startup_field \
  weles-database-service-role-bootstrap weles-database service_role_key)"
WELES_ECHO_API_TOKEN="$(acquire_startup_field \
  weles-echo-api-token-bootstrap echo-weles-api token)"

WELES_ACTION_ALLOWLIST_FILE="$HOME/weles/scripts/worker/deploy/weles-action-allowlist.txt"
WELES_ACTION_ALLOWLIST="$("$NODE_BIN" -e '
  const actions = require("node:fs").readFileSync(process.argv.pop(), "utf8")
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!actions.length || new Set(actions).size !== actions.length
      || actions.some((value) => !/^[a-z][a-z\d_]*$/.test(value))) throw new Error("invalid exact action catalog");
  process.stdout.write(actions.join(","));
' "$WELES_ACTION_ALLOWLIST_FILE")"

if ! printf '%s\n%s\n%s\n' "$WELES_DATABASE_URL" "$WELES_ECHO_API_TOKEN" "$WELES_DATABASE_TOKEN" | "$NODE_BIN" -e '
  const values = require("node:fs").readFileSync(Number("0"), "utf8").split("\n");
  const endpoint = new URL(values.at(Number("0")));
  const token = values.at(Number("1")) ?? "";
  const databaseToken = values.at(Number("2")) ?? "";
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(endpoint.hostname);
  if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== "/" && endpoint.pathname !== "")
      || Buffer.byteLength(token) < Number("32")
      || token === databaseToken) process.exitCode = Number("1");
'; then
  printf '%s\n' "invalid Weles database endpoint or Echo API token" > /dev/stderr
  false
fi

export WELES_DATABASE_URL WELES_DATABASE_TOKEN WELES_ECHO_API_TOKEN WELES_ACTION_ALLOWLIST
export WELES_ECHO_API_PORT="${WELES_ECHO_API_PORT:-8794}"
unset WC_SKARBIEC_URL
unset -f acquire_startup_field

exec "$NODE_BIN" "$HOME/weles/dist/api/echo-server.js"
