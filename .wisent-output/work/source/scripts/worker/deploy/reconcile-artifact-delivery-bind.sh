#!/bin/sh
set -eu

worker_env=${WELES_WORKER_ENV_FILE:-"$HOME/.config/weles/worker.env"}
if [ ! -f "$worker_env" ] || [ -L "$worker_env" ]; then
  printf '%s\n' "missing regular Weles worker environment: $worker_env" >&2
  exit 1
fi

count=$(/usr/bin/grep -c '^WELES_ARTIFACT_DELIVERY_HOST=' "$worker_env" || true)
if [ "$count" -ne 1 ]; then
  printf '%s\n' 'expected exactly one WELES_ARTIFACT_DELIVERY_HOST entry' >&2
  exit 1
fi

/usr/bin/sed -i '' 's/^WELES_ARTIFACT_DELIVERY_HOST=.*/WELES_ARTIFACT_DELIVERY_HOST=127.0.0.1/' "$worker_env"
printf '%s\n' 'Weles artifact delivery bind reconciled to IPv4 loopback'
