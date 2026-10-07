import { readSetting, writeSetting } from '../state/skarbiec-records.js';
import declaredProviders from './data/providers.json';

/**
 * Cost × capability proxy selection.
 *
 * Replaces the hardcoded toxicity table + deterministic-hash-to-provider
 * logic in credentials.ts. The model is deliberately simple:
 *
 *   matrix[provider][action] = 'pass' | 'fail' | 'unknown'
 *
 * When zero providers pass for a given platform, we persist the pause in
 * Skarbiec so generic-routine refuses new actions until a provider recovers.
 *
 * The matrix is populated from real production outcomes:
 *   pass = status=completed AND signal IN healthy-set
 *   fail = signal IN {ip_blocked, captcha_challenge, blocked, suspended,
 *                     shadowbanned, proxy_auth_failed}
 *   no update = anything else (script error etc.)
 *
 * Storage: Weles runtime-setting items in Skarbiec:
 *   - proxy_capability_matrix
 *   - proxy_rate_cards
 *   - platform_routine_paused
 */

// Every provider Weles can route through, from `data/providers.json` beside
// this file. Prices come only from the `proxy_rate_cards` Skarbiec setting: a
// rate written in code went stale the day a provider changed its price, and it
// silently priced a provider nobody had chosen. A provider the rate card says
// nothing about is not ranked, and `rankByCapability` names it as unpriced.
export const ALL_PROVIDERS = declaredProviders.providers as readonly string[];
export type ProviderName = string;

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

interface MatrixCell {
  result: 'pass' | 'fail';
  at: string;
}
interface MatrixValue {
  matrix: Record<string, Record<string, MatrixCell>>;
}
interface RatesValue {
  rates: Record<string, { per_gb: number }>;
}
interface PausedValue {
  [platform: string]: { paused_at: string; reason: string };
}

// Each setting is read on every question, never from a copy: an outcome another
// worker recorded a moment ago decides this selection.
async function loadSetting<T>(key: string, fallback: T): Promise<T> {
  return readSetting<T>(key, fallback);
}

async function saveSetting<T>(key: string, value: T): Promise<void> {
  writeSetting(key, value);
}

async function loadMatrix(): Promise<MatrixValue> {
  return loadSetting<MatrixValue>('proxy_capability_matrix', { matrix: {} });
}

async function loadPaused(): Promise<PausedValue> {
  return loadSetting<PausedValue>('platform_routine_paused', {});
}

/** One provider a route may use, in the order to try it. */
export interface RankedProvider {
  provider: ProviderName;
  cost_per_gb: number;
  standing: 'pass' | 'platform_pass' | 'unknown';
}

/**
 * Every provider that may carry `action`, best first, and why each other one
 * may not: `failing` names the providers the matrix records as failing this
 * action (or, untried here, failing every action of its platform), and
 * `unpriced` the ones `proxy_rate_cards` gives no rate. A caller tries the
 * candidates in order until one resolves an exit, and when none does says
 * all three lists, so an empty rate card reads as that rather than as
 * "nothing passes".
 *
 * Order: exact action passes, then same-platform passes, then providers with
 * no history (each is tried at most until its first outcome rules it in or
 * out); cheapest first inside a tier.
 */
export async function rankByCapability(action: string): Promise<{
  candidates: RankedProvider[];
  failing: ProviderName[];
  unpriced: ProviderName[];
}> {
  const [matrix, rates] = await Promise.all([
    loadMatrix(),
    loadSetting<RatesValue>('proxy_rate_cards', { rates: {} }),
  ]);
  const platformPrefix = action.includes('_') ? `${action.split('_')[0]}_` : '';
  const candidates: RankedProvider[] = [];
  const failing: ProviderName[] = [];
  const unpriced: ProviderName[] = [];
  for (const p of ALL_PROVIDERS) {
    const providerCells = matrix.matrix[p] ?? {};
    const cell = providerCells[action]?.result;
    const platformCells = platformPrefix
      ? Object.entries(providerCells).filter(([act]) =>
          act.startsWith(platformPrefix),
        )
      : [];
    const hasPlatformPass = platformCells.some(
      ([, platformCell]) => platformCell.result === 'pass',
    );
    const hasPlatformFail = platformCells.some(
      ([, platformCell]) => platformCell.result === 'fail',
    );
    const rate = rates.rates?.[p]?.per_gb;
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      unpriced.push(p);
      continue;
    }
    if (cell === 'fail') failing.push(p);
    else if (cell === 'pass')
      candidates.push({ provider: p, cost_per_gb: rate, standing: 'pass' });
    else if (hasPlatformPass)
      candidates.push({
        provider: p,
        cost_per_gb: rate,
        standing: 'platform_pass',
      });
    else if (hasPlatformFail) failing.push(p);
    else
      candidates.push({ provider: p, cost_per_gb: rate, standing: 'unknown' });
  }
  const tiers: RankedProvider['standing'][] = [
    'pass',
    'platform_pass',
    'unknown',
  ];
  candidates.sort((a, b) =>
    a.standing === b.standing
      ? a.cost_per_gb - b.cost_per_gb
      : tiers.indexOf(a.standing) - tiers.indexOf(b.standing),
  );
  return { candidates, failing, unpriced };
}

/**
 * The sentence a route that found no exit ends with: which providers were
 * tried and resolved none, which fail this action, and which carry no rate.
 */
export function noExitCause(
  action: string,
  tried: ProviderName[],
  failing: ProviderName[],
  unpriced: ProviderName[],
): string {
  const named = (list: ProviderName[]) =>
    list.length ? list.join(', ') : 'none';
  return `no proxy exit for ${action}: tried without an exit: ${named(tried)}; failing this action in proxy_capability_matrix: ${named(failing)}; no rate in the proxy_rate_cards setting: ${named(unpriced)}`;
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
  else if (status === 'completed' && (HEALTHY_SIGNALS.has(sig) || sig === ''))
    result = 'pass';
  if (!result) return;

  const v = await loadMatrix();
  const at = new Date().toISOString();
  v.matrix[provider] ??= {};
  v.matrix[provider][action] = { result, at };
  await saveSetting('proxy_capability_matrix', v);
  console.log(
    `[capability] +${provider}/${action} = ${result} (signal=${sig || 'none'})`,
  );

  // Circuit-breaker: if every provider for this platform is now 'fail' for
  // this action, raise platform_routine_paused. If at least one is 'pass'
  // again, clear the flag. We only check "any pass for this platform" by
  // looking at all actions starting with `${platform}_` — a single passing
  // (provider, anything-on-this-platform) cell means the proxy can still
  // do the platform, which is good enough for the breaker.
  if (!platform) return;
  const someoneWorks = ALL_PROVIDERS.some((p) =>
    Object.entries(v.matrix[p] ?? {}).some(
      ([act, cell]) => act.startsWith(`${platform}_`) && cell.result === 'pass',
    ),
  );
  const paused = await loadPaused();
  if (!someoneWorks && !paused[platform]) {
    paused[platform] = {
      paused_at: at,
      reason: `no proxy passes for any ${platform}_* action`,
    };
    await saveSetting('platform_routine_paused', paused);
    console.log(`[capability] CIRCUIT-BREAKER: paused platform=${platform}`);
  } else if (someoneWorks && paused[platform]) {
    delete paused[platform];
    await saveSetting('platform_routine_paused', paused);
    console.log(`[capability] CIRCUIT-BREAKER: cleared platform=${platform}`);
  }
}

export interface TaskNetworkRequirements {
  route: 'direct' | 'proxy';
  proxyType?: 'isp' | 'residential' | 'mobile';
  country?: string;
  reason: string;
}

const DIRECT_EGRESS_PLATFORMS: Readonly<Record<string, true>> = Object.freeze({
  github: true,
  producthunt: true,
  pangram: true,
});

/**
 * Resolve network capabilities from task identity instead of allowing
 * trajectories to improvise fallback behavior. Account-bound platforms use a
 * stable ISP route; platforms that accept worker egress stay direct unless an
 * operator explicitly forces a proxy.
 */
export function taskNetworkRequirements(
  action: string,
  platform: string,
): TaskNetworkRequirements {
  const normalizedPlatform = platform.trim().toLowerCase();
  if (DIRECT_EGRESS_PLATFORMS[normalizedPlatform]) {
    return {
      route: 'direct',
      reason: `direct egress is sufficient for ${normalizedPlatform || action}`,
    };
  }
  return {
    route: 'proxy',
    proxyType: 'isp',
    country: normalizedPlatform === 'discord' ? undefined : 'us',
    reason: `stable account-bound egress required for ${action || normalizedPlatform}`,
  };
}

/** Returns true if generic-routine should skip enqueueing for this platform. */
export async function isPlatformPaused(platform: string): Promise<boolean> {
  const paused = await loadPaused();
  return !!paused[platform];
}

/** Returns true if the matrix marks this (provider, action) cell as 'fail'. */
export async function isCellFail(
  provider: string,
  action: string,
): Promise<boolean> {
  const m = await loadMatrix();
  return m.matrix[provider]?.[action]?.result === 'fail';
}
