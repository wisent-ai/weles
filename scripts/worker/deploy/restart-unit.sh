#!/bin/sh
# Restart one launchd unit named by a delivered file, loading it first if a
# previous failed restart left it unloaded.
#
#   stado host install-file <target> <unit.txt> restart-unit.txt
#   stado host install-helper <target> \
#       scripts/worker/deploy/restart-unit.sh restart-unit
#   stado host run-helper <target> restart-unit
#
# `stado service restart` unloads a unit and re-bootstraps it. When launchd still
# holds children of the old job the re-bootstrap fails with "disowned process
# survived" and the unit is left *unloaded* -- worse than before the call, since
# the listeners it owned are gone and `kickstart` can no longer find it. That is
# the state this recovers from, and the reason it does not stop at kickstart.
#
# `launchctl kickstart -k` restarts a loaded unit in place: no unload, no window
# where the job does not exist, nothing orphaned. If the unit is not loaded at
# all, it is bootstrapped from its plist and then kicked. The unit name arrives
# in a delivered file because the registry channel passes no caller-chosen
# arguments.
set -eu

unit_file=${WELES_DELIVERY_DIR:-$HOME/.stado/files}/restart-unit.txt
if [ ! -f "$unit_file" ] || [ -L "$unit_file" ]; then
  printf '%s\n' "missing regular delivered file: $unit_file" > /dev/stderr
  false
fi

unit=$(tr -d '\n\r' < "$unit_file")
case $unit in
  system/com.wisent.*) ;;
  *)
    printf '%s\n' "refusing a unit outside system/com.wisent: $unit" > /dev/stderr
    false
    ;;
esac

label=${unit#system/}
plist=/Library/LaunchDaemons/$label.plist

if sudo launchctl kickstart -k "$unit" 2>/dev/null; then
  printf 'kickstarted: %s\n' "$unit"
else
  printf 'not loaded, bootstrapping from %s\n' "$plist"
  if [ ! -f "$plist" ]; then
    printf '%s\n' "no plist for $label at $plist" > /dev/stderr
    false
  fi
  sudo launchctl bootstrap system "$plist"
  sudo launchctl kickstart -k "$unit"
  printf 'bootstrapped and kickstarted: %s\n' "$unit"
fi

sleep "${WELES_RESTART_SETTLE_SECONDS:-8}"

printf '%s\n' "=== listeners now ==="
lsof -nP -iTCP -sTCP:LISTEN
