#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, readReleaseState, requiredArg, ringStateRoot, stateRoot } from './lib.mjs';

const args = parseArgs();
const host = requiredArg(args, 'host');
const ring = requiredArg(args, 'ring');
const state = stateRoot(args);
const ringState = ringStateRoot(state, ring, host);
async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function optionalText(path) {
  try { return (await readFile(path, 'utf8')).trim() || null; } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
const current = await optionalJson(join(ringState, 'current.json'));
const previous = await optionalJson(join(ringState, 'previous.json'));
const promotion = current?.manifestSha256 ? await optionalJson(join(state, 'promotions', `${current.manifestSha256}.json`)) : null;
// The registry name, which carries the reverse-domain prefix every managed unit
// carries. Asking for the bare `weles-worker` answered "no registry-managed
// service named weles-worker", so this report has never seen the worker.
const WORKER_SERVICE = process.env.WELES_WORKER_SERVICE ?? 'com.wisent.weles-worker';
let stado;
try {
  // `stado service status <name> [--json]`. The `--host` flag was removed from
  // that command — one service's state is reported everywhere it is managed — so
  // this call had been failing with "unexpected argument '--host'" and the ring
  // status reported a Stado error instead of the worker's state. The host is
  // still what this report is about, so it is matched from the rows rather than
  // asked for in the query.
  const all = JSON.parse(execFileSync(process.env.STADO_BIN ?? 'stado', ['service', 'status', WORKER_SERVICE, '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const rows = Array.isArray(all) ? all : (Array.isArray(all?.rows) ? all.rows : [all]);
  stado = rows.find((row) => row?.host === host) ?? { host, absent: true };
} catch (error) {
  stado = { error: error instanceof Error ? error.message : String(error) };
}
let heartbeat = null;
let activeLease = null;
let storageError = null;
if (current?.instanceId) {
  try {
    const key = ring === 'production'
      ? 'weles_deployment_version'
      : `weles_deployment_version_${ring}_${current.instanceId}`;
    heartbeat = readReleaseState(key);
    if (ring === 'production') activeLease = readReleaseState('weles_active_worker_lease');
  } catch (error) {
    storageError = error instanceof Error ? error.message : String(error);
  }
}
process.stdout.write(`${JSON.stringify({
  schema: 'weles.release-status.v2',
  ring,
  host,
  current,
  previous,
  promotion,
  drainTarget: await optionalText(join(ringState, 'drain-target')),
  heartbeat,
  activeLease,
  storageError,
  stado,
}, null, 2)}\n`);
