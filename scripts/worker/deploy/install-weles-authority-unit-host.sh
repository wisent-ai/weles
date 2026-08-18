#!/bin/sh
# Install the LaunchDaemon the registry already declares for the Weles Skarbiec
# authority, and load it.
#
# The registry declares service `skarbiec-weles` on this host, its unit label and
# its endpoint http://127.0.0.1:19095, but the unit file was never on disk: the
# authority ran as a hand-started process, and when it exited nothing brought it
# back. `stado service deploy` refuses because the record exists and
# `stado service retire` refuses because its validator does not accept that same
# record, so the declared unit is rendered here around the checked-in launcher —
# the same program, the same port, the same vault the declaration names.
#
# Idempotent: an existing unit file is left alone unless its program differs, and
# a loaded job is kickstarted rather than re-bootstrapped.
set -eu

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

label=com.wisent.always-on.skarbiec-weles
plist="/Library/LaunchDaemons/$label.plist"
program="$HOME/.stado/bin/serve-weles-skarbiec-authority"
logs="$HOME/.stado/logs"
owner=$(/usr/bin/id -un)

[ -x "$program" ] || { printf 'launcher is absent: %s\n' "$program" >&2; exit 1; }
/bin/mkdir -p "$logs"

rendered=$(/usr/bin/mktemp "${TMPDIR:-/tmp}/skarbiec-weles-unit.XXXXXX")
trap 'rm -f "$rendered"' EXIT INT TERM
/bin/cat > "$rendered" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$program</string></array>
  <key>UserName</key><string>$owner</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$logs/skarbiec-weles.log</string>
  <key>StandardErrorPath</key><string>$logs/skarbiec-weles.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$rendered" >/dev/null

if [ -f "$plist" ] && /usr/bin/cmp -s "$rendered" "$plist"; then
  printf 'unit already matches the declaration\n'
else
  /usr/bin/sudo -n /usr/bin/install -m 644 -o root -g wheel "$rendered" "$plist"
  printf 'installed unit %s\n' "$plist"
fi

if /usr/bin/sudo -n /bin/launchctl print "system/$label" >/dev/null 2>&1; then
  /usr/bin/sudo -n /bin/launchctl kickstart -k "system/$label" >/dev/null 2>&1 || true
  printf 'kickstarted existing job\n'
else
  /usr/bin/sudo -n /bin/launchctl bootstrap system "$plist"
  printf 'bootstrapped\n'
fi

/bin/sleep 3
printf 'state: %s\n' "$(/usr/bin/sudo -n /bin/launchctl print "system/$label" 2>/dev/null | /usr/bin/awk '/state = /{print $3; exit}')"
/usr/sbin/lsof -nP -iTCP:19095 -sTCP:LISTEN || printf 'nothing listening on 19095\n'
