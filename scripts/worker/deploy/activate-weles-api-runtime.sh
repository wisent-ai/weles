#!/bin/sh
# Cut the Weles API over from an unowned process to one system launchd unit.
set -eu
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

home=${HOME:?HOME is required}
label='com.wisent.always-on.weles-api'
launcher="$home/.stado/bin/weles-api-launcher"
runtime="$home/.stado/build-work/weles-api-managed/scripts/worker/weles-api-server.mjs"
vault="$home/.stado/weles-skarbiec.vault.json"
signing_key="$home/.stado/weles-credential-workload-private.pem"
plist="/Library/LaunchDaemons/$label.plist"
template=$(mktemp "$home/.stado/$label.XXXXXX.plist")
cleanup() {
  rm -f "$template"
}
trap cleanup EXIT HUP INT TERM

for file in "$launcher" "$runtime" "$vault" "$signing_key"; do
  [ -f "$file" ] || {
    printf 'required file is missing: %s\n' "$file" >&2
    exit 1
  }
done
[ -x "$launcher" ] || chmod u+x "$launcher"

cat > "$template" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$launcher</string>
  </array>
  <key>UserName</key>
  <string>$(id -un)</string>
  <key>WorkingDirectory</key>
  <string>$home</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$home/.stado/logs/weles-api-managed.log</string>
  <key>StandardErrorPath</key>
  <string>$home/.stado/logs/weles-api-managed.log</string>
</dict>
</plist>
PLIST
chmod 600 "$template"
mkdir -p "$home/.stado/logs"
chmod 700 "$home/.stado/logs"
/usr/bin/sudo -n /usr/bin/install -o root -g wheel -m 644 "$template" "$plist"

if ! /usr/bin/sudo -n /bin/launchctl print "system/$label" >/dev/null 2>&1; then
  /usr/bin/sudo -n /bin/launchctl bootstrap system "$plist" >/dev/null
fi

old_pids=$(lsof -tiTCP:8788 -sTCP:LISTEN 2>/dev/null || true)
for pid in $old_pids; do
  command=$(ps -p "$pid" -o command=)
  case "$command" in
    *"$runtime") kill -TERM "$pid" ;;
    *)
      printf 'refusing to replace unexpected port 8788 listener: %s\n' "$command" >&2
      exit 1
      ;;
  esac
done

/usr/bin/sudo -n /bin/launchctl kickstart -k "system/$label"
count=0
while [ "$count" -lt 30 ]; do
  pid=$(lsof -tiTCP:8788 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pid" ] && /usr/bin/sudo -n /bin/launchctl print "system/$label" >/dev/null 2>&1; then
    printf '{"status":"active","label":"%s","pid":%s}\n' "$label" "$pid"
    exit 0
  fi
  count=$((count + 1))
  sleep 1
done
printf 'managed Weles API did not bind port 8788\n' >&2
exit 1
