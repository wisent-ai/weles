#!/usr/bin/env node

import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, requiredArg } from './lib.mjs';

const args = parseArgs();
const probierzRoot = resolve(requiredArg(args, 'probierz-root'));
const welesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await access(join(probierzRoot, 'agent/cli.mjs'));
await access(join(probierzRoot, 'packages/web/playwright.config.ts'));

const specName = 'weles-release.spec.mjs';
const sourceSpec = join(welesRoot, 'scripts/release/probierz', specName);
const targetSpec = join(probierzRoot, 'packages/web/tests', specName);
const appDirectory = join(probierzRoot, 'apps/weles');
await mkdir(dirname(targetSpec), { recursive: true });
await mkdir(appDirectory, { recursive: true });
await rm(join(dirname(targetSpec), 'weles-release.spec.ts'), { force: true });
await copyFile(sourceSpec, targetSpec);

const root = JSON.stringify(welesRoot);
const manifest = `schemaVersion: 1
appId: weles
owner: Weles maintainers
repositories:
  - root: ${root}
    mappings:
      - paths: [src/**, scripts/**, release/**, package.json, package-lock.json]
        journeys: [web-contract, worker-contract, chromium-candidate, firefox-candidate]
surfaces:
  web:
    spec: ${specName}
    journeys: [web-contract, worker-contract, chromium-candidate, firefox-candidate]
journeys:
  web-contract:
    owner: Weles maintainers
    timeoutMs: 120000
    value: The candidate web deployment reports the exact manifest, source, database, and API-schema identity.
  worker-contract:
    owner: Weles maintainers
    timeoutMs: 120000
    value: The candidate worker health and version endpoints report the exact immutable release identity.
  chromium-candidate:
    owner: Weles maintainers
    timeoutMs: 120000
    value: The installed Chromium candidate launches from the manifest-selected explicit path.
  firefox-candidate:
    owner: Weles maintainers
    timeoutMs: 120000
    value: The installed Firefox candidate launches from the manifest-selected explicit path.
secretRefs:
  WELES_WORKER_API_TOKEN: vault://wisent/weles/worker-api-token
matrix:
  release:
    targets: [web]
    record: true
    timeoutMs: 120000
    maximumParallel: 1
    maxCells: 1
    minimumCellEvidence: E3
    artifactEncryption: required
    removePlaintextAfterProtection: true
    requiredMatrixProfile: release
artifacts:
  retain:
    pullRequestDays: 14
    nightlyDays: 30
    adhocDays: 7
  redact: [TOKEN, SECRET, PASSWORD, KEY, COOKIE, AUTH]
  pii: possible
pullRequestPolicy:
  minimumEvidence: E2
  requiredJourneys: [web-contract]
  requiredTargets: [web]
  requireSecretScan: true
releasePolicy:
  minimumEvidence: E3
  requiredJourneys: [web-contract, worker-contract, chromium-candidate, firefox-candidate]
  requiredTargets: [web]
  requiredMatrixProfile: release
  requireProtectedArtifacts: true
  requireSecretScan: true
`;
const manifestPath = join(appDirectory, 'probierz.yaml');
await writeFile(manifestPath, manifest, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ probierzRoot, welesRoot, manifestPath, specPath: targetSpec }, null, 2)}\n`);
