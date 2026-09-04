import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function executable(path, label, allowSymlink = false) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  let metadata;
  try {
    metadata = allowSymlink ? statSync(path) : lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is unavailable or not executable`);
  }
  if (!metadata.isFile() || (!allowSymlink && metadata.isSymbolicLink())) {
    throw new Error(`${label} must be ${allowSymlink ? 'a regular executable' : 'a regular non-symlink executable'}`);
  }
  return path;
}

export function stadoBinary() {
  const configured = String(process.env.WELES_STADO_BIN || process.env.STADO_BIN || '').trim();
  return executable(configured || join(homedir(), '.stado', 'bin', 'stado'), 'Stado binary', true);
}

function stadoJson(args, operation) {
  const result = spawnSync(stadoBinary(), args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Stado ${operation} failed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Stado ${operation} returned invalid JSON`);
  }
}

export function activeSkarbiecBinary() {
  const active = stadoJson(
    ['release', 'active-binary', 'skarbiec', '--json'],
    'active Skarbiec release lookup',
  );
  const expectedKeys = [
    'artifact_sha256',
    'manifest_sha256',
    'path',
    'platform',
    'product',
    'state',
    'target',
    'version',
  ];
  const exactKeys = active && typeof active === 'object' && !Array.isArray(active)
    && Object.keys(active).sort().join('|') === expectedKeys.join('|');
  const exactDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const exactName = (value) => typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value);
  if (!exactKeys
      || active.state !== 'active'
      || active.product !== 'skarbiec'
      || !exactName(active.target)
      || !exactName(active.version)
      || !exactName(active.platform)
      || !exactDigest(active.artifact_sha256)
      || !exactDigest(active.manifest_sha256)
      || typeof active.path !== 'string') {
    throw new Error('Stado has no attested active Skarbiec release');
  }
  return executable(active.path, 'attested active Skarbiec binary');
}

export function skarbiecDirectoryEndpoint() {
  const record = stadoJson(
    ['service', 'directory', 'endpoint', 'skarbiec', '--json'],
    'Skarbiec service-directory lookup',
  );
  if (record?.service !== 'skarbiec' || typeof record?.url !== 'string' || !record.url) {
    throw new Error('Stado service directory has no Skarbiec endpoint');
  }
  let endpoint;
  try {
    endpoint = new URL(record.url);
  } catch {
    throw new Error('Stado service directory returned an invalid Skarbiec endpoint');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:'))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('Stado service directory returned an unsafe Skarbiec endpoint');
  }
  return endpoint.toString().replace(/\/$/, '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2];
  if (action === 'active-binary') process.stdout.write(activeSkarbiecBinary());
  else if (action === 'endpoint') process.stdout.write(skarbiecDirectoryEndpoint());
  else throw new Error('usage: skarbiec-runtime.mjs active-binary|endpoint');
}
