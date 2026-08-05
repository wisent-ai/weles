#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, requiredArg, sha256, stateRoot, writeAtomic } from './lib.mjs';

const args = parseArgs();
const baselinePath = resolve(requiredArg(args, 'baseline'));
const manifestSha256 = requiredArg(args, 'manifest-sha256');
if (!/^[0-9a-f]{64}$/.test(manifestSha256)) throw new Error('--manifest-sha256 must be lowercase SHA-256');
const host = requiredArg(args, 'host');
const confirmation = requiredArg(args, 'confirm');
if (confirmation !== 'LEGACY TO IMMUTABLE') throw new Error('--confirm must be exactly LEGACY TO IMMUTABLE');

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
if (baseline.schema !== 'weles.production-baseline.v1') throw new Error('baseline schema is not weles.production-baseline.v1');
if (!baseline.repository?.commit || baseline.repository.trackedFilesDirty) {
  throw new Error('baseline must name a clean tracked repository commit');
}
if (baseline.deployment?.mode !== 'legacy-main-poll') {
  throw new Error(`baseline deployment mode must be legacy-main-poll, received ${baseline.deployment?.mode ?? 'missing'}`);
}
const rollbackArchive = baseline.rollbackArchive;
if (!rollbackArchive?.path || !/^[0-9a-f]{64}$/.test(rollbackArchive.sha256 ?? '')) {
  throw new Error('baseline must contain a rollback archive and lowercase SHA-256');
}
await access(rollbackArchive.path);
const observedRollbackSha256 = await sha256(rollbackArchive.path);
if (observedRollbackSha256 !== rollbackArchive.sha256) {
  throw new Error(`rollback archive digest mismatch: expected ${rollbackArchive.sha256}, received ${observedRollbackSha256}`);
}

const modePath = resolve(args.get('deployment-mode-file') ?? join(homedir(), '.config/weles/deployment-mode'));
const state = stateRoot(args);
const plan = {
  schema: 'weles.legacy-cutover-plan.v1',
  baselinePath,
  baselineCommit: baseline.repository.commit,
  rollbackArchive: { path: rollbackArchive.path, sha256: rollbackArchive.sha256 },
  manifestSha256,
  host,
  ring: 'production',
  deploymentModeFile: modePath,
};
if (args.get('check-only') === 'true') {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

let previousMode = null;
let modeFileExisted = true;
try {
  previousMode = await readFile(modePath, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  modeFileExisted = false;
}
if (previousMode?.trim() && previousMode.trim() !== 'legacy-main-poll') {
  throw new Error(`deployment mode is already ${previousMode.trim()}`);
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const activationArgs = [
  join(scriptRoot, 'activate.mjs'),
  '--manifest-sha256', manifestSha256,
  '--host', host,
  '--ring', 'production',
  '--state-root', state,
  '--legacy-drained', 'true',
  '--probierz-root', resolve(requiredArg(args, 'probierz-root')),
  '--evidence-receipt', resolve(requiredArg(args, 'evidence-receipt')),
  '--run-ids', requiredArg(args, 'run-ids'),
];
for (const name of ['release-root', 'worker-env-file', 'drain-timeout-ms', 'health-timeout-ms']) {
  if (args.get(name)) activationArgs.push(`--${name}`, args.get(name));
}
if (args.get('public-key')) activationArgs.push('--public-key', resolve(args.get('public-key')));
else activationArgs.push('--fingerprint', requiredArg(args, 'fingerprint'));

try {
  await writeAtomic(modePath, 'immutable-manifest\n', 0o600);
  const activation = execFileSync(process.execPath, activationArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
  const receipt = {
    schema: 'weles.legacy-cutover.v1',
    ...plan,
    activatedAt: new Date().toISOString(),
    activation: JSON.parse(activation),
  };
  await writeAtomic(join(state, 'migrations', `legacy-${manifestSha256}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  if (modeFileExisted) await writeAtomic(modePath, previousMode, 0o600);
  else await rm(modePath, { force: true });
  throw error;
}
