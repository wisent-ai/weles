#!/bin/bash
# macOS launchd wrapper for the Google Ads Keyword Planner API facade.
# The API starts the persistent google_ads keeper on demand when requests arrive.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/.config/weles/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ] || ! bash -n "$WELES_WORKER_ENV_FILE"; then
  printf '%s\n' "missing or invalid Weles worker env file: $WELES_WORKER_ENV_FILE" > /dev/stderr
  false
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
export STADO_RESOLVER_API_URL=http://127.0.0.1:17600
export STADO_SKARBIEC_URI=stado://service/skarbiec
export STADO_BRAMA_URI=stado://service/brama
export WC_SKARBIEC_URL=http://127.0.0.1:17602
export STADO_MODEL_ROUTER_URL=http://127.0.0.1:17601
mkdir -p "$HOME/.local/state/weles" "$HOME/.weles/browser_profiles/google_ads"
# Password, MFA, and proxy material is never sourced from worker.env. The API
# process resolves each exact item later through its owning script and token.
unset GOOGLE_ADS_EMAIL GOOGLE_PASSWORD GOOGLE_TOTP_SECRET GOOGLE_AUTHENTICATOR_SECRET
unset GOOGLE_SSO_MANUAL_TOTP GOOGLE_SSO_MANUAL_TOTP_CODE GOOGLE_TOTP_CODE
unset GOOGLE_SSO_MANUAL_TOTP_FILE GOOGLE_SSO_MANUAL_TOTP_READY_FILE
unset SSO_EMAIL SSO_PASS SSO_PASSWORD SSO_TOTP_SECRET GM_EMAIL GM_PASSWORD GM_TOTP_SECRET
unset OXYLABS_USERNAME OXYLABS_PASSWORD OXYLABS_MOBILE_USERNAME OXYLABS_MOBILE_PASSWORD
unset OXYLABS_ISP_USERNAME OXYLABS_ISP_PASSWORD
unset OXYLABS_DEDICATED_ISP_USERNAME OXYLABS_DEDICATED_ISP_PASSWORD
unset BRIGHTDATA_USERNAME BRIGHTDATA_PASSWORD BRIGHTDATA_ZONE BRIGHTDATA_BROWSER_WS
unset WELES_STADO_OBJECT_API_TOKEN WELES_STADO_MODEL_ROUTER_TOKEN
unset WELES_KEYWORD_PLANNER_API_TOKEN WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH
STADO_BIN="${STADO_BIN:-/usr/local/bin/stado}"
: "${WC_SKARBIEC_URL:?WC_SKARBIEC_URL must be explicitly configured}"
: "${SKARBIEC_WORKLOAD_ID:?SKARBIEC_WORKLOAD_ID must be explicitly configured}"
: "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:?SKARBIEC_WORKLOAD_SIGNING_KEY_FILE must be explicitly configured}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
MODEL_BOOTSTRAP_CONSUMER="weles-keyword-planner-router-bootstrap"
API_BOOTSTRAP_CONSUMER="weles-keyword-planner-api-token-bootstrap"
SCOPE_FILE="$HOME/weles/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
ACQUIRE_HELPER="$HOME/weles/scripts/worker/deploy/skarbiec-acquire.mjs"
if [ ! -x "$STADO_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf '%s\n' "missing Stado or Node for keyword-planner acquisition" > /dev/stderr
  false
fi
if ! WELES_STADO_MODEL_ROUTER_TOKEN="$("$NODE_BIN" "$ACQUIRE_HELPER" \
  "$WC_SKARBIEC_URL" "$SCOPE_FILE" "$MODEL_BOOTSTRAP_CONSUMER" \
  weles-keyword-planner-model-router token)"; then
  printf '%s\n' "one-time keyword-planner model token acquisition failed" > /dev/stderr
  false
fi
if ! WELES_KEYWORD_PLANNER_API_TOKEN="$("$NODE_BIN" "$ACQUIRE_HELPER" \
  "$WC_SKARBIEC_URL" "$SCOPE_FILE" "$API_BOOTSTRAP_CONSUMER" \
  weles-keyword-planner-api token)"; then
  printf '%s\n' "one-time keyword-planner API token acquisition failed" > /dev/stderr
  false
fi
if [ -z "$WELES_STADO_MODEL_ROUTER_TOKEN" ] || [ -z "$WELES_KEYWORD_PLANNER_API_TOKEN" ] \
  || [ "$WELES_STADO_MODEL_ROUTER_TOKEN" = "$WELES_KEYWORD_PLANNER_API_TOKEN" ]; then
  printf '%s\n' "invalid or reused keyword-planner bearer" > /dev/stderr
  false
fi
export WELES_STADO_MODEL_ROUTER_TOKEN WELES_KEYWORD_PLANNER_API_TOKEN
export WELES_SKARBIEC_URL="$WC_SKARBIEC_URL"
export WELES_STADO_BIN="$STADO_BIN"
unset WC_SKARBIEC_CONSUMER WC_SKARBIEC_TOKEN_FILE
if [ -z "${STADO_MODEL_ROUTER_URL:-}" ] || [ -z "${WELES_STADO_MODEL_ROUTER_TOKEN:-}" ] \
  || [ -z "${WELES_KEYWORD_PLANNER_API_TOKEN:-}" ]; then
  printf '%s\n' "missing required keyword-planner Brama or API configuration" > /dev/stderr
  false
fi
export WELES_REPO="$HOME/weles"
export WELES_KEYWORD_PLANNER_API_HOST="${WELES_KEYWORD_PLANNER_API_HOST:-0.0.0.0}"
export WELES_KEYWORD_PLANNER_API_PORT="${WELES_KEYWORD_PLANNER_API_PORT:-8787}"
export GOOGLE_ADS_KEEPER_START="${GOOGLE_ADS_KEEPER_START:-1}"
export GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS="${GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS:-90000}"
export GOOGLE_ADS_KEEPER_USER_DATA_DIR="${GOOGLE_ADS_KEEPER_USER_DATA_DIR:-$HOME/.weles/browser_profiles/google_ads}"
export KEEPER_USER_DATA_DIR="$GOOGLE_ADS_KEEPER_USER_DATA_DIR"
export WELES_USER_DATA_DIR="$GOOGLE_ADS_KEEPER_USER_DATA_DIR"
exec /opt/homebrew/bin/node "$HOME/weles/scripts/trajectories/google/ads/ads_keyword_planner_api_server.mjs"
