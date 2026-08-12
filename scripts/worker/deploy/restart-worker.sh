#!/bin/sh
# Restart the always-on Weles worker on this host and report what came back.
#
#   stado host install-helper <target> \
#       scripts/worker/deploy/restart-worker.sh restart-worker
#   stado host run-helper <target> restart-worker
#
# `stado service restart` unloads the unit and re-bootstraps it, and a
# re-bootstrap of a unit launchd still considers loaded fails with "Bootstrap
# failed: 5: Input/output error" -- leaving the worker down. Recovering from that
# has meant reaching for ssh, which is exactly the channel the fleet forbids.
#
# `launchctl kickstart -k` restarts a running unit in place instead: no unload,
# no window where the daemon does not exist, and nothing to recover if the new
# process starts cleanly. The helper then reports the pid and the release its
# working directory resolves to, so the caller can see the restart took the
# symlink swap rather than assuming it did.
set -eu

unit=${WELES_WORKER_UNIT:-system/com.wisent.always-on.weles}

sudo launchctl kickstart -k "$unit"

# launchd returns before the process has re-execed; without settling first the
# report describes the outgoing process.
sleep "${WELES_RESTART_SETTLE_SECONDS:-8}"

node_bin=${NODE_BIN:-}
if [ -z "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi
if [ -z "$node_bin" ]; then node_bin=$(command -v node || true); fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  printf '%s\n' "no usable node interpreter; set NODE_BIN on this host" > /dev/stderr
  false
fi

pid=$(pgrep -f "worker/run.mjs" | head -n"${WELES_REPORT_PIDS:-1}" || true)
release=$(readlink "$HOME/weles" || true)

export WELES_REPORT_PID="$pid"
export WELES_REPORT_RELEASE="$release"
export WELES_REPORT_UNIT="$unit"

exec "$node_bin" -e '
process.stdout.write(JSON.stringify({
  status: process.env.WELES_REPORT_PID ? "running" : "not running",
  unit: process.env.WELES_REPORT_UNIT,
  pid: process.env.WELES_REPORT_PID || null,
  release: process.env.WELES_REPORT_RELEASE || null,
}, null, " ") + "\n");
'
