#!/bin/sh
# Remove the Weles Skarbiec authority unit installed for a vault that is not on
# this host.
#
# The unit was rendered to give the declared authority a supervised existence, but
# the vault it serves is absent, so KeepAlive turns it into a process that fails
# forever and logs on every respawn. A daemon that cannot succeed is worse than no
# daemon: it hides the real state. Boot it out and take the unit file with it.
set -eu

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

label=com.wisent.always-on.skarbiec-weles
plist="/Library/LaunchDaemons/$label.plist"

if /usr/bin/sudo -n /bin/launchctl print "system/$label" >/dev/null 2>&1; then
  /usr/bin/sudo -n /bin/launchctl bootout "system/$label" || printf 'bootout refused\n'
  printf 'booted out %s\n' "$label"
else
  printf 'no loaded job for %s\n' "$label"
fi
if [ -f "$plist" ]; then
  /usr/bin/sudo -n /bin/rm -f "$plist"
  printf 'removed %s\n' "$plist"
fi
/usr/sbin/lsof -nP -iTCP:19095 -sTCP:LISTEN || printf 'nothing listening on 19095\n'
