#!/usr/bin/env node
/**
 * Long-running Node worker. Polls account_action_logs and runs the
 * corresponding weles trajectory. Replaces the Python worker_pool for every
 * action that maps to a weles trajectory. Start with:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/worker/run.mjs
 *
 * Parallelism: WORKER_CONCURRENCY env (default 1) controls the number of
 * concurrent pollOnce loops within this single Node process. Each loop
 * independently claims rows; the atomic PATCH at claim.ts:56-65 makes
 * concurrent claims race-safe. Trading scrapes also bypass the per-account
 * lock at claim.ts:48 so N loops can run scrape rows for the same sentinel
 * account_id in parallel.
 */
import { pollOnce } from '../../dist/worker/poll.js';

let shuttingDown = false;
const stop = () => { shuttingDown = true; console.log('[worker] shutting down'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const IDLE_MIN_MS = 3000;
const IDLE_MAX_MS = 8000;
const ERROR_BACKOFF_MS = 15000;
// Concurrency safety depends on the input transport:
//  - WELES_INPUT=cdp: human atoms dispatch via per-page Playwright
//    mouse/keyboard into each WSession's own browser context — no
//    shared host resource, so N loops are collision-free. Honor
//    WORKER_CONCURRENCY as requested.
//  - native (default): every move/click/keystroke is cliclick,
//    driving the SINGLE host OS cursor; getWindowOffset targets
//    `window 1 of process Chromium` with no per-loop addressing
//    (mouse-native.ts:114-128). N>1 loops interleave input into
//    whichever window has OS focus — cross-trajectory corruption
//    with no error. Clamp to 1 unless WELES_ALLOW_UNSAFE_PARALLEL=1
//    (reserved for per-loop display isolation: separate macOS
//    session / virtual display per loop).
// Anti-fraud-sensitive labels (LinkedIn /apfc-class) must run
// native and therefore single-flight on their own host; labels
// without an OS-event collector should set WELES_INPUT=cdp to
// parallelize (claude reauth already does, in reauth.mjs).
const _reqConc = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1) || 1);
const _cdp = process.env.WELES_INPUT === 'cdp';
const _safe = _cdp || process.env.WELES_ALLOW_UNSAFE_PARALLEL === '1';
const CONCURRENCY = _safe ? _reqConc : 1;
if (_reqConc > 1 && CONCURRENCY === 1) {
  console.log(`[worker] WORKER_CONCURRENCY=${_reqConc} clamped to 1: native cliclick input shares one host OS cursor (mouse-native.ts). Set WELES_INPUT=cdp (per-page, parallel-safe) for non-anti-fraud labels, or WELES_ALLOW_UNSAFE_PARALLEL=1 with per-loop display isolation.`);
}

async function loop(slot) {
  while (!shuttingDown) {
    let outcome = 'error';
    try { outcome = await pollOnce(); }
    catch (e) { console.error(`[worker:${slot}] pollOnce threw:`, e?.message ?? e); }
    if (shuttingDown) break;
    if (outcome === 'idle') {
      const delay = IDLE_MIN_MS + Math.floor(Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS));
      await new Promise((r) => setTimeout(r, delay));
    } else if (outcome === 'error') {
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
}

console.log(`[worker] starting ${CONCURRENCY} concurrent pollOnce loops`);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => loop(i)));
console.log('[worker] exited');
