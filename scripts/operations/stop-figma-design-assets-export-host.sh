#!/bin/sh
set -eu
pidfile="$HOME/.stado/weles-figma-export.pid"
if [ ! -f "$pidfile" ]; then printf '{"status":"not-running"}\n'; exit 0; fi
pid=$(cat "$pidfile")
if kill -0 "$pid" 2>/dev/null; then
  kill -TERM "$pid"
  wait_count=0
  while kill -0 "$pid" 2>/dev/null && [ "$wait_count" -lt 30 ]; do sleep 1; wait_count=$((wait_count + 1)); done
fi
rm -f "$pidfile"
printf '{"status":"stopped","pid":%s}\n' "$pid"
