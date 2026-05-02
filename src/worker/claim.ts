// Atomic queue-claim helper. Extracted from poll.ts to keep that file
// under the 300-line cap.

import type { ActionLogRow } from './poll.js';
import { resolveTrajectory } from './dispatch.js';
import { staleCookieAccounts } from './stale.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const INSTANCE_ID = process.env.INSTANCE_ID ?? `weles-${process.pid}`;

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

export async function claimOne(): Promise<ActionLogRow | null> {
  // Lookahead 100 rows so the in-flight per-account lock can find a claimable row even when the first dozen queued items all belong to one in-flight account (common: a verification batch enqueues 10+ rows for one account; with limit=10 the worker would idle until those drained).
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/account_action_logs?select=id,account_id,action,platform,params,status&status=eq.queued&or=(scheduled_at.is.null,scheduled_at.lte.now())&order=scheduled_at.asc.nullsfirst&limit=100`,
    { headers: headers() },
  );
  if (!res.ok) return null;
  const candidates = (await res.json()) as ActionLogRow[];
  // Per-account in-flight lock: each account has ONE stored sticky proxy session (Oxylabs sessid). Concurrent connections to one sticky session get refused with ERR_TUNNEL_CONNECTION_FAILED. Serialize per-account; deferred rows pick up next tick. Ignore rows older than 30 min — those are stuck-poison from killed workers and should not block their account forever.
  const inflightAccounts = new Set<string>();
  if (candidates.length) {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?select=account_id,claimed_at&status=eq.running&claimed_at=gte.${cutoff}`, { headers: headers() });
    if (r.ok) for (const row of (await r.json()) as { account_id: string | null }[]) if (row.account_id) inflightAccounts.add(row.account_id);
  }
  const staleAccounts = await staleCookieAccounts(candidates);
  for (const row of candidates) {
    if (!resolveTrajectory(row.action)) continue;
    if (!row.account_id || !row.id) continue; // poison rows: legacy promote-cron sometimes emits orphans
    if (inflightAccounts.has(row.account_id)) continue;
    if (staleAccounts.has(row.account_id)) continue;

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
