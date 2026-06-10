#!/bin/zsh
# Sweep a set of proxy sessions through the reddit signup flow and report, per
# session, whether reddit's verify-init passed (clean exit IP -> account created)
# or was rejected (burned IP -> 403 recaptcha_token=INVALID). The verify-init
# verdict is logged by scripts/trajectories/reddit_register.mjs.
#
# The reddit signup gate is purely exit-IP reputation: clean residential IPs
# register fine, burned ones 403. ~60% of NodeMaven CA filter-medium come up
# clean, so this just sweeps sessions and you keep the ones that pass.
#
# Config via env (NO credentials in source):
#   ENV_FILE       path to env file sourced for secrets (default ~/Downloads/env.txt)
#                  must provide CHROMIUM_PATH + the trajectory's email/DB/Resend keys
#   PROXY_UPSTREAM host:port of the proxy gateway (e.g. gate.nodemaven.com:8080)
#   NM_USER_TMPL   username template with {SID} placeholder, e.g.
#                  'jakub_x-country-us-region-california-sid-{SID}-filter-medium'
#   NM_PASS        proxy password
#   SIDS           space-separated sticky-session ids to sweep (or pass as args)
#   FORCE_EMAIL_DOMAIN  confirmed-receiving email domain (e.g. thegymhaven.com)
#
# Example:
#   PROXY_UPSTREAM=gate.nodemaven.com:8080 \
#   NM_USER_TMPL='user-country-us-region-california-sid-{SID}-filter-medium' \
#   NM_PASS=secret FORCE_EMAIL_DOMAIN=thegymhaven.com \
#   scripts/diag/reddit_session_sweep.sh sid1 sid2 sid3
set -a; source "${ENV_FILE:-$HOME/Downloads/env.txt}"; set +a
export PROXY_URL=http://127.0.0.1:${RELAY_PORT:-8899}
export WELES_HONEST_HOST=${WELES_HONEST_HOST:-0}
export WELES_FORCE_BROWSER=${WELES_FORCE_BROWSER:-chromium}
: ${PROXY_UPSTREAM:?set PROXY_UPSTREAM}
: ${NM_USER_TMPL:?set NM_USER_TMPL with {SID} placeholder}
: ${NM_PASS:?set NM_PASS}
SIDS_LIST=(${@:-${(z)SIDS}})
[ ${#SIDS_LIST[@]} -gt 0 ] || { echo "no SIDS given (args or SIDS env)"; exit 1; }

REPO=$(cd "$(dirname "$0")/../.." && pwd)
RELAY="$REPO/scripts/diag/proxy_relay.mjs"
SUMMARY=${SWEEP_SUMMARY:-/tmp/reddit_sweep_summary.txt}
MAX_TRIES=${MAX_TRIES:-2}   # retry transient crashes/timeouts (not 403s) this many times

# weles can't get a process handle to its custom Chromium (pwBrowser.process()
# returns null), so close() cannot force-kill a crashed browser — it leaks as a
# zombie. Leaked zombies pile up memory/GPU pressure and make the NEXT run's
# renderer crash (CDP "Input.dispatchMouseEvent: Internal error" / target
# closed), cascading. Reaping leftover Chromium + temp dirs between runs breaks
# that cascade — it's the actual fix for the mid-run crashes.
cleanup_browsers() {
  pkill -f "weles-chromium" 2>/dev/null
  sleep 1
  find /private/var/folders -maxdepth 4 -type d -name 'weles-fp-*' -exec rm -rf {} + 2>/dev/null
}
# A verdict that is a transient local failure (worth retrying on the same IP),
# as opposed to a clean reddit-gate read (403/PASS — re-running won't change it).
is_transient() {
  echo "$1" | grep -qiE "target page, context or browser has been closed|Protocol error|Internal error|ERR_TIMED_OUT|ERR_PROXY|<no verdict"
}

echo "===== reddit verify-init sweep (${#SIDS_LIST[@]} sessions) =====" | tee "$SUMMARY"
cd "$REPO"
for sid in $SIDS_LIST; do
  user=${NM_USER_TMPL/\{SID\}/$sid}
  export PROXY_UPSTREAM PROXY_CRED="${user}:${NM_PASS}"
  lsof -nP -iTCP:${RELAY_PORT:-8899} -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null
  cleanup_browsers   # reap any leftover from the previous run BEFORE starting
  PROXY_UPSTREAM="$PROXY_UPSTREAM" PROXY_CRED="$PROXY_CRED" nohup node "$RELAY" > /tmp/sweep_relay.log 2>&1 &
  sleep 2
  ip=$(curl -s -x "$PROXY_URL" --max-time 20 https://api.ipify.org 2>/dev/null)
  LOG=/tmp/reddit_sweep_${sid}.log
  echo "\n--- sid-${sid} exit=${ip:-?} ---" | tee -a "$SUMMARY"
  try=1; verdict=""
  while [ $try -le $MAX_TRIES ]; do
    node scripts/trajectories/reddit_register.mjs > "$LOG" 2>&1
    verdict=$(grep -iE "verify-init\] OK|verify_init_rejected|^PASS:|^FAIL:" "$LOG" | head -1)
    verdict=${verdict:-"<no verdict; see $LOG>"}
    if is_transient "$verdict" && [ $try -lt $MAX_TRIES ]; then
      echo "  try $try transient ($verdict) — reaping + retrying" | tee -a "$SUMMARY"
      cleanup_browsers
    else
      break
    fi
    try=$((try+1))
  done
  echo "  ${verdict}" | tee -a "$SUMMARY"
done
cleanup_browsers   # final reap
echo "\n===== sweep done =====" | tee -a "$SUMMARY"
