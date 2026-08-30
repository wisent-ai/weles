#!/bin/sh
set -eu

archive="$HOME/.stado/files/weles-figma-acquisition.tar.gz"
runtime="$HOME/.stado/weles-figma-acquisition"
worker_env="$HOME/.config/weles/worker.env"

[ -f "$archive" ] || { printf '%s\n' 'missing Weles Figma acquisition archive' >&2; exit 1; }
[ -r "$worker_env" ] || { printf '%s\n' 'missing Weles worker environment' >&2; exit 1; }
[ -d "$HOME/weles/node_modules" ] || { printf '%s\n' 'missing Weles node_modules' >&2; exit 1; }

mkdir -p "$runtime"
tar -xzf "$archive" -C "$runtime"
if [ ! -e "$runtime/node_modules" ]; then
  ln -s "$HOME/weles/node_modules" "$runtime/node_modules"
fi

set -a
. "$worker_env"
set +a
export WC_SKARBIEC_URL="${WC_SKARBIEC_URL:-http://127.0.0.1:17602}"
export WELES_CREDENTIAL_SKARBIEC_URL="${WELES_CREDENTIAL_SKARBIEC_URL:-$WC_SKARBIEC_URL}"
export WELES_SKARBIEC_URL="$WELES_CREDENTIAL_SKARBIEC_URL"
export SKARBIEC_WELES_READER_ACQUIRE_COMMAND="$runtime/scripts/worker/deploy/skarbiec-acquire.mjs"
export SKARBIEC_WELES_ACQUISITION_SCOPES_FILE="$runtime/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
export SKARBIEC_WELES_WRITER_COMMAND="$runtime/scripts/worker/deploy/skarbiec-write.mjs"
export FIGMA_ACCOUNT_EMAIL="${FIGMA_ACCOUNT_EMAIL:-lukasz.bartoszcze@gmail.com}"
export HEADLESS="${HEADLESS:-1}"
export WELES_USER_DATA_DIR="$HOME/.local/state/weles/browser-profiles/figma-token"

acquire_startup_field() {
  consumer="$1"
  item="$2"
  field="$3"
  /opt/homebrew/bin/node "$runtime/scripts/worker/deploy/skarbiec-acquire.mjs" \
    "$runtime/scripts/worker/deploy/skarbiec-acquisition-scopes.conf" \
    "$consumer" "$item" "$field"
}

export STADO_MODEL_ROUTER_URL="http://127.0.0.1:8080"
WELES_STADO_MODEL_ROUTER_TOKEN="$(acquire_startup_field \
  weles-model-router-token-bootstrap weles-model-router token)"
WELES_STADO_MODEL_ROUTER_AGENT_ID="$(acquire_startup_field \
  weles-model-agent-id-bootstrap weles-model-agent-auth id)"
WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET="$(acquire_startup_field \
  weles-model-agent-secret-bootstrap weles-model-agent-auth agent_auth_secret)"
export WELES_STADO_MODEL_ROUTER_TOKEN WELES_STADO_MODEL_ROUTER_AGENT_ID
export WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET

log="$HOME/.stado/weles-figma-acquisition.log"
if /opt/homebrew/bin/node "$runtime/scripts/operations/acquire-figma-token-host.mjs" >"$log" 2>&1; then
  cat "$log"
else
  grep -E '\[figma_sso\]|\[google_sso\]|Target page|Figma|Error:|FAIL:' "$log" | tail -n 10 >&2
  exit 1
fi
