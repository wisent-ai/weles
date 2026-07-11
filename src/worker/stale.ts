import { INSTANCE_ID } from './identity.js';

// Pre-claim stale-cookie filter. The trajectory marks
// metadata.cookies_stale_at when checkpoint fires; getSocialAccount honours
// the same window for fresh picks. Without this gate the queue chokes —
// already-queued rows for known-stale accounts each burn a Chromium launch
// before failing identically. Always allow register/health (no cookies / probe
// IS the refresh signal).

export const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const STALE_HOURS = 24;

interface CandidateRow {
  account_id: string | null;
  action: string;
}

export function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

export async function staleCookieAccounts(candidates: CandidateRow[]): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  const stale = new Set<string>();
  // `_login` is the cookies-stale recovery path — it MUST run when an
  // account is stale (that's literally why the auto-recovery enqueues it).
  // Excluding it means stale accounts have their refresh attempts blocked
  // by the same flag that triggered the refresh, and the account stays
  // dead forever. Same logic for register/health/balance/topup.
  const ids = [...new Set(
    candidates
      .filter((r) => r.account_id && r.action && !r.action.endsWith('_register') && !r.action.endsWith('_login') && !r.action.endsWith('_health') && !r.action.endsWith('_balance') && !r.action.endsWith('_topup'))
      .map((r) => r.account_id!)
  )].slice(0, 50);
  if (ids.length === 0) return stale;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/social_accounts?id=in.(${ids.join(',')})&select=id,metadata`,
    { headers: headers() },
  );
  if (!res.ok) return stale;
  const rows = await res.json() as { id: string; metadata: { cookies_stale_at?: string; cookies_minted_at?: string } }[];
  for (const r of rows) {
    const t = r.metadata?.cookies_stale_at;
    if (!t || t <= cutoff) continue;
    // Honor mint over stale: a successful re-login since the stale mark
    // overrides it. Without this, the worker pre-claim filter keeps skipping
    // accounts that just refreshed their cookies — same paradox the routine
    // and getSocialAccount had before commit 4796d1e.
    const mint = r.metadata?.cookies_minted_at;
    if (mint && mint >= t) continue;
    stale.add(r.id);
  }
  return stale;
}

// Sweep zombie running rows. account_action_logs left in status=running for
// over 2h are workers killed mid-trajectory (SIGKILL, OOM, network drop).
// They sit forever, polluting dashboards and blocking the per-account 30-min
// in-flight slot. Throttled to once per 5 min across all workers' polls.
let _lastSweep = 0;
export async function sweepZombiesIfDue(): Promise<void> {
  armWedgeWatchdog();
  if (Date.now() - _lastSweep < 5 * 60_000) return;
  _lastSweep = Date.now();
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const cutoffMs = Date.now() - 2 * 3600_000;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?status=eq.running&select=id,action,claimed_by,claimed_at,started_at&limit=500`, { headers: headers() });
    if (!r.ok) return;
    const rows = (await r.json()) as Array<{ id: string; action: string; claimed_by: string | null; claimed_at: string | null; started_at: string | null }>;
    const stale = rows.filter((row) => {
      const raw = row.claimed_at ?? row.started_at;
      const t = raw ? Date.parse(raw) : NaN;
      return !Number.isFinite(t) || t < cutoffMs;
    });
    for (const row of stale) {
      await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${row.id}&status=eq.running`, {
        method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed', error: `orphaned: claimed_by ${row.claimed_by ?? '?'} stopped responding (>2h)`, completed_at: new Date().toISOString() }),
      }).catch(() => {});
      console.log(`[worker] zombie sweep: failed ${row.id.slice(0, 8)} action=${row.action} (claimed_by=${row.claimed_by})`);
    }
  } catch { /* best-effort */ }
}


// Independent wedge-watchdog. runTrajectory (poll.ts) has no wall-clock kill and
// account_action_logs has no cancel_requested column, so a hung trajectory
// subprocess blocks its poll loop with no way out; once every concurrent slot is
// wedged the worker claims nothing while the deployment-version heartbeat keeps
// ticking (the day-scale silent-idle bug diagnosed on the mac-mini worker). This
// runs on its OWN interval, NOT inside the wedged poll loop, and when this
// instance's own running rows have ALL been stuck past the hard cap (every slot
// wedged) it SIGKILLs itself so launchd (KeepAlive) restarts the job — which reaps
// the wedged process group and lets the fresh worker's zombie sweep re-queue the
// stuck rows. Values are env-tunable; armed once from the first sweep (startup).
const HARD_CAP_MS = Number(process.env.WELES_TRAJECTORY_HARD_CAP_MS ?? '1800000');
const WEDGE_CHECK_MS = Number(process.env.WELES_WEDGE_CHECK_MS ?? '120000');
const SLOT_COUNT = Number(process.env.WORKER_CONCURRENCY ?? '1');
let _watchdogArmed = false;
function armWedgeWatchdog(): void {
  if (_watchdogArmed) return;
  _watchdogArmed = true;
  const t = setInterval(() => { void checkWedge(); }, WEDGE_CHECK_MS);
  t.unref();
}
async function checkWedge(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const cutoff = new Date(Date.now() - HARD_CAP_MS).toISOString();
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/account_action_logs?status=eq.running&claimed_by=eq.${encodeURIComponent(INSTANCE_ID)}&claimed_at=lt.${cutoff}&select=id&limit=${SLOT_COUNT}`,
      { headers: headers() },
    );
    if (!r.ok) return;
    const stuck = (await r.json()) as Array<{ id: string }>;
    if (stuck.length >= SLOT_COUNT) {
      console.error(`[worker] wedge-watchdog: ${stuck.length} running rows for ${INSTANCE_ID} stuck past the hard cap (every one of the ${SLOT_COUNT} slots wedged on hung trajectories); SIGKILLing self for launchd restart`);
      process.kill(process.pid, 'SIGKILL');
    }
  } catch { /* next tick re-checks */ }
}

// Startup orphan reclaim. account_action_logs rows are tagged claimed_by =
// INSTANCE_ID (on the mac-mini that is the fixed "mac-mini-worker" — the same
// identity the wedge-watchdog matches with claimed_by=eq). launchd runs ONE
// instance, so at startup THIS process has claimed nothing yet and every
// status=running row still tagged with our own INSTANCE_ID is a zombie the dead
// predecessor left behind. Fail them BEFORE the poll loops start — otherwise
// they keep counting as wedged slots and the wedge-watchdog SIGKILLs the fresh
// worker within one check interval (the ~2-minute crash loop that stopped
// apple_login — and every other run — from ever finishing). Runs once per process.
const RECLAIM_LIMIT = process.env.WELES_ORPHAN_RECLAIM_LIMIT ?? '500';
let _orphanReclaimed = false;
export async function reclaimOrphansOnce(): Promise<void> {
  if (_orphanReclaimed) return;
  _orphanReclaimed = true;
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/account_action_logs?status=eq.running&claimed_by=eq.${encodeURIComponent(INSTANCE_ID)}&select=id,action&limit=${RECLAIM_LIMIT}`,
    { headers: headers() },
  );
  if (!res.ok) { console.error(`[worker] orphan reclaim: candidate query failed ${res.status}`); return; }
  const rows = (await res.json()) as Array<{ id: string; action: string }>;
  console.log(`[worker] orphan reclaim: ${rows.length} zombie row(s) tagged ${INSTANCE_ID} to fail at startup`);
  for (const row of rows) {
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${row.id}&status=eq.running`, {
      method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'failed', error: `orphaned: ${INSTANCE_ID} predecessor died before completing (startup reclaim)`, completed_at: new Date().toISOString() }),
    });
    if (!patch.ok) { console.error(`[worker] orphan reclaim: update ${row.id} rejected ${patch.status}`); continue; }
    console.log(`[worker] orphan reclaim: failed ${row.id} action=${row.action}`);
  }
}
