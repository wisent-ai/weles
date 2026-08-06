// Atomic queue-claim helper. Extracted from poll.ts to keep that file
// under the 300-line cap.

import type { ActionLogRow } from './poll.js';
import { resolveTrajectory } from './dispatch.js';
import { staleCookieAccounts } from './stale.js';
import os from 'node:os';
import { optionalWelesDatabase } from '../utils/weles-database.js';

const DATABASE_URL = optionalWelesDatabase()?.url ?? '';
const DATABASE_TOKEN = optionalWelesDatabase()?.token ?? '';
const INSTANCE_ID = process.env.INSTANCE_ID ?? `weles-${os.hostname() || 'unknown'}-${process.pid}`;
const ACTION_ALLOWLIST_VALUES = (process.env.WELES_ACTION_ALLOWLIST ?? '')
  .split(',')
  .map((action) => action.trim())
  .filter(Boolean);
if (!ACTION_ALLOWLIST_VALUES.length
    || new Set(ACTION_ALLOWLIST_VALUES).size !== ACTION_ALLOWLIST_VALUES.length
    || ACTION_ALLOWLIST_VALUES.some((action) => !/^[a-z_]+$/.test(action))) {
  throw new Error('WELES_ACTION_ALLOWLIST must contain unique exact lowercase Weles action names');
}
const ACTION_ALLOWLIST = new Set(ACTION_ALLOWLIST_VALUES);
const ACTION_FILTER = `&action=in.(${ACTION_ALLOWLIST_VALUES.map((action) =>
  encodeURIComponent(`"${action.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
).join(',')})`;

function headers(): Record<string, string> {
  return { apikey: DATABASE_TOKEN, Authorization: `Bearer ${DATABASE_TOKEN}`, 'Content-Type': 'application/json' };
}

export async function claimOne(): Promise<ActionLogRow | null> {
  // Lookahead 1000 rows so large legacy backlogs don't hide fresh trading
  // scrape rows behind the first page. Keep the SELECT schema-minimal:
  // Echo's account_action_logs currently has no webhook_url,
  // cancel_requested, or priority columns; selecting them makes PostgREST
  // return 400 and the worker appear idle forever.
  const res = await fetch(
    `${DATABASE_URL}/rest/v1/account_action_logs?select=id,account_id,action,platform,params,status&status=eq.queued&or=(scheduled_at.is.null,scheduled_at.lte.now())${ACTION_FILTER}&order=scheduled_at.asc.nullsfirst&limit=1000`,
    { headers: headers() },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[worker] claim candidate query failed ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }
  let candidates = (await res.json()) as ActionLogRow[];
  if (ACTION_ALLOWLIST.size > 0) {
    candidates = candidates.filter((row) => ACTION_ALLOWLIST.has(row.action));
  }
  // Priority sort: recovery rows (*_login, *_register, *_health, *_balance,
  // *_topup) before trading scrapes, then everything else. Login mints
  // cookies and unblocks downstream social actions; trading scrapes are
  // parallel-safe direct jobs and should not be buried behind stale dwell rows.
  const recoveryRe = /_(login|register|health|balance|topup|reauth)$/;
  const isParallelSafeScrape = (a: string) => /^(unusualwhales|volumeleaders|tradingview)_scrape$/.test(a);
  const priority = (row: ActionLogRow) => (recoveryRe.test(row.action) ? 1000 : 0) + (isParallelSafeScrape(row.action) ? 900 : 0) + Number(row.priority ?? 0);
  candidates = candidates
    .map((r, i) => ({ r, i, p: priority(r) }))
    .sort((x, y) => y.p - x.p || x.i - y.i)
    .map((e) => e.r);
  const executionHost = os.hostname();
  const executionAgent = process.env.WELES_EXECUTION_AGENT ?? 'weles-worker';
  candidates = candidates.filter((row) => {
    if (row.action !== 'apple_login') return true;
    const params = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
      ? row.params as Record<string, unknown>
      : {};
    return params.apple_execution_host === executionHost
      && params.apple_execution_agent === executionAgent;
  });
  // Per-account in-flight lock: each account has ONE stored sticky proxy session (Oxylabs sessid). Concurrent connections to one sticky session get refused with ERR_TUNNEL_CONNECTION_FAILED. Serialize per-account; deferred rows pick up next tick. Ignore rows older than 30 min — those are stuck-poison from killed workers and should not block their account forever.
  const inflightAccounts = new Set<string>();
  if (candidates.length) {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await fetch(`${DATABASE_URL}/rest/v1/account_action_logs?select=account_id,claimed_at&status=eq.running&claimed_at=gte.${cutoff}`, { headers: headers() });
    if (r.ok) for (const row of (await r.json()) as { account_id: string | null }[]) if (row.account_id) inflightAccounts.add(row.account_id);
  }
  const staleAccounts = await staleCookieAccounts(candidates);
  // Trading scrapes run with proxy_url_override='direct' (no sticky-session
  // proxy), so the per-account in-flight lock that protects Oxylabs sessids
  // does not apply. Allowing N workers to claim concurrent *_scrape rows
  // for the same sentinel account is what makes parallel trading scrapes
  // possible. Social actions still get the lock because they share an
  // Oxylabs sticky session per account.
  // Account-less actions the worker may claim: account creation, proxy provider
  // balance/topup, and infra maintenance (resend_verify_domain_status health check
  // + the slack_post_message alert it chains), plus analytics-service browser
  // actions that use service credentials rather than a social account row.
  // Everything else without an account is a poison orphan and is skipped.
  const isOverleafAction = (a: string) => a.startsWith('overleaf_');
  const canRunWithoutAccount = (a: string) => /_register$|_balance$|_topup$|_reauth$|_verify_domain_status$|_post_message$/.test(a) || a === 'slack_provision_user_token' || a === 'pangram_analyze_text' || a === 'ncbr_pangram_audit_new_wniosek' || a === 'generic_browser_task' || a === 'generic_keeper_task' || a === 'generic_saved_task' || a === 'semanticscholar_key_followup' || isOverleafAction(a) || /^(umami|googleanalytics)_/.test(a);
  for (const row of candidates) {
    if (!resolveTrajectory(row.action)) continue;
    if (!row.id) continue;
    if (!row.account_id && !canRunWithoutAccount(row.action)) continue; // poison rows: legacy promote-cron sometimes emits orphans
    if (row.account_id && inflightAccounts.has(row.account_id) && !isParallelSafeScrape(row.action)) continue;
    // staleAccounts blocks non-recovery actions; recovery actions (login,
    // register, health, balance, topup) MUST run to refresh stale cookies
    // — without this carve-out, _login rows for stale accounts get blocked
    // by the same flag they exist to clear, and the account stays dead.
    // (Same intent as the filter at stale.ts:31, applied per-row here.)
    if (row.account_id && staleAccounts.has(row.account_id) && !recoveryRe.test(row.action)) continue;

    const claim = await fetch(
      `${DATABASE_URL}/rest/v1/account_action_logs?id=eq.${row.id}&status=eq.queued`,
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
