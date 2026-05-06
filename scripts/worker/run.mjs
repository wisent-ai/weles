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
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1) || 1);

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
