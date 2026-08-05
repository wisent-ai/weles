#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, parseArgs, requiredArg } from './lib.mjs';

const args = parseArgs();
const sourcePath = resolve(requiredArg(args, 'manifest'));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const loaded = await loadManifest(sourcePath);
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
if (loaded.manifest.sourceRevision !== sourceRevision) {
  throw new Error(`manifest sourceRevision ${loaded.manifest.sourceRevision} does not match checkout ${sourceRevision}`);
}
const trackedChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
if (trackedChanges) throw new Error('commit tracked Weles release inputs before publishing a manifest');
const actor = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const approvers = execFileSync('gh', [
  'variable', 'get', 'WELES_RELEASE_APPROVERS', '--repo', 'wisent-ai/weles',
], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).split(',').map((value) => value.trim()).filter(Boolean);
if (!approvers.includes(actor)) {
  throw new Error(`${actor || 'current GitHub actor'} is not an allowlisted Weles release operator`);
}
const tag = `candidate-deployment-${loaded.manifest.deploymentId}-${sourceRevision.slice(0, 8)}`;
const staging = await mkdtemp(join(tmpdir(), 'weles-manifest-'));
try {
  const asset = join(staging, 'deployment-manifest.json');
  const sidecar = `${asset}.sha256`;
  await copyFile(sourcePath, asset);
  await writeFile(sidecar, `${loaded.sha256}  deployment-manifest.json\n`, { mode: 0o600 });
  const releaseUrl = execFileSync('gh', [
    'release', 'create', tag,
    asset, sidecar,
    '--repo', 'wisent-ai/weles',
    '--target', sourceRevision,
    '--prerelease',
    '--title', tag,
    '--notes', 'Attested deployment-manifest candidate. Production activation must reuse these exact bytes after the protected evidence gate approves the manifest SHA-256.',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const manifestUrl = execFileSync('gh', [
    'api', `repos/wisent-ai/weles/releases/tags/${tag}`,
    '--jq', '.assets[] | select(.name == "deployment-manifest.json") | .browser_download_url',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!manifestUrl.startsWith('https://github.com/')) throw new Error('release manifest asset URL is missing');
  process.stdout.write(`${JSON.stringify({ tag, releaseUrl, manifestUrl, sha256: loaded.sha256 }, null, 2)}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
