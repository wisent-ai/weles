#!/bin/bash
# Mac launchd wrapper: sources worker.env then execs node.
# PATH must include /opt/homebrew/bin so worker-spawned trajectories can use bare `node`.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
. "$HOME/weles/var/worker.env"
set +a
mkdir -p "$HOME/weles/var"
exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$HOME/weles/scripts/worker/run.mjs"
