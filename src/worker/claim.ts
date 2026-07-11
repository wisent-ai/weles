// Atomic queue-claim helper. Extracted from poll.ts to keep that file
// under the 300-line cap.

import type { ActionLogRow } from './poll.js';
import { resolveTrajectory } from './dispatch.js';
import { staleCookieAccounts } from './stale.js';
import { INSTANCE_ID } from './identity.js';
import type { WelesActionPolicy } from './stado-routing.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

export async function claimOne(policy: WelesActionPolicy): Promise<ActionLogRow | null> {
  if (!policy.enabled || policy.actions.length === 0) return null;
  const allowedActions = policy.wildcard ? null : new Set(policy.actions);
  const actionFilter = policy.wildcard
    ? ''
    : `&action=in.(${policy.actions.map((action) => encodeURIComponent(`"${action.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')})`;
  // Lookahead 1000 rows so large legacy backlogs don't hide fresh trading
  // scrape rows behind the first page. Keep the SELECT schema-minimal:
  // content-platform's account_action_logs currently has no webhook_url,
  // cancel_requested, or priority columns; selecting them makes PostgREST
  // return 400 and the worker appear idle forever.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/account_action_logs?select=id,account_id,action,platform,params,status&status=eq.queued&or=(scheduled_at.is.null,scheduled_at.lte.now())${actionFilter}&order=scheduled_at.asc.nullsfirst&limit=1000`,
    { headers: headers() },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[worker] claim candidate query failed ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }
  let candidates = ((await res.json()) as ActionLogRow[])
    .filter((row) => !allowedActions || allowedActions.has(row.action));
  // Priority sort: trading scrapes first, then recovery rows (*_login,
  // *_register, *_health, *_balance, *_topup), then everything else.
  // Scrapes are parallel-safe direct jobs and must not be buried behind a
  // legacy social recovery backlog; login still beats ordinary social rows.
  const recoveryRe = /_(login|register|health|balance|topup|reauth)$/;
  const isParallelSafeScrape = (a: string) => /^(unusualwhales|volumeleaders|tradingview)_scrape$/.test(a);
  const priority = (row: ActionLogRow) => (isParallelSafeScrape(row.action) ? 2000 : 0) + (recoveryRe.test(row.action) ? 1000 : 0) + Number(row.priority ?? 0);
  candidates = candidates
    .map((r, i) => ({ r, i, p: priority(r) }))
    .sort((x, y) => y.p - x.p || x.i - y.i)
    .map((e) => e.r);
  // Per-account in-flight lock: each account has ONE stored sticky proxy session (Oxylabs sessid). Concurrent connections to one sticky session get refused with ERR_TUNNEL_CONNECTION_FAILED. Serialize per-account; deferred rows pick up next tick. Ignore rows older than 30 min — those are stuck-poison from killed workers and should not block their account forever.
  const inflightAccounts = new Set<string>();
  if (candidates.length) {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?select=account_id,claimed_at&status=eq.running&claimed_at=gte.${cutoff}`, { headers: headers() });
    if (r.ok) for (const row of (await r.json()) as { account_id: string | null }[]) if (row.account_id) inflightAccounts.add(row.account_id);
  }
  const staleAccounts = await staleCookieAccounts(candidates);
  // Trading scrapes run with proxy_url_override='direct' (no sticky-session
  // proxy), so the per-account in-flight lock that protects Oxylabs sessids
  // does not apply. Allowing N workers to claim concurrent *_scrape rows
  // for the same sentinel account is what makes parallel trading scrapes
  // possible. Social actions still get the lock because they share an
  // Oxylabs sticky session per account.
  // Account-less actions the worker may claim: direct trading scrapes (the
  // scripts use ticker/page params, not ACCOUNT_ID), account creation, proxy
  // provider balance/topup, and infra maintenance (resend_verify_domain_status
  // health check + the slack_post_message alert it chains), plus analytics
  // service browser actions that use service credentials rather than a social
  // account row. Everything else without an account is a poison orphan.
  const isOverleafAction = (a: string) => a.startsWith('overleaf_');
  const canRunWithoutAccount = (a: string) => isParallelSafeScrape(a) || /_register$|_balance$|_topup$|_reauth$|_verify_domain_status$|_post_message$/.test(a) || a === 'slack_provision_user_token' || a === 'pangram_analyze_text' || a === 'ncbr_pangram_audit_new_wniosek' || a === 'generic_browser_task' || a === 'generic_keeper_task' || a === 'generic_saved_task' || a === 'semanticscholar_key_followup' || isOverleafAction(a) || /^(umami|googleanalytics)_/.test(a);
  for (const row of candidates) {
    // Defend independently of PostgREST decoding/filter semantics.
    if (allowedActions && !allowedActions.has(row.action)) continue;
    if (!resolveTrajectory(row.action)) continue;
    if (!row.id) continue;
    if (!row.account_id && !canRunWithoutAccount(row.action)) continue; // poison rows: legacy promote-cron sometimes emits orphans
    if (row.account_id && inflightAccounts.has(row.account_id) && !isParallelSafeScrape(row.action)) continue;
    // staleAccounts blocks non-recovery actions; recovery actions (login,
    // register, health, balance, topup) MUST run to refresh stale cookies
    // — without this carve-out, _login rows for stale accounts get blocked
    // by the same flag they exist to clear, and the account stays dead.
    // (Same intent as the filter at stale.ts:31, applied per-row here.)
    if (row.account_id && staleAccounts.has(row.account_id) && !recoveryRe.test(row.action) && !isParallelSafeScrape(row.action)) continue;

    const claim = await fetch(
      `${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${row.id}&status=eq.queued`,
      {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'running', claimed_by: INSTANCE_ID,
          claimed_at: new Date().toISOString(), started_at: new Date().toISOString(),
        }),
      },
    );
    if (!claim.ok) continue;
    const claimed = (await claim.json()) as ActionLogRow[];
    if (claimed.length > 0) return claimed[0];
  }
  return null;
}
