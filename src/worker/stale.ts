// Pre-claim stale-cookie filter. The trajectory marks
// metadata.cookies_stale_at when checkpoint fires; getSocialAccount honours
// the same window for fresh picks. Without this gate the queue chokes —
// already-queued rows for known-stale accounts each burn a Chromium launch
// before failing identically. Always allow register/health (no cookies / probe
// IS the refresh signal).

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const STALE_HOURS = 24;

interface CandidateRow {
  account_id: string | null;
  action: string;
}

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

export async function staleCookieAccounts(candidates: CandidateRow[]): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  const stale = new Set<string>();
  const ids = [...new Set(
    candidates
      .filter((r) => r.account_id && r.action && !r.action.endsWith('_register') && !r.action.endsWith('_health') && !r.action.endsWith('_balance') && !r.action.endsWith('_topup'))
      .map((r) => r.account_id!)
  )].slice(0, 50);
  if (ids.length === 0) return stale;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/social_accounts?id=in.(${ids.join(',')})&select=id,metadata`,
    { headers: headers() },
  );
  if (!res.ok) return stale;
  const rows = await res.json() as { id: string; metadata: { cookies_stale_at?: string } }[];
  for (const r of rows) {
    const t = r.metadata?.cookies_stale_at;
    if (t && t > cutoff) stale.add(r.id);
  }
  return stale;
}
