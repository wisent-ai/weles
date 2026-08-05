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
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pollOnce } from '../../dist/worker/poll.js';
import { startDeploymentVersionHeartbeat } from '../../dist/worker/deployment_version.js';
import { ensureAscIssuer } from '../../dist/worker/asc/issuer-ensure.js';
import { reclaimOrphansOnce } from '../../dist/worker/stale.js';
import { assertDatabaseCompatibility } from '../../dist/worker/schema_compatibility.js';

const RELEASE_STATE_ROOT = resolve(process.env.WELES_RELEASE_STATE_ROOT ?? join(homedir(), '.local/state/weles-release'));
const DRAIN_FILE = resolve(process.env.WELES_DRAIN_FILE ?? join(RELEASE_STATE_ROOT, 'drain-target'));
const ACTIVE_DIR = join(RELEASE_STATE_ROOT, 'active');
await mkdir(ACTIVE_DIR, { recursive: true, mode: 0o700 });

function drainingForAnotherRelease() {
  if (!existsSync(DRAIN_FILE)) return false;
  const target = readFileSync(DRAIN_FILE, 'utf8').trim();
  const current = process.env.WELES_DEPLOYMENT_MANIFEST_SHA256?.trim() ?? '';
  return Boolean(target && target !== current);
}

let shuttingDown = false;
const stop = () => { shuttingDown = true; console.log('[worker] shutting down'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const databaseCompatibility = await assertDatabaseCompatibility();
if (process.env.WELES_DATABASE_SCHEMA_VERSION
    && Number(process.env.WELES_DATABASE_SCHEMA_VERSION) !== databaseCompatibility.schemaVersion) {
  throw new Error(`deployment manifest expects database schema ${process.env.WELES_DATABASE_SCHEMA_VERSION}, found ${databaseCompatibility.schemaVersion}`);
}
process.env.WELES_DATABASE_SCHEMA_VERSION = String(databaseCompatibility.schemaVersion);
startDeploymentVersionHeartbeat();
try { await reclaimOrphansOnce(); } catch (e) { console.error('[worker] orphan reclaim failed:', e instanceof Error ? e.message : String(e)); }
void ensureAscIssuer();

const IDLE_MIN_MS = 3000;
const IDLE_MAX_MS = 8000;
const ERROR_BACKOFF_MS = 15000;
// Input transport defaults to cdp (mouse.ts:cdpInput) — per-page
// Playwright mouse/keyboard into each WSession's own browser
// context, no shared host resource, so N pollOnce loops are
// collision-free and WORKER_CONCURRENCY is honored as requested.
// Only an explicit WELES_INPUT=native label uses the single host
// OS cursor (cliclick); if such a label runs with N>1 the loops
// would interleave input, so clamp to 1 in that case unless
// WELES_ALLOW_UNSAFE_PARALLEL=1 (per-loop display isolation).
const _reqConc = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1) || 1);
const _native = process.env.WELES_INPUT === 'native';
const _safe = !_native || process.env.WELES_ALLOW_UNSAFE_PARALLEL === '1';
const CONCURRENCY = _safe ? _reqConc : 1;
if (_reqConc > 1 && CONCURRENCY === 1) {
  console.log(`[worker] WORKER_CONCURRENCY=${_reqConc} clamped to 1: WELES_INPUT=native uses the single host OS cursor. Unset it (cdp default, per-page parallel-safe) or set WELES_ALLOW_UNSAFE_PARALLEL=1 with per-loop display isolation.`);
}

async function loop(slot) {
  while (!shuttingDown && !drainingForAnotherRelease()) {
    let outcome = 'error';
    const activeMarker = join(ACTIVE_DIR, `${process.pid}-${slot}.json`);
    await writeFile(activeMarker, `${JSON.stringify({
      pid: process.pid,
      slot,
      manifestSha256: process.env.WELES_DEPLOYMENT_MANIFEST_SHA256 ?? null,
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    try { outcome = await pollOnce(); }
    catch (e) { console.error(`[worker:${slot}] pollOnce threw:`, e?.message ?? e); }
    finally { await rm(activeMarker, { force: true }); }
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
