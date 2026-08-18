#!/bin/sh
# Stop orphaned Weles browser processes after a completed or failed API run.
set -eu

pattern="$HOME/.local/share/weles-chromium/"
pids="$(pgrep -f "$pattern" || true)"
if [ -z "$pids" ]; then
  printf '%s\n' 'no orphaned Weles browser processes'
  exit
fi
pkill -TERM -f "$pattern" || true
pkill -KILL -f "$pattern" || true
printf '%s\n' 'stopped orphaned Weles browser processes'
