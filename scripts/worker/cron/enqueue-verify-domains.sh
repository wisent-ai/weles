#!/usr/bin/env bash
# Daily enqueuer for resend_verify_domain_status.
#
# Drops ONE queued account_action_logs row; the weles worker on this host claims
# it, runs the email-domain health check (IP-gated, re-verifies stale domains,
# probes real receiving), and — because the worker env sets SLACK_NOTIFY_ALWAYS=1
# — auto-enqueues a slack_post_message so Jakub + Łukasz get the daily status DM.
#
# Installed as a launchd agent (com.wisent.weles-domain-check) that runs this
# once a day. Sources var/worker.env for SUPABASE_URL + service key. Idempotent
# enough: a duplicate queued row just produces a second (identical) check.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"   # weles repo root
cd "$HERE"
set -a; . ./var/worker.env; set +a
: "${SUPABASE_URL:=${NEXT_PUBLIC_SUPABASE_URL:-}}"
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "$(date -u +%FT%TZ) [domain-check] missing SUPABASE creds in var/worker.env" >&2
  exit 2
fi
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
code=$(curl -s -o /tmp/enqueue-verify-domains.out -w '%{http_code}' \
  -X POST "$SUPABASE_URL/rest/v1/account_action_logs" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "{\"action\":\"resend_verify_domain_status\",\"status\":\"queued\",\"scheduled_at\":\"$NOW\",\"params\":{}}")
if [ "$code" = "201" ]; then
  echo "$(date -u +%FT%TZ) [domain-check] enqueued resend_verify_domain_status ($(sed -E 's/.*\"id\":\"([^\"]+)\".*/\1/' /tmp/enqueue-verify-domains.out))"
else
  echo "$(date -u +%FT%TZ) [domain-check] enqueue FAILED http=$code body=$(cat /tmp/enqueue-verify-domains.out)" >&2
  exit 1
fi
