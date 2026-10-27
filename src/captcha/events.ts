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
  provider: string; // anticaptcha | capsolver | capmonster | twocaptcha | nocaptcha | '' (marker)
  resource: string; // task_type: recaptcha_v2 | hcaptcha | funcaptcha | perimeterx | turnstile | ...
  outcome: CaptchaOutcome;
  cost_usd?: number; // solved only: the price the cost table gave; no service is paid for a marker
  ts: string; // ISO timestamp
  causes?: string[]; // all_failed only: each service tried and why it did not solve
}

// Module-level: one process == one run == one trajectory, so a module-level
// array is per-run by construction (the worker spawns a fresh process per row).
const EVENTS: CaptchaEvent[] = [];
let CHALLENGE_FACED = false;

/**
 * Record a successful solve. Called from the cost tracker's recordCaptcha. A
 * price that is not a finite number is refused naming the service and task,
 * never logged as a free solve.
 */
export function recordCaptchaSolved(
  provider: string,
  resource: string,
  cost_usd: number,
): void {
  if (!Number.isFinite(cost_usd)) {
    throw new Error(
      `the cost table priced the ${provider} ${resource} solve at ${cost_usd}, not a number of dollars`,
    );
  }
  CHALLENGE_FACED = true;
  EVENTS.push({
    provider: String(provider),
    resource: String(resource),
    outcome: 'solved',
    cost_usd,
    ts: new Date().toISOString(),
  });
}

/**
 * Mark that a challenge was detected/attempted (so challenge_faced flips true
 * even before any provider succeeds). Safe to call repeatedly.
 */
export function markCaptchaChallenge(resource?: string): void {
  CHALLENGE_FACED = true;
  if (resource)
    EVENTS.push({
      provider: '',
      resource: String(resource),
      outcome: 'failed',
      ts: new Date().toISOString(),
    });
}

/**
 * Marker pushed when EVERY configured provider failed for a given challenge, so
 * a failed-captcha run is distinguishable from a no-captcha run in the log.
 * `causes` names each service tried and why it did not solve, so the run log
 * says why the challenge stayed unsolved; an empty list says no service was
 * tried, a proxy the services cannot take being one such case.
 */
export function markAllProvidersFailed(resource: string, causes: string[]): void {
  CHALLENGE_FACED = true;
  EVENTS.push({
    provider: '',
    resource: String(resource),
    outcome: 'all_failed',
    ts: new Date().toISOString(),
    causes: causes.slice(),
  });
}

/** Full per-run snapshot for persistence. */
export function captchaSnapshot(): {
  challenge_faced: boolean;
  events: CaptchaEvent[];
} {
  return { challenge_faced: CHALLENGE_FACED, events: EVENTS.slice() };
}
