#!/bin/sh
set -u

uid=$(/usr/bin/id -u)

printf 'host: '
/bin/hostname
printf 'uid: %s\n' "$uid"

for domain in "gui/$uid" "user/$uid"; do
  for label in \
    com.wisent.always-on.weles \
    com.wisent.compute.service.com.wisent.always-on.weles \
    com.wisent.weles-worker
  do
    printf '\n== launchd %s/%s ==\n' "$domain" "$label"
    if ! /bin/launchctl print "$domain/$label" 2>&1 | /usr/bin/sed -n '1,100p'; then
      printf 'not loaded\n'
    fi
  done
done

for label in \
  com.wisent.always-on.weles \
  com.wisent.always-on.skarbiec
do
  printf '\n== launchd system/%s ==\n' "$label"
  if ! /bin/launchctl print "system/$label" 2>&1 | /usr/bin/sed -n '1,120p'; then
    printf 'not loaded\n'
  fi

  plist="/Library/LaunchDaemons/$label.plist"
  printf '\n== %s ==\n' "$plist"
  if [ -f "$plist" ]; then
    /usr/bin/stat -f 'owner=%Su group=%Sg mode=%Sp modified=%Sm bytes=%z' -t '%Y-%m-%dT%H:%M:%SZ' "$plist"
    /usr/bin/plutil -lint "$plist"
    /usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$plist"
    /usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c 'Print :StandardErrorPath' "$plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c 'Print :UserName' "$plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c 'Print :RunAtLoad' "$plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$plist" 2>/dev/null || true
  else
    printf 'missing\n'
  fi
done

printf '\n== launcher path ==\n'
/bin/ls -ld "$HOME/weles" "$HOME/weles/scripts/worker/deploy/launch-mac.sh" 2>&1
/usr/bin/grep -E '(WC_SKARBIEC_URL|WELES_CREDENTIAL_SKARBIEC_URL|STADO_(RESOLVER_API_URL|OBJECT_API_URI|API_URL))=' \
  "$HOME/weles/scripts/worker/deploy/launch-mac.sh" || true

printf '\n== worker routing settings ==\n'
if [ -f "$HOME/.config/weles/worker.env" ]; then
  /usr/bin/grep -E '^(WELES_PLACEMENT_MODE|WELES_PLACEMENT_POLICY_FILE|WC_SKARBIEC_URL)=' \
    "$HOME/.config/weles/worker.env" || true
else
  printf 'missing: %s\n' "$HOME/.config/weles/worker.env"
fi

printf '\n== worker processes ==\n'
/bin/ps axww -o pid=,ppid=,etime=,command= | /usr/bin/awk '
  /\/weles\/scripts\/worker\/run\.mjs/ {
    printf "pid=%s ppid=%s elapsed=%s executable=%s entrypoint=%s\n", $1, $2, $3, $4, $5
    found = 1
  }
  END { if (!found) print "none" }
'

printf '\n== Skarbiec route and processes ==\n'
if [ -f "$HOME/.config/stado/config.json" ]; then
  /usr/bin/jq -c '{control_plane_url: .secrets.skarbiec.url, object_url: .object_api.skarbiec.url}' "$HOME/.config/stado/config.json"
fi
/bin/ps axww -o pid=,ppid=,etime=,command= | /usr/bin/awk '/[s]karbiec/ { print }'
/bin/ps axww -o pid=,ppid=,etime=,command= | /usr/bin/awk '/[s]tado resolver/ { print }'
if [ -f "$HOME/.stado/skarbiec.audit.jsonl" ]; then
  /usr/bin/grep -E 'stado-(object|release|machine|service|rate-limit|integration|backend-push)-api-verifier' \
    "$HOME/.stado/skarbiec.audit.jsonl" | /usr/bin/tail -n 40 || true
fi

printf '\n== Stado credential files ==\n'
for credential in \
  control-plane-skarbiec-token \
  stado-object-api-verifier-skarbiec-token \
  stado-release-api-verifier-skarbiec-token \
  stado-machine-api-verifier-skarbiec-token \
  stado-service-api-verifier-skarbiec-token \
  stado-rate-limit-api-verifier-skarbiec-token \
  stado-integration-api-verifier-skarbiec-token \
  stado-backend-push-api-verifier-skarbiec-token
do
  credential_path="$HOME/.stado/$credential"
  if [ -f "$credential_path" ]; then
    /usr/bin/stat -f '%N owner=%Su group=%Sg mode=%Sp modified=%Sm bytes=%z' -t '%Y-%m-%dT%H:%M:%SZ' "$credential_path"
  else
    printf '%s missing\n' "$credential_path"
  fi
done

printf '\n== Weles placement policy ==\n'
for placement_policy in \
  "$HOME/.config/weles/placement-policy.json" \
  /etc/weles/placement-policy.json
do
  if [ -f "$placement_policy" ]; then
    printf '%s\n' "$placement_policy"
    /bin/cat "$placement_policy"
  else
    printf 'missing: %s\n' "$placement_policy"
  fi
done

for log in \
  "$HOME/.local/state/weles/worker.log" \
  "$HOME/.local/state/weles/worker.err" \
  "$HOME/.stado/logs/weles-always-on.out" \
  "$HOME/.stado/logs/weles-always-on.err" \
  "$HOME/.local/state/weles/auto-deploy.log"
do
  printf '\n== %s ==\n' "$log"
  if [ -f "$log" ]; then
    /usr/bin/stat -f 'modified=%Sm bytes=%z' -t '%Y-%m-%dT%H:%M:%SZ' "$log"
    /usr/bin/tail -n 40 "$log"
  else
    printf 'missing\n'
  fi
done

for stado_log in \
  "$HOME/.stado/logs/"*coordinator* \
  "$HOME/.stado/logs/"*resolver* \
  "$HOME/.stado/logs/"*dashboard*
do
  [ -f "$stado_log" ] || continue
  printf '\n== %s ==\n' "$stado_log"
  /usr/bin/stat -f 'modified=%Sm bytes=%z' -t '%Y-%m-%dT%H:%M:%SZ' "$stado_log"
  /usr/bin/grep -E 'boundary|Skarbiec|object authorization|object verifier' "$stado_log" 2>/dev/null | /usr/bin/tail -n 80 || true
  /usr/bin/tail -n 40 "$stado_log"
done
