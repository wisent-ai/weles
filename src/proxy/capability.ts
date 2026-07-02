/**
 * Cost × capability proxy selection.
 *
 * Replaces the hardcoded toxicity table + deterministic-hash-to-provider
 * logic in credentials.ts. The model is deliberately simple:
 *
 *   matrix[provider][action] = 'pass' | 'fail' | 'unknown'
 *
 * "Pass" cells are eligible. Among eligible providers we pick the cheapest
 * by $/GB (rate cards). When zero providers pass for a given platform, we
 * raise the circuit breaker via system_settings.platform_routine_paused
 * so generic-routine refuses to enqueue actions until at least one provider
 * comes back.
 *
 * The matrix is populated from real production outcomes:
 *   pass = status=completed AND signal IN healthy-set
 *   fail = signal IN {ip_blocked, captcha_challenge, blocked, suspended,
 *                     shadowbanned, proxy_auth_failed}
 *   no update = anything else (script error etc.)
 *
 * Storage: system_settings rows
 *   - proxy_capability_matrix : { matrix: { [provider]: { [action]: { result, at } } } }
 *   - proxy_rate_cards        : { rates:  { [provider]: { per_gb } } }     (defaults below if missing)
 *   - platform_routine_paused : { [platform]: { paused_at, reason } }       (default empty)
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// Rate cards. DB row at system_settings.proxy_rate_cards overrides.
// Verified 2026-04-29 from each provider's pricing page. PacketStream is
// pay-as-you-go residential, Pingproxies/IPRoyal residential pools.
// Update if any provider's published rate changes.
const DEFAULT_RATES: Record<string, { per_gb: number }> = {
  oxylabs:      { per_gb: 4.00 },
  brightdata:   { per_gb: 5.04 },
  pingproxies:  { per_gb: 1.50 },
  iproyal:      { per_gb: 1.75 },
  packetstream: { per_gb: 1.00 },
};

export const ALL_PROVIDERS = ['oxylabs', 'packetstream', 'pingproxies', 'iproyal', 'brightdata'] as const;
export type ProviderName = (typeof ALL_PROVIDERS)[number];

const HEALTHY_SIGNALS = new Set<string>([
  'healthy',
  'allowed_action_completed',
  'passive_browse_complete',
  'organic_comment_completed',
  'dwell_complete',
  'search_complete',
  'login_succeeded',
  'register_succeeded',
  'profile_view_complete',
  'notifications_complete',
]);

const FAIL_SIGNALS = new Set<string>([
  'ip_blocked',
  'captcha_challenge',
  'blocked',
  'suspended',
  'shadowbanned',
  'proxy_auth_failed',
]);

interface MatrixCell { result: 'pass' | 'fail'; at: string }
interface MatrixValue { matrix: Record<string, Record<string, MatrixCell>> }
interface RatesValue { rates: Record<string, { per_gb: number }> }
interface PausedValue { [platform: string]: { paused_at: string; reason: string } }

const CACHE_TTL_MS = 60_000;
let _matrixCache: { v: MatrixValue; at: number } | null = null;
let _ratesCache: { v: RatesValue; at: number } | null = null;
let _pausedCache: { v: PausedValue; at: number } | null = null;

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
}

async function loadSetting<T>(key: string, fallback: T): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return fallback;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?key=eq.${key}&select=value`, { headers: headers() });
    if (!res.ok) return fallback;
    const rows = await res.json() as { value: T }[];
    return rows[0]?.value ?? fallback;
  } catch { return fallback; }
}

async function saveSetting<T>(key: string, value: T): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/system_settings?on_conflict=key`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value }),
    });
  } catch { /* best-effort */ }
}

async function loadMatrix(): Promise<MatrixValue> {
  if (_matrixCache && Date.now() - _matrixCache.at < CACHE_TTL_MS) return _matrixCache.v;
  const v = await loadSetting<MatrixValue>('proxy_capability_matrix', { matrix: {} });
  _matrixCache = { v, at: Date.now() };
  return v;
}

async function loadRates(): Promise<RatesValue> {
  if (_ratesCache && Date.now() - _ratesCache.at < CACHE_TTL_MS) return _ratesCache.v;
  const v = await loadSetting<RatesValue>('proxy_rate_cards', { rates: {} });
  // Merge DB overrides on top of defaults so a half-populated DB row still
  // returns a complete rate card.
  const rates = { ...DEFAULT_RATES, ...(v.rates ?? {}) };
  const merged = { rates };
  _ratesCache = { v: merged, at: Date.now() };
  return merged;
}

async function loadPaused(): Promise<PausedValue> {
  if (_pausedCache && Date.now() - _pausedCache.at < CACHE_TTL_MS) return _pausedCache.v;
  const v = await loadSetting<PausedValue>('platform_routine_paused', {});
  _pausedCache = { v, at: Date.now() };
  return v;
}

/**
 * Pick the cheapest provider whose matrix cell for this action is 'pass'.
 * If the action has no direct pass history, prefer providers with any pass
 * for the same platform before trying providers with no platform history.
 *
 * Returns null when the matrix is empty for this action (cold start) AND
 * unknown providers should default to eligible ('unknown'-as-pass), OR when
 * literally zero providers are usable. Caller distinguishes via the result:
 * null + already-paused = stay paused, null + not-paused = pause and skip.
 *
 * Cold-start policy: an unknown cell is treated as eligible. A provider with
 * no history will be picked at most once before its first outcome rules it
 * in or out. Combined with the per-action_log circuit breaker (the worker
 * still attempts the action even when null) this self-bootstraps the matrix
 * within a few cycles instead of needing a manual seed run per (provider,
 * action) pair.
 */
export async function selectByCapability(
  action: string,
  excludeProviders: string[] = [],
): Promise<{ provider: ProviderName; cost_per_gb: number } | null> {
  const [matrix, rates] = await Promise.all([loadMatrix(), loadRates()]);
  const exclude = new Set(excludeProviders);
  const platformPrefix = action.includes('_') ? `${action.split('_')[0]}_` : '';
  const candidates: Array<{ p: ProviderName; cost: number; cell: 'pass' | 'platform_pass' | 'unknown' }> = [];
  for (const p of ALL_PROVIDERS) {
    if (exclude.has(p)) continue;
    const providerCells = matrix.matrix[p] ?? {};
    const cell = providerCells[action]?.result;
    if (cell === 'fail') continue;
    const platformCells = platformPrefix
      ? Object.entries(providerCells).filter(([act]) => act.startsWith(platformPrefix))
      : [];
    const hasPlatformPass = platformCells.some(([, platformCell]) => platformCell.result === 'pass');
    const hasPlatformFail = platformCells.some(([, platformCell]) => platformCell.result === 'fail');
    const cost = rates.rates[p]?.per_gb ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(cost)) continue;
    if (cell === 'pass') candidates.push({ p, cost, cell: 'pass' });
    else if (hasPlatformPass) candidates.push({ p, cost, cell: 'platform_pass' });
    else if (!hasPlatformFail) candidates.push({ p, cost, cell: 'unknown' });
  }
  if (candidates.length === 0) return null;
  // Prefer exact action passes, then same-platform passes, then cold-start
  // unknowns; among same tier, cheapest.
  const rank: Record<(typeof candidates)[number]['cell'], number> = { pass: 0, platform_pass: 1, unknown: 2 };
  candidates.sort((a, b) => {
    if (a.cell !== b.cell) return rank[a.cell] - rank[b.cell];
    return a.cost - b.cost;
  });
  const winner = candidates[0];
  return { provider: winner.p, cost_per_gb: winner.cost };
}

/**
 * Record the outcome of an action against the (provider, action) cell.
 * Called from the worker pool after each action run resolves.
 *
 * - signal in HEALTHY_SIGNALS or absent + status=completed -> 'pass'
 * - signal in FAIL_SIGNALS                                 -> 'fail'
 * - everything else (script error, unknown_error, etc.)    -> no update
 */
export async function recordOutcome(
  provider: string | undefined,
  action: string,
  status: 'completed' | 'failed' | 'pending_review',
  signal: string | undefined,
  platform: string | undefined,
): Promise<void> {
  if (!provider || !action) return;
  const sig = signal ?? '';
  if (status === 'pending_review') return;
  let result: 'pass' | 'fail' | null = null;
  if (FAIL_SIGNALS.has(sig)) result = 'fail';
  else if (status === 'completed' && (HEALTHY_SIGNALS.has(sig) || sig === '')) result = 'pass';
  if (!result) return;

  const v = await loadMatrix();
  const at = new Date().toISOString();
  v.matrix[provider] ??= {};
  v.matrix[provider][action] = { result, at };
  await saveSetting('proxy_capability_matrix', v);
  _matrixCache = { v, at: Date.now() };
  console.log(`[capability] +${provider}/${action} = ${result} (signal=${sig || 'none'})`);

  // Circuit-breaker: if every provider for this platform is now 'fail' for
  // this action, raise platform_routine_paused. If at least one is 'pass'
  // again, clear the flag. We only check "any pass for this platform" by
  // looking at all actions starting with `${platform}_` — a single passing
  // (provider, anything-on-this-platform) cell means the proxy can still
  // do the platform, which is good enough for the breaker.
  if (!platform) return;
  const someoneWorks = ALL_PROVIDERS.some(p =>
    Object.entries(v.matrix[p] ?? {}).some(([act, cell]) => act.startsWith(`${platform}_`) && cell.result === 'pass'),
  );
  const paused = await loadPaused();
  if (!someoneWorks && !paused[platform]) {
    paused[platform] = { paused_at: at, reason: `no proxy passes for any ${platform}_* action` };
    await saveSetting('platform_routine_paused', paused);
    _pausedCache = { v: paused, at: Date.now() };
    console.log(`[capability] CIRCUIT-BREAKER: paused platform=${platform}`);
  } else if (someoneWorks && paused[platform]) {
    delete paused[platform];
    await saveSetting('platform_routine_paused', paused);
    _pausedCache = { v: paused, at: Date.now() };
    console.log(`[capability] CIRCUIT-BREAKER: cleared platform=${platform}`);
  }
}

/** Returns true if generic-routine should skip enqueueing for this platform. */
export async function isPlatformPaused(platform: string): Promise<boolean> {
  const paused = await loadPaused();
  return !!paused[platform];
}

/** Returns true if the matrix marks this (provider, action) cell as 'fail'. */
export async function isCellFail(provider: string, action: string): Promise<boolean> {
  const m = await loadMatrix();
  return m.matrix[provider]?.[action]?.result === 'fail';
}
