#!/bin/bash
set -e -o pipefail
# Mac launchd wrapper: sources nonsecret deployment configuration, reads each
# secret through its dedicated Skarbiec consumer grant, then execs the worker.
# No owner vault, authoring-store credential, or plaintext projection is built.
# PATH must include /opt/homebrew/bin so worker-spawned trajectories can use bare `node`.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# Required by the patched Firefox Playwright/Juggler path on macOS; mirrors
# .github/workflows/firefox-integration.yml.
export MOZ_DISABLE_CONTENT_SANDBOX="${MOZ_DISABLE_CONTENT_SANDBOX:-1}"
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ]; then
  echo "missing readable Weles worker env file: $WELES_WORKER_ENV_FILE" >&2
  exit 1
fi
# Reject a syntactically broken env file up front. Sourcing `set -a`-style
# aborts mid-file on an unquoted value (e.g. a regex with `(` or `|`), which
# would export only the vars before the bad line and silently start the worker
# with a half-loaded env — the exact cause of a content worker claiming jobs
# outside its deployment policy. Fail loud instead.
if ! bash -n "$WELES_WORKER_ENV_FILE" 2>/dev/null; then
  echo "Weles worker env file has a syntax error (quote values with regex/special chars): $WELES_WORKER_ENV_FILE" >&2
  exit 1
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
# Workloads name logical services. Compatibility URLs terminate at the local
# Stado resolver and are never direct Skarbiec, Brama, or coordinator endpoints.
export STADO_RESOLVER_API_URL=http://127.0.0.1:17600
export STADO_SKARBIEC_URI=stado://service/skarbiec
export STADO_BRAMA_URI=stado://service/brama
export STADO_OBJECT_API_URI=stado://service/stado-object-api
export WC_SKARBIEC_URL=http://127.0.0.1:17602
export WELES_CREDENTIAL_SKARBIEC_URL=http://127.0.0.1:17602
export STADO_MODEL_ROUTER_URL=http://127.0.0.1:17601
export STADO_API_URL=http://127.0.0.1:17603
mkdir -p "${WELES_STATE_DIR:-$HOME/.local/state/weles}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  printf '%s\n' "missing executable Node runtime: $NODE_BIN" > /dev/stderr
  false
fi
WELES_ACTION_ALLOWLIST_FILE="$HOME/weles/scripts/worker/deploy/weles-action-allowlist.txt"
unset WELES_ACTION_ALLOWLIST
if ! WELES_ACTION_ALLOWLIST="$("$NODE_BIN" -e '
  const actions = require("node:fs").readFileSync(process.argv.pop(), "utf8")
    .split(/\r?\n/).map((action) => action.trim()).filter(Boolean);
  if (!actions.length
      || new Set(actions).size !== actions.length
      || actions.some((action) => !/^[a-z_]+$/.test(action))) {
    throw new Error("invalid exact action catalog");
  }
  process.stdout.write(actions.join(","));
' "$WELES_ACTION_ALLOWLIST_FILE")"; then
  printf '%s\n' "missing or invalid exact Weles action allowlist: $WELES_ACTION_ALLOWLIST_FILE" > /dev/stderr
  false
fi
export WELES_ACTION_ALLOWLIST
if [ -z "${WC_SKARBIEC_URL:-}" ] || [ -z "${WELES_CREDENTIAL_SKARBIEC_URL:-}" ] \
  || [ -z "${SKARBIEC_WORKLOAD_ID:-}" ] \
  || [ -z "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:-}" ]; then
  printf '%s\n' "startup and credential Skarbiec endpoints plus workload identity must be explicitly configured" > /dev/stderr
  false
fi
if ! "$NODE_BIN" -e '
  for (const raw of process.argv.slice(Number("1"))) {
    const endpoint = new URL(raw);
    const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1"
      || endpoint.hostname === "::1" || endpoint.hostname === "[::1]";
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))) {
      process.exitCode = Number("1");
    }
  }
' "$WC_SKARBIEC_URL" "$WELES_CREDENTIAL_SKARBIEC_URL"; then
  printf '%s\n' "WC_SKARBIEC_URL must use HTTPS, except for loopback HTTP, and contain no credentials, query, or fragment" > /dev/stderr
  false
fi
export WELES_SKARBIEC_URL="$WELES_CREDENTIAL_SKARBIEC_URL"
export SKARBIEC_WELES_READER_ACQUIRE_COMMAND="$HOME/weles/scripts/worker/deploy/skarbiec-acquire.mjs"
export SKARBIEC_WELES_ACQUISITION_SCOPES_FILE="$HOME/weles/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
export SKARBIEC_WELES_WRITER_COMMAND="$HOME/weles/scripts/worker/deploy/skarbiec-write.mjs"
unset GOOGLE_ADS_EMAIL GOOGLE_PASSWORD GOOGLE_TOTP_SECRET GOOGLE_AUTHENTICATOR_SECRET
unset GOOGLE_SSO_MANUAL_TOTP GOOGLE_SSO_MANUAL_TOTP_CODE GOOGLE_TOTP_CODE
unset GOOGLE_SSO_MANUAL_TOTP_FILE GOOGLE_SSO_MANUAL_TOTP_READY_FILE
unset SSO_EMAIL SSO_PASS SSO_PASSWORD SSO_TOTP_SECRET GM_EMAIL GM_PASSWORD GM_TOTP_SECRET
unset OXYLABS_USERNAME OXYLABS_PASSWORD OXYLABS_MOBILE_USERNAME OXYLABS_MOBILE_PASSWORD
unset OXYLABS_ISP_USERNAME OXYLABS_ISP_PASSWORD
unset OXYLABS_DEDICATED_ISP_USERNAME OXYLABS_DEDICATED_ISP_PASSWORD
unset BRIGHTDATA_USERNAME BRIGHTDATA_PASSWORD BRIGHTDATA_ZONE BRIGHTDATA_BROWSER_WS

# Never inherit a broad owner grant, generic database authority, or a stale
# product credential. Each long-lived file below is request-only and bound to
# one consumer/item/field tuple; the returned bearer is used immediately once.
unset CHROMIUM_PATH FIREFOX_PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH
unset WELES_USE_STOCK_CHROMIUM WELES_ALLOW_PLAYWRIGHT_FIREFOX GH_TOKEN GITHUB_TOKEN
unset WC_SKARBIEC_CONSUMER WC_SKARBIEC_TOKEN_FILE STADO_CONFIG
unset SKARBIEC_VAULT_FILE SKARBIEC_UNLOCK WELES_SERVICE_CREDENTIALS_FILE
unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_SERVICE_KEY
unset NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY
unset WELES_SUPABASE_URL WELES_SUPABASE_SERVICE_ROLE_KEY
unset WELES_OPERATOR_CDP_URL WELES_OPERATOR_CDP_TOKEN
unset WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN WELES_STADO_MEDIA_ROUTER_TOKEN
unset WELES_STADO_MODEL_ROUTER_AGENT_ID WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
unset STADO_MODEL_ROUTER_TOKEN WISENT_APP_AGENT_ID WISENT_APP_AGENT_AUTH_SECRET
unset WELES_ARTIFACT_DELIVERY_TOKEN WELES_ARTIFACT_SIGNING_SECRET
unset OKO_WELES_SUBSCRIPTIONS_TOKEN CONTENT_DIAGNOSTICS_API_TOKEN
unset TRADING_TOOLS_INGEST_TOKEN TRADING_TOOLS_INGEST_HMAC_SECRET
unset CONTENT_PLATFORM_SUPABASE_URL CONTENT_PLATFORM_SUPABASE_SERVICE_ROLE_KEY
# Semantic Scholar keys are resolved through Skarbiec, not inherited as
# process-wide environment variables. Clear legacy aliases after worker.env
# sourcing so stale launchd or sourced values cannot reach the Node worker.
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY

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
WELES_STADO_OBJECT_API_TOKEN="$(acquire_startup_field \
  weles-object-token-bootstrap weles-object-api token)"
WELES_STADO_MODEL_ROUTER_TOKEN="$(acquire_startup_field \
  weles-model-router-token-bootstrap weles-model-router token)"
WELES_STADO_MODEL_ROUTER_AGENT_ID="$(acquire_startup_field \
  weles-model-agent-id-bootstrap weles-model-agent-auth id)"
WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET="$(acquire_startup_field \
  weles-model-agent-secret-bootstrap weles-model-agent-auth agent_auth_secret)"
WELES_ARTIFACT_DELIVERY_TOKEN="$(acquire_startup_field \
  weles-artifact-delivery-token-bootstrap weles-artifact-delivery token)"
WELES_ARTIFACT_SIGNING_SECRET="$(acquire_startup_field \
  weles-artifact-signing-secret-bootstrap weles-artifact-signing signing_secret)"
OKO_WELES_SUBSCRIPTIONS_TOKEN="$(acquire_startup_field \
  weles-subscriptions-token-bootstrap oko-weles-subscriptions token)"
CONTENT_DIAGNOSTICS_API_TOKEN="$(acquire_startup_field \
  weles-content-diagnostics-token-bootstrap weles-content-diagnostics token)"
TRADING_TOOLS_INGEST_TOKEN="$(acquire_startup_field \
  weles-trading-ingest-token-bootstrap weles-trading-tools-ingest token)"
TRADING_TOOLS_INGEST_HMAC_SECRET="$(acquire_startup_field \
  weles-trading-ingest-hmac-bootstrap weles-trading-tools-ingest hmac_secret)"
WELES_OPERATOR_CDP_URL="$(acquire_startup_field \
  weles-operator-cdp-url-bootstrap weles-operator-cdp url)"
WELES_OPERATOR_CDP_TOKEN="$(acquire_startup_field \
  weles-operator-cdp-token-bootstrap weles-operator-cdp token)"
if [ "${WELES_CREDENTIAL_FIXED_PROXY:-0}" = "1" ]; then
  case "${WELES_CREDENTIAL_FIXED_PROXY_PROVIDER:-decodo}" in
    decodo)
      WELES_FIXED_PROXY_HOST="$(acquire_startup_field \
        weles-decodo-isp-proxy-client-host weles-decodo-isp-proxy host)"
      WELES_FIXED_PROXY_PORTS="$(acquire_startup_field \
        weles-decodo-isp-proxy-client-ports weles-decodo-isp-proxy ports)"
      WELES_FIXED_PROXY_USERNAME="$(acquire_startup_field \
        weles-decodo-isp-proxy-client-username weles-decodo-isp-proxy username)"
      WELES_FIXED_PROXY_PASSWORD="$(acquire_startup_field \
        weles-decodo-isp-proxy-client-password weles-decodo-isp-proxy password)"
      ;;
    oxylabs-dedicated)
      WELES_FIXED_PROXY_HOST="$(acquire_startup_field \
        weles-oxylabs-dedicated-isp-proxy-client-host weles-oxylabs-dedicated-isp-proxy host)"
      WELES_FIXED_PROXY_PORTS="$(acquire_startup_field \
        weles-oxylabs-dedicated-isp-proxy-client-ports weles-oxylabs-dedicated-isp-proxy ports)"
      WELES_FIXED_PROXY_USERNAME="$(acquire_startup_field \
        weles-oxylabs-dedicated-isp-proxy-client-username weles-oxylabs-dedicated-isp-proxy username)"
      WELES_FIXED_PROXY_PASSWORD="$(acquire_startup_field \
        weles-oxylabs-dedicated-isp-proxy-client-password weles-oxylabs-dedicated-isp-proxy password)"
      ;;
    *)
      printf '%s\n' "unsupported WELES_CREDENTIAL_FIXED_PROXY_PROVIDER" > /dev/stderr
      false
      ;;
  esac
  PROXY_URL="$(
    printf '%s\n%s\n%s\n%s\n' \
      "$WELES_FIXED_PROXY_HOST" "$WELES_FIXED_PROXY_PORTS" \
      "$WELES_FIXED_PROXY_USERNAME" "$WELES_FIXED_PROXY_PASSWORD" \
      | "$NODE_BIN" -e '
        const [host, ports, username, password] =
          require("node:fs").readFileSync(Number("0"), "utf8").split("\n");
        const port = ports.split(",").at(Number("0"))?.trim() ?? "";
        if (!host || !/^\d+$/.test(port) || !username || !password) process.exit(Number("1"));
        const proxy = new URL(`http://${host}:${port}`);
        proxy.username = username;
        proxy.password = password;
        process.stdout.write(proxy.href);
      '
  )"
  export PROXY_URL
  unset WELES_FIXED_PROXY_HOST WELES_FIXED_PROXY_PORTS
  unset WELES_FIXED_PROXY_USERNAME WELES_FIXED_PROXY_PASSWORD
fi
if ! "$NODE_BIN" -e '
  const parsed = new URL(process.argv.pop());
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(parsed.hostname);
  const secure = parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback);
  if (!secure || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    process.exitCode = Number("1");
  }
' "$WELES_DATABASE_URL"; then
  printf '%s\n' "WELES_DATABASE_URL must be an HTTPS origin, except for loopback HTTP, without credentials, path, query, or fragment" > /dev/stderr
  false
fi
if ! printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$WELES_OPERATOR_CDP_URL" "$WELES_OPERATOR_CDP_TOKEN" \
  "$WELES_STADO_MODEL_ROUTER_TOKEN" "$WELES_STADO_MODEL_ROUTER_AGENT_ID" \
  "$WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET" \
  "$WELES_STADO_OBJECT_API_TOKEN" "$WELES_ARTIFACT_DELIVERY_TOKEN" \
  | "$NODE_BIN" -e '
    const [rawEndpoint, token, routerToken, agentId, agentSecret, ...siblings] =
      require("node:fs").readFileSync(Number("0"), "utf8").split("\n");
    let endpoint;
    try {
      endpoint = new URL(rawEndpoint);
    } catch {
      process.exit(Number("1"));
    }
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(endpoint.hostname);
    const secure = endpoint.protocol === "https:" || endpoint.protocol === "wss:";
    const authenticatedLoopback = loopback && (endpoint.protocol === "http:" || endpoint.protocol === "ws:");
    if ((!secure && !authenticatedLoopback)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || Buffer.byteLength(token) < Number("32")
        || Buffer.byteLength(routerToken) < Number("32")
        || agentId !== "weles"
        || Buffer.byteLength(agentSecret) < Number("32")
        || [routerToken, agentSecret].some((value) => value.trim() !== value || /\s/.test(value))
        || routerToken === agentSecret
        || siblings.some((sibling) => sibling
          && (sibling === token || sibling === routerToken || sibling === agentSecret))) {
      process.exitCode = Number("1");
    }
  '; then
  printf '%s\n' "invalid scoped operator or Brama credentials: require secure endpoints, distinct 32-byte tokens and agent secret, and exact Weles agent identity" > /dev/stderr
  false
fi
export WELES_DATABASE_URL WELES_DATABASE_TOKEN
export WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN
export WELES_STADO_MODEL_ROUTER_AGENT_ID WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET
export WELES_ARTIFACT_DELIVERY_TOKEN WELES_ARTIFACT_SIGNING_SECRET
export OKO_WELES_SUBSCRIPTIONS_TOKEN CONTENT_DIAGNOSTICS_API_TOKEN
export TRADING_TOOLS_INGEST_TOKEN TRADING_TOOLS_INGEST_HMAC_SECRET
export WELES_OPERATOR_CDP_URL WELES_OPERATOR_CDP_TOKEN

unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY
unset VERTEX_API_KEY GOOGLE_APPLICATION_CREDENTIALS WELES_GEMINI_MODEL
unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_SERVICE_KEY
unset NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY
unset CONTENT_PLATFORM_SUPABASE_URL CONTENT_PLATFORM_SUPABASE_SERVICE_ROLE_KEY
unset WC_SKARBIEC_URL
unset -f acquire_startup_field
if [ -z "${WELES_DATABASE_URL:-}" ] || [ -z "${WELES_DATABASE_TOKEN:-}" ] \
  || [ -z "${STADO_API_URL:-}" ] || [ -z "${WELES_STADO_OBJECT_API_TOKEN:-}" ] \
  || [ -z "${STADO_MODEL_ROUTER_URL:-}" ] || [ -z "${WELES_STADO_MODEL_ROUTER_TOKEN:-}" ] \
  || [ -z "${WELES_STADO_MODEL_ROUTER_AGENT_ID:-}" ] \
  || [ -z "${WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET:-}" ] \
  || [ -z "${WELES_ARTIFACT_DELIVERY_HOST:-}" ] || [ -z "${WELES_ARTIFACT_DELIVERY_PORT:-}" ] \
  || [ -z "${WELES_ARTIFACT_DELIVERY_URL:-}" ] \
  || [ -z "${WELES_ARTIFACT_DELIVERY_TOKEN:-}" ] || [ -z "${WELES_ARTIFACT_SIGNING_SECRET:-}" ] \
  || [ -z "${WELES_OPERATOR_CDP_URL:-}" ] || [ -z "${WELES_OPERATOR_CDP_TOKEN:-}" ] \
  || [ -z "${STADO_RELEASE_API_URL:-}" ] \
  || [ -z "${WELES_WORKER_RELEASE_VERSION:-}" ] || [ -z "${WELES_WORKER_RELEASE_SHA256:-}" ] \
  || [ -z "${WELES_CHROMIUM_RELEASE_VERSION:-}" ] || [ -z "${WELES_CHROMIUM_RELEASE_SHA256:-}" ] \
  || [ -z "${WELES_FIREFOX_RELEASE_VERSION:-}" ] || [ -z "${WELES_FIREFOX_RELEASE_SHA256:-}" ] \
  || [ -z "${WELES_ACTION_ALLOWLIST:-}" ] \
  || [ -z "${OKO_WELES_SUBSCRIPTIONS_TOKEN:-}" ] \
  || [ -z "${CONTENT_DIAGNOSTICS_API_URL:-}" ] || [ -z "${CONTENT_DIAGNOSTICS_API_TOKEN:-}" ] \
  || [ -z "${TRADING_TOOLS_INGEST_URL:-}" ] || [ -z "${TRADING_TOOLS_INGEST_TOKEN:-}" ] \
  || [ -z "${TRADING_TOOLS_INGEST_HMAC_SECRET:-}" ]; then
  printf '%s\n' "missing required exact action catalog or scoped Weles database, router, object, artifact, operator CDP, subscription, diagnostics, or Trading Tools configuration" > /dev/stderr
  false
fi
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)  WELES_RELEASE_PLATFORM="darwin-arm64" ;;
  Darwin/x86_64) WELES_RELEASE_PLATFORM="darwin-amd64" ;;
  Linux/x86_64)  WELES_RELEASE_PLATFORM="linux-amd64" ;;
  *) printf '%s\n' "unsupported Weles release platform" > /dev/stderr; false ;;
esac
HEX_PAIR_PATTERN='[[:xdigit:]][[:xdigit:]]'
HEX_QUAD_PATTERN="$HEX_PAIR_PATTERN$HEX_PAIR_PATTERN"
HEX_OCTET_PATTERN="$HEX_QUAD_PATTERN$HEX_QUAD_PATTERN"
HEX_BLOCK_PATTERN="$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN$HEX_OCTET_PATTERN"
HEX_SHA256_PATTERN="$HEX_BLOCK_PATTERN$HEX_BLOCK_PATTERN"
if [[ ! "$WELES_WORKER_RELEASE_SHA256" =~ ^${HEX_SHA256_PATTERN}$ ]]; then
  printf '%s\n' "WELES_WORKER_RELEASE_SHA256 must be one complete hexadecimal SHA-256 digest" > /dev/stderr
  false
fi
WELES_WORKER_SHA256="$(printf '%s' "$WELES_WORKER_RELEASE_SHA256" | tr '[:upper:]' '[:lower:]')"
WELES_WORKER_URI="stado://releases/weles-worker/$WELES_WORKER_RELEASE_VERSION/$WELES_RELEASE_PLATFORM/weles-worker.tar.gz"
WELES_WORKER_RECEIPT="release_uri=$WELES_WORKER_URI
archive_sha256=$WELES_WORKER_SHA256
platform=$WELES_RELEASE_PLATFORM"
if [ ! -L "$HOME/weles" ] || [ ! -f "$HOME/weles/.weles-release" ] \
  || [ "$(cat "$HOME/weles/.weles-release")" != "$WELES_WORKER_RECEIPT" ]; then
  printf '%s\n' "active Weles worker is not the configured verified Stado release" > /dev/stderr
  false
fi
if ! bash "$HOME/weles/scripts/chromium/download.sh" > /dev/null; then
  printf '%s\n' "configured Weles Chromium release is missing or failed checksum verification" > /dev/stderr
  false
fi
if ! bash "$HOME/weles/scripts/firefox/download.sh" > /dev/null; then
  printf '%s\n' "configured Weles Firefox release is missing or failed checksum verification" > /dev/stderr
  false
fi


cd "$HOME/weles"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$HOME/weles/scripts/worker/run.mjs"
