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
echo "===== reddit verify-init sweep (${#SIDS_LIST[@]} sessions) =====" | tee "$SUMMARY"
cd "$REPO"
for sid in $SIDS_LIST; do
  user=${NM_USER_TMPL/\{SID\}/$sid}
  export PROXY_UPSTREAM PROXY_CRED="${user}:${NM_PASS}"
  lsof -nP -iTCP:${RELAY_PORT:-8899} -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null
  sleep 1
  PROXY_UPSTREAM="$PROXY_UPSTREAM" PROXY_CRED="$PROXY_CRED" nohup node "$RELAY" > /tmp/sweep_relay.log 2>&1 &
  sleep 2
  ip=$(curl -s -x "$PROXY_URL" --max-time 20 https://api.ipify.org 2>/dev/null)
  LOG=/tmp/reddit_sweep_${sid}.log
  echo "\n--- sid-${sid} exit=${ip:-?} ---" | tee -a "$SUMMARY"
  node scripts/trajectories/reddit_register.mjs > "$LOG" 2>&1
  verdict=$(grep -iE "verify-init\] OK|verify_init_rejected|^PASS:|^FAIL:" "$LOG" | head -1)
  echo "  ${verdict:-<no verdict; see $LOG>}" | tee -a "$SUMMARY"
done
echo "\n===== sweep done =====" | tee -a "$SUMMARY"
