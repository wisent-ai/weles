#!/bin/sh
# Report the always-on worker's liveness and the tail of both its log sinks.
#
#   stado host install-helper <target> \
#       scripts/worker/deploy/report-worker-state.sh report-worker-state
#   stado host run-helper <target> report-worker-state
#
# Reading a worker's logs has meant opening an ssh session, which is the channel
# the fleet forbids and which no audit trail records. Everything here is a read:
# the pid, the release its symlink points at, and the last lines each log sink
# received. That is enough to tell "polling and idle" from "crashed at startup"
# from "refusing to claim", which are three very different failures that look
# identical from the queue side.
set -eu

out=${WELES_WORKER_OUT_LOG:-$HOME/.stado/logs/weles-always-on.out}
err=${WELES_WORKER_ERR_LOG:-$HOME/.stado/logs/weles-always-on.err}

printf '%s\n' "=== worker ==="
printf 'pid: %s\n' "$(pgrep -f 'worker/run.mjs' | tr '\n' ' ')"
printf 'release: %s\n' "$(readlink "$HOME/weles" || printf '%s' 'not a symlink')"

printf '%s\n' "=== stdout tail ==="
if [ -f "$out" ]; then
  printf 'mtime: %s\n' "$(stat -f '%Sm' "$out")"
  tail "$out"
else
  printf '%s\n' "absent: $out"
fi

printf '%s\n' "=== stderr tail ==="
if [ -f "$err" ]; then
  printf 'mtime: %s\n' "$(stat -f '%Sm' "$err")"
  tail "$err"
else
  printf '%s\n' "absent: $err"
fi
