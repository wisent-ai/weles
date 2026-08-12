#!/bin/sh
# Report the Weles API listener and launchd owner without exposing environment values.
set -eu
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

printf '%s\n' 'listener:'
lsof -nP -iTCP:8788 -sTCP:LISTEN || true
listener_pids=$(lsof -tiTCP:8788 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$listener_pids" ]; then
  ps -p "$listener_pids" -o pid= -o ppid= -o etime= -o command=
fi
printf '%s\n' 'launchd:'
launchctl list | sed -n '/com\.wisent\.weles-api/p'
