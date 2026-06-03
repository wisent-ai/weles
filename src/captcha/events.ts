/**
 * G8: per-run captcha event log.
 *
 * A module-level, additive log of every captcha interaction in a run. It does
 * NOT change any solver control flow — the solver and cost tracker merely push
 * events as they already succeed/fail. The accumulated log is written to
 * recordings/<label>/captcha_events.json at session finalize (storage backup)
 * and copied verbatim into account_action_logs.result.captcha by the worker.
 *
 * Distinguishing the three run shapes is the whole point:
 *   - no captcha at all            -> challenge_faced=false, events=[]
 *   - captcha faced and solved     -> challenge_faced=true, a 'solved' event
 *   - captcha faced, all failed    -> challenge_faced=true, an 'all_failed' marker
 */

export type CaptchaOutcome = 'solved' | 'failed' | 'all_failed';

export interface CaptchaEvent {
  provider: string;          // anticaptcha | capsolver | capmonster | twocaptcha | nocaptcha | '' (marker)
  resource: string;          // task_type: recaptcha_v2 | hcaptcha | funcaptcha | perimeterx | turnstile | ...
  outcome: CaptchaOutcome;
  cost_usd: number;          // 0 for failures / markers
  ts: string;                // ISO timestamp
}

// Module-level: one process == one run == one trajectory, so a module-level
// array is per-run by construction (the worker spawns a fresh process per row).
const EVENTS: CaptchaEvent[] = [];
let CHALLENGE_FACED = false;

/** Record a successful solve. Called from the cost tracker's recordCaptcha. */
export function recordCaptchaSolved(provider: string, resource: string, cost_usd: number): void {
  CHALLENGE_FACED = true;
  EVENTS.push({ provider: String(provider), resource: String(resource), outcome: 'solved', cost_usd: Number.isFinite(cost_usd) ? cost_usd : 0, ts: new Date().toISOString() });
}

/**
 * Mark that a challenge was detected/attempted (so challenge_faced flips true
 * even before any provider succeeds). Safe to call repeatedly.
 */
export function markCaptchaChallenge(resource?: string): void {
  CHALLENGE_FACED = true;
  if (resource) EVENTS.push({ provider: '', resource: String(resource), outcome: 'failed', cost_usd: 0, ts: new Date().toISOString() });
}

/**
 * Marker pushed when EVERY configured provider failed for a given challenge, so
 * a failed-captcha run is distinguishable from a no-captcha run in the log.
 */
export function markAllProvidersFailed(resource: string): void {
  CHALLENGE_FACED = true;
  EVENTS.push({ provider: '', resource: String(resource), outcome: 'all_failed', cost_usd: 0, ts: new Date().toISOString() });
}

/** Full per-run snapshot for persistence. */
export function captchaSnapshot(): { challenge_faced: boolean; events: CaptchaEvent[] } {
  return { challenge_faced: CHALLENGE_FACED, events: EVENTS.slice() };
}
