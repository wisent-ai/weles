#!/usr/bin/env node
/**
 * Long-running Node worker. Polls account_action_logs and runs the
 * corresponding weles trajectory. Replaces the Python worker_pool for every
 * action that maps to a weles trajectory. Start with:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/worker/run.mjs
 */
import { pollOnce } from '../../dist/worker/poll.js';

let shuttingDown = false;
const stop = () => { shuttingDown = true; console.log('[worker] shutting down'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const IDLE_MIN_MS = 3000;
const IDLE_MAX_MS = 8000;
const ERROR_BACKOFF_MS = 15000;

while (!shuttingDown) {
  let outcome = 'error';
  try { outcome = await pollOnce(); }
  catch (e) { console.error('[worker] pollOnce threw:', e?.message ?? e); }
  if (shuttingDown) break;
  if (outcome === 'idle') {
    const delay = IDLE_MIN_MS + Math.floor(Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS));
    await new Promise((r) => setTimeout(r, delay));
  } else if (outcome === 'error') {
    await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
  }
}
console.log('[worker] exited');
