#!/bin/sh
set -eu
log="$HOME/.stado/weles-figma-export-background.log"
pidfile="$HOME/.stado/weles-figma-export.pid"
if [ -f "$pidfile" ]; then
  oldpid=$(cat "$pidfile")
  if kill -0 "$oldpid" 2>/dev/null; then
    printf '{"status":"already-running","pid":%s}\n' "$oldpid"
    exit 0
  fi
fi
nohup "$HOME/.stado/bin/run-export-figma-design-assets-host" >"$log" 2>&1 </dev/null &
pid=$!
printf '%s\n' "$pid" >"$pidfile"
printf '{"status":"started","pid":%s}\n' "$pid"
