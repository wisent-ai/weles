#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, parseArgs, requiredArg } from './lib.mjs';

const args = parseArgs();
const probierzRoot = resolve(requiredArg(args, 'probierz-root'));
const manifestPath = resolve(requiredArg(args, 'manifest'));
const receiptPath = resolve(requiredArg(args, 'receipt'));
const runIds = requiredArg(args, 'run-ids').split(',').map((value) => value.trim()).filter(Boolean);
if (!runIds.length || new Set(runIds).size !== runIds.length) throw new Error('--run-ids must contain unique Probierz run IDs');
const publicKey = args.get('public-key') ? resolve(args.get('public-key')) : null;
const fingerprint = args.get('fingerprint')?.trim() || null;
if (!publicKey && !fingerprint) throw new Error('--public-key or --fingerprint is required');

const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const preparePath = join(releaseRoot, 'scripts/release/prepare-probierz.mjs');
execFileSync(process.execPath, [preparePath, '--probierz-root', probierzRoot], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const cli = join(probierzRoot, 'agent/cli.mjs');
function probierz(command, allowVerdictFailure = false) {
  try {
    return JSON.parse(execFileSync(process.execPath, [cli, ...command], {
      cwd: probierzRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }));
  } catch (error) {
    if (allowVerdictFailure && typeof error?.stdout === 'string' && error.stdout.trim()) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

const loaded = await loadManifest(manifestPath);
const identity = probierz(['source-identity', 'weles']);
if (!identity.harness?.sha256 || !identity.app?.sha256) throw new Error('Probierz source identity is incomplete');
const welesIdentity = identity.app.repositories?.find((repository) => repository.name === 'weles');
if (!welesIdentity) throw new Error('Probierz source identity does not include Weles');
if (welesIdentity.dirty) throw new Error('Weles checkout must be clean before evidence evaluation');
if (welesIdentity.gitSha !== loaded.manifest.sourceRevision) {
  throw new Error(`manifest source ${loaded.manifest.sourceRevision} does not match Weles checkout ${welesIdentity.gitSha}`);
}

const gateArgs = [
  'gate-evaluate', 'weles', 'release', identity.harness.sha256,
  '--source-sha', identity.app.sha256,
  '--runs', runIds.join(','),
  '--release', loaded.manifest.deploymentId,
  '--receipt', receiptPath,
];
if (publicKey) gateArgs.push('--public-key', publicKey);
else gateArgs.push('--fingerprint', fingerprint);
const evaluation = probierz(gateArgs, true);
if (!evaluation.verdict?.passed) {
  throw new Error(`Probierz release gate refused: ${(evaluation.verdict?.errors || ['unknown verdict']).join('; ')}`);
}
if (evaluation.evidence?.builds?.web !== loaded.sha256) {
  throw new Error(`Probierz build ${evaluation.evidence?.builds?.web || 'missing'} does not match manifest ${loaded.sha256}`);
}
const receiptSha256 = createHash('sha256').update(await readFile(receiptPath)).digest('hex');
const approval = {
  schema: 'weles.evidence-approval.v1',
  deploymentId: loaded.manifest.deploymentId,
  manifestSha256: loaded.sha256,
  sourceRevision: loaded.manifest.sourceRevision,
  probierzHarnessSha256: identity.harness.sha256,
  appSourceSha256: identity.app.sha256,
  runIds,
  receiptSha256,
  receiptFingerprint: evaluation.evidence.receipt?.fingerprint ?? null,
  evidenceLevels: evaluation.evidence.levels,
  approvedAt: new Date().toISOString(),
};
process.stdout.write(`${JSON.stringify(approval, null, 2)}\n`);
