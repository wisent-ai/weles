#!/bin/sh
set -eu
pidfile="$HOME/.stado/weles-figma-export.pid"
state="stopped"
pid=null
if [ -f "$pidfile" ]; then
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then state="running"; else state="finished"; fi
fi
work="$HOME/.stado/work/design-assets/figma.next"
if [ -d "$work" ]; then
  files=$(find "$work" -type f | wc -l | tr -d ' ')
  bytes=$(du -sk "$work" | cut -f1)
  printf '{"state":"%s","pid":%s,"files":%s,"kilobytes":%s}\n' "$state" "$pid" "$files" "$bytes"
else
  printf '{"state":"%s","pid":%s,"files":0,"kilobytes":0}\n' "$state" "$pid"
fi
