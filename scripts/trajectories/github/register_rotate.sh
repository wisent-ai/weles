#!/usr/bin/env bash
# Retry wrapper around register.mjs that handles Arkose IP reputation.
# register.mjs exits 42 when fewer than 15 Arkose asset URLs appear after
# its widget wait (indicating the current proxy exit is flagged). This
# loop retries up to MAX_ATTEMPTS times; every iteration picks a fresh
# sticky session from the proxy pool via resolveProxy's random shuffle,
# so each retry gets a different exit IP. Any other non-zero exit is
# propagated verbatim.

set -u
cd "$(dirname "$0")/../../.." || exit 1

if [[ -f .env ]]; then set -a; . .env; set +a; fi

MAX_ATTEMPTS=${MAX_ATTEMPTS:-6}
PROXY_URL=${PROXY_URL:-residential}
export WELES_DISABLE_RECORDING=${WELES_DISABLE_RECORDING:-1}
export PROXY_URL

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo ""
  echo "================================================================"
  echo "[rotate] Attempt $attempt/$MAX_ATTEMPTS (PROXY_URL=$PROXY_URL)"
  echo "================================================================"
  node scripts/trajectories/github/register.mjs
  code=$?
  case "$code" in
    0)  echo "[rotate] SUCCESS on attempt $attempt"; exit 0 ;;
    42) echo "[rotate] Attempt $attempt: IP flagged by Arkose, rotating proxy..."; sleep 3 ;;
    *)  echo "[rotate] Attempt $attempt: FAIL with exit $code (non-IP error) — aborting"; exit "$code" ;;
  esac
done

echo "[rotate] EXHAUSTED $MAX_ATTEMPTS attempts without a clean Arkose widget"
exit 1
