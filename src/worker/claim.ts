// Atomic queue-claim helper. Extracted from poll.ts to keep that file
// under the 300-line cap.

import type { ActionLogRow } from './poll.js';
import { resolveTrajectory } from './dispatch.js';
import { staleCookieAccounts } from './stale.js';
import os from 'node:os';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const INSTANCE_ID = process.env.INSTANCE_ID ?? `weles-${os.hostname() || 'unknown'}-${process.pid}`;

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

export async function claimOne(): Promise<ActionLogRow | null> {
  // Lookahead 300 rows so the per-account in-flight + stale skip lists don't
  // starve out high-priority recovery rows that sit deep in the queue.
  // Symptom: 36 linkedin_login rows never claimed because the top 100 by
  // scheduled_at were all sim-cron rows (linkedin_browse / dwell / etc).
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/account_action_logs?select=id,account_id,action,platform,params,status&status=eq.queued&or=(scheduled_at.is.null,scheduled_at.lte.now())&order=scheduled_at.asc.nullsfirst&limit=300`,
    { headers: headers() },
  );
  if (!res.ok) return null;
  let candidates = (await res.json()) as ActionLogRow[];
  // Priority sort: recovery rows (*_login, *_register, *_health, *_balance,
  // *_topup) before sim/promote rows. Login mints cookies and unblocks every
  // downstream action for the same account; health detects bans; balance keeps
  // proxies funded. Stable-sort by scheduled_at within each priority tier.
  const recoveryRe = /_(login|register|health|balance|topup)$/;
  const priority = (a: string) => recoveryRe.test(a) ? 0 : 1;
  candidates = candidates
    .map((r, i) => ({ r, i, p: priority(r.action) }))
    .sort((x, y) => x.p - y.p || x.i - y.i)
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
  const isParallelSafeScrape = (a: string) => /^(unusualwhales|volumeleaders|tradingview)_scrape$/.test(a);
  const canRunWithoutAccount = (a: string) => /_register$|_balance$|_topup$/.test(a);
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
