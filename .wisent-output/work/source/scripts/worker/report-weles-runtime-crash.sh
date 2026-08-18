#!/bin/sh
# Print the newest macOS crash report for the managed Weles Chromium release.
set -eu

latest=''
for report in "$HOME"/Library/Logs/DiagnosticReports/Chromium-*.ips; do
  [ -e "$report" ] || continue
  if [ -z "$latest" ] || [ "$report" -nt "$latest" ]; then
    latest="$report"
  fi
done
if [ -z "$latest" ]; then
  printf '%s\n' 'no Weles Chromium crash report found'
  exit
fi
printf 'report=%s\n' "$latest"
sed -n '1,220p' "$latest"
