#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, requiredArg, stateRoot } from './lib.mjs';

const args = parseArgs();
const state = stateRoot(args);
const previous = JSON.parse(await readFile(join(state, 'previous.json'), 'utf8'));
const current = JSON.parse(await readFile(join(state, 'current.json'), 'utf8'));
if (!previous.manifestSha256 || previous.manifestSha256 === current.manifestSha256) {
  throw new Error('no distinct previous deployment is available');
}
const host = args.get('host') ?? previous.host ?? requiredArg(args, 'host');
const ring = args.get('ring') ?? current.ring ?? 'production';
const activatePath = join(dirname(fileURLToPath(import.meta.url)), 'activate.mjs');
const activateArgs = [
  activatePath,
  '--manifest-sha256', previous.manifestSha256,
  '--host', host,
  '--ring', ring,
  '--state-root', state,
  '--receipt-status', 'rolled_back',
];
for (const option of ['worker-env-file', 'drain-timeout-ms', 'health-timeout-ms']) {
  if (args.has(option)) activateArgs.push(`--${option}`, args.get(option));
}
execFileSync(process.execPath, activateArgs, { stdio: 'inherit', env: process.env });
