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

uid=$(id -u)
account=$(id -un)
console=$(stat -f%Su /dev/console 2>/dev/null || true)
session_domain="user/$uid"
if [ "$console" = "$account" ] && launchctl print "gui/$uid" >/dev/null 2>&1; then
  session_domain="gui/$uid"
fi

printf 'launchd domains: system %s\n' "$session_domain"
for domain in system "$session_domain"; do
  for label in com.wisent.weles-admission com.wisent.always-on.weles-api; do
    qualified="$domain/$label"
    printf '%s:\n' "$qualified"
    if ! launchctl print "$qualified" 2>/dev/null \
      | awk '
        /^[[:space:]]*(state|path|type|program|runs|pid|last exit code|last terminating signal|throttle interval|immediate reason)[[:space:]]*=/ {
          sub(/^[[:space:]]*/, "")
          print
          found = 1
        }
        END { if (!found) exit 1 }
      '
    then
      printf '%s\n' 'absent'
    fi
  done
done
