#!/bin/bash
set -euo pipefail

ENV_FILE="${SKARBIEC_CAPABILITY_ENV_FILE:-$HOME/weles/var/skarbiec-capability.env}"
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  echo "missing regular Skarbiec capability environment file" >&2
  exit 1
fi
MODE="$(stat -c '%a' "$ENV_FILE")"
OWNER="$(stat -c '%u' "$ENV_FILE")"
if [[ "$OWNER" != "$(id -u)" ]] || (( (8#$MODE & 077) != 0 )); then
  echo "Skarbiec capability environment file must be owner-only" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

STADO_BIN="${STADO_BIN:-$HOME/.stado/bin/stado}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
export STADO_BIN
if [[ ! -x "$STADO_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "missing Stado or Node for attested Skarbiec resolution" >&2
  exit 1
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if ! SKARBIEC_BIN="$("$NODE_BIN" "$script_dir/../../_shared/skarbiec-runtime.mjs" active-binary)"; then
  echo "Stado has no attested active Skarbiec binary for this host" >&2
  exit 1
fi

case "${1:-}" in
  apple-challenge-put|capability-issue|capability-status|capability-cancel)
    exec "$SKARBIEC_BIN" "$@"
    ;;
  *)
    echo "remote Skarbiec command is not allowed" >&2
    exit 2
    ;;
esac
