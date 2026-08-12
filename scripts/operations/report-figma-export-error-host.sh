#!/bin/sh
set -eu
log="$HOME/.stado/weles-figma-export.log"
err="$HOME/.stado/weles-figma-export.err"
printf '{"stdoutBytes":%s,"stderrBytes":%s}\n' "$(wc -c <"$log" | tr -d ' ')" "$(wc -c <"$err" | tr -d ' ')"
if [ -s "$err" ]; then tail -n 20 "$err"; fi
