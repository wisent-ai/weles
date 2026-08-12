#!/bin/sh
# Report non-secret Weles capability identity and broker configuration.
set -eu

set -a
if [ -f "$HOME/.config/weles/worker.env" ]; then
  . "$HOME/.config/weles/worker.env"
fi
set +a
printf 'workload_id=%s\n' "${SKARBIEC_WORKLOAD_ID:-missing}"
printf 'signing_key=%s\n' "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:-missing}"
if [ -n "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:-}" ] && [ -f "$SKARBIEC_WORKLOAD_SIGNING_KEY_FILE" ]; then
  printf '%s\n' 'signing_key_present=true'
else
  printf '%s\n' 'signing_key_present=false'
fi
printf 'capability_state=%s\n' "$HOME/.stado/weles-api-capabilities.json"
printf 'capability_routes=%s\n' "$HOME/.stado/weles-api-capability-routes.json"
