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
// The humanized input atoms (mouse.ts/keyboard.ts) are now 100%
// native: every move/click/keystroke goes through cliclick, which
// drives the SINGLE host OS cursor+keyboard, and getWindowOffset
// targets `window 1 of process "Chromium"` with no per-loop
// addressing (mouse-native.ts:114-128). Two pollOnce loops running
// human-input trajectories on one host therefore interleave clicks
// and keystrokes into whichever window has OS focus — cross-
// trajectory corruption with no error. The current atoms have no
// CDP path to route around it. So native-input concurrency on one
// host is unsafe; clamp to 1. Pure-scrape trajectories that never
// call the human atoms are serialized too — accepting that
// throughput cost is the conservative correctness-preserving choice
// until per-loop display isolation (separate macOS session /
// virtual display per loop) exists, gated by the explicit
// WELES_ALLOW_UNSAFE_PARALLEL escape hatch.
const _reqConc = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1) || 1);
const CONCURRENCY = process.env.WELES_ALLOW_UNSAFE_PARALLEL === '1' ? _reqConc : 1;
if (_reqConc > 1 && CONCURRENCY === 1) {
  console.log(`[worker] WORKER_CONCURRENCY=${_reqConc} ignored: native cliclick input shares one host OS cursor (mouse-native.ts). Clamped to 1. Set WELES_ALLOW_UNSAFE_PARALLEL=1 only with per-loop display isolation.`);
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
