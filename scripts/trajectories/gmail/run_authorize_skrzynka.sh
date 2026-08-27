#!/bin/bash
# Run Skrzynka OAuth with the managed Weles workload identity on a Stado host.
set -euo pipefail

for env_file in "$HOME/weles/var/worker.env" "$HOME/.config/weles/worker.env"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
done

export SKARBIEC_WORKLOAD_ID="${SKARBIEC_WORKLOAD_ID:-weles-credential-worker-local}"
export WELES_SKARBIEC_URL="${WELES_SKARBIEC_URL:-${WC_SKARBIEC_URL:-http://127.0.0.1:19095}}"
exec /opt/homebrew/bin/node scripts/trajectories/gmail/authorize_skrzynka.mjs
