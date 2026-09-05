#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeAtomic } from './lib.mjs';

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = parseArgs();

function version(value, name) {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    throw new Error(`${name} must be a release version in major.minor.patch form`);
  }
  return value;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function requestedBoolean(name, fallback) {
  const raw = args.get(name) ?? process.env[`WELES_VERSION_${name.toUpperCase()}`];
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`--${name} must be true or false`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const paths = {
  package: join(root, 'package.json'),
  lock: join(root, 'package-lock.json'),
  product: join(root, '.wisent-release.json'),
  baseline: join(root, 'released-surface.json'),
  declaration: join(root, 'release/version-change.json'),
};
const [packageManifest, packageLock, productManifest, baseline, declaration] = await Promise.all([
  readJson(paths.package),
  readJson(paths.lock),
  readJson(paths.product),
  readJson(paths.baseline),
  readJson(paths.declaration),
]);

const candidate = version(packageManifest.version, 'package.json version');
if (packageLock.version !== candidate || packageLock.packages?.['']?.version !== candidate) {
  throw new Error('package-lock.json versions must match package.json before release metadata is generated');
}
if (declaration.schema !== 'weles.version-change.v1') {
  throw new Error('release/version-change.json has an unsupported schema');
}
const compatible = productManifest.runtime?.rollback_compatible_with;
if (!Array.isArray(compatible)) {
  throw new Error('.wisent-release.json has no runtime.rollback_compatible_with list');
}

const npmOldVersion = process.env.npm_old_version && SEMVER.test(process.env.npm_old_version)
  ? process.env.npm_old_version
  : undefined;
const inferredCurrent = npmOldVersion && npmOldVersion !== candidate
  ? npmOldVersion
  : compatible.find((item) => typeof item === 'string' && SEMVER.test(item) && compareVersions(item, candidate) < 0);
const current = version(args.get('current') ?? inferredCurrent, 'current release');
if (compareVersions(current, candidate) >= 0) {
  throw new Error(`current release ${current} must precede candidate ${candidate}`);
}

const suppliedReason = args.get('reason') ?? process.env.WELES_VERSION_REASON;
const sameCandidate = declaration.candidate === candidate;
const reason = suppliedReason?.trim()
  || (sameCandidate && typeof declaration.reason === 'string'
    ? declaration.reason.trim()
    : `${candidate} advances the Weles release coordinate from ${current}; the source-bound version commit records the release intent.`);
const breaking = requestedBoolean('breaking', sameCandidate ? declaration.breaking : false);

const baselineVersion = version(baseline.version, 'released-surface.json version');
if (baselineVersion !== current) {
  throw new Error(
    `released-surface.json describes ${baselineVersion}, not current release ${current}; `
    + 'generate it from the actual current release source before bumping package.json',
  );
}

productManifest.runtime.rollback_compatible_with = [
  current,
  ...compatible.filter((item) => item !== current),
].slice(0, 9);

declaration.current = current;
declaration.candidate = candidate;
declaration.breaking = breaking;
declaration.reason = reason;

await Promise.all([
  writeAtomic(paths.product, `${JSON.stringify(productManifest, null, 2)}\n`, 0o644),
  writeAtomic(paths.declaration, `${JSON.stringify(declaration, null, 2)}\n`, 0o644),
]);

process.stdout.write(`${JSON.stringify({ current, candidate, breaking }, null, 2)}\n`);
