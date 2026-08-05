#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, releaseRoot, requiredArg, ringStateRoot, stateRoot } from './lib.mjs';

const args = parseArgs();
const host = requiredArg(args, 'host');
const ring = requiredArg(args, 'ring');
const releases = releaseRoot(args);
const state = stateRoot(args);
const ringState = ringStateRoot(state, ring, host);
const current = JSON.parse(await readFile(join(ringState, 'current.json'), 'utf8'));
const previous = JSON.parse(await readFile(join(ringState, 'previous.json'), 'utf8'));
if (!current.manifestSha256 || !previous.manifestSha256 || !previous.wrapperPath) {
  throw new Error(`rollback state for ${ring}/${host} is incomplete`);
}
if (current.manifestSha256 === previous.manifestSha256) throw new Error('rollback target equals the active manifest');

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const activationArgs = [
  join(scriptRoot, 'activate.mjs'),
  '--manifest-sha256', previous.manifestSha256,
  '--host', host,
  '--ring', ring,
  '--receipt-status', 'rolled_back',
  '--release-root', releases,
  '--state-root', state,
  '--legacy-drained', 'true',
];
for (const name of ['worker-env-file', 'drain-timeout-ms', 'health-timeout-ms']) {
  if (args.get(name)) activationArgs.push(`--${name}`, args.get(name));
}
execFileSync(process.execPath, activationArgs, {
  stdio: 'inherit',
  env: process.env,
});
