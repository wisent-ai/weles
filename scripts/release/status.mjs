#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, requiredArg, ringStateRoot, stateRoot } from './lib.mjs';

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
let stado;
try {
  stado = JSON.parse(execFileSync(process.env.STADO_BIN ?? 'stado', ['service', 'status', 'weles-worker', '--host', host, '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
} catch (error) {
  stado = { error: error instanceof Error ? error.message : String(error) };
}
const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
let heartbeat = null;
let activeLease = null;
if (baseUrl && serviceKey && current?.instanceId) {
  const key = ring === 'production' ? 'weles_deployment_version' : `weles_deployment_version:${ring}:${current.instanceId}`;
  const heartbeatResponse = await fetch(`${baseUrl}/rest/v1/system_settings?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json' },
  });
  if (heartbeatResponse.ok) heartbeat = (await heartbeatResponse.json())[0]?.value ?? null;
  if (ring === 'production') {
    const leaseResponse = await fetch(`${baseUrl}/rest/v1/system_settings?key=eq.weles_active_worker_lease&select=value`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json' },
    });
    if (leaseResponse.ok) activeLease = (await leaseResponse.json())[0]?.value ?? null;
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
  stado,
}, null, 2)}\n`);
