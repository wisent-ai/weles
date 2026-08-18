#!/bin/sh
set -eu

label=com.wisent.always-on.weles
plist=/Library/LaunchDaemons/$label.plist
launcher="$HOME/weles/scripts/worker/deploy/launch-mac.sh"

if [ ! -x "$launcher" ] || [ ! -f "$plist" ]; then
  printf '%s\n' 'Weles launcher and managed plist are required' >&2
  exit 1
fi

arguments=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$plist")
printf '%s\n' "$arguments" | /usr/bin/grep -F "$launcher" >/dev/null

if /bin/launchctl print "system/$label" >/dev/null 2>&1; then
  printf '%s\n' 'Weles worker already loaded'
  exit 0
fi

/usr/bin/sudo -n /bin/launchctl bootstrap system "$plist"
/bin/launchctl print "system/$label" | /usr/bin/sed -n '1,80p'
