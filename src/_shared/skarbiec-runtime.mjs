import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function executable(path, label, allowSymlink = false) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  let metadata;
  try {
    metadata = allowSymlink ? statSync(path) : lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new Error(
      `${label} ${JSON.stringify(path)} is unavailable or not executable: ${error.message}`,
      { cause: error },
    );
  }
  if (!metadata.isFile() || (!allowSymlink && metadata.isSymbolicLink())) {
    throw new Error(
      `${label} must be ${allowSymlink ? 'a regular executable' : 'a regular non-symlink executable'}`,
    );
  }
  return path;
}

export function stadoBinary() {
  const configured = String(
    process.env.WELES_STADO_BIN || process.env.STADO_BIN || '',
  ).trim();
  if (configured) return executable(configured, 'Stado binary', true);
  let failures;
  for (const candidate of [
    join(homedir(), '.stado', 'bin', 'stado'),
    join(homedir(), '.local', 'bin', 'stado'),
  ]) {
    try {
      return executable(candidate, 'Stado binary', true);
    } catch (error) {
      (failures ??= []).push(error.message);
    }
  }
  throw new Error(
    `Stado binary is unavailable or not executable:\n${failures.join('\n')}`,
  );
}

function stadoJson(args, operation) {
  const result = spawnSync(stadoBinary(), args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = [
      result.error?.message,
      result.stderr?.trim(),
      result.stdout?.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `Stado ${operation} failed (exit ${result.status}, signal ${result.signal ?? 'none'}): ${detail || 'no diagnostic output'}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Stado ${operation} returned invalid JSON: ${error.message}; stdout: ${result.stdout}; stderr: ${result.stderr}`,
    );
  }
}

const exactDigest = (value) =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exactName = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value);
const sameKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');

/** A signed release Stado attests for this host. */
function attestedRelease(active) {
  const keys = [
    'artifact_sha256',
    'manifest_sha256',
    'path',
    'platform',
    'product',
    'state',
    'target',
    'version',
  ];
  return (
    sameKeys(active, keys) &&
    active.state === 'active' &&
    active.product === 'skarbiec' &&
    exactName(active.target) &&
    exactName(active.version) &&
    exactName(active.platform) &&
    exactDigest(active.artifact_sha256) &&
    exactDigest(active.manifest_sha256) &&
    typeof active.path === 'string'
  );
}

/**
 * The program the host itself declares and reports for Skarbiec, when no
 * signed release targets it. That is the fleet's vault owner: there the
 * running vault is a host-declared program, not a rollout, and requiring a
 * release would keep weles-admission down. The bytes on disk must still be
 * the bytes Stado's host report names, so a replaced or tampered file is
 * refused.
 */
function declaredProgram(active) {
  const keys = ['path', 'product', 'sha256', 'state', 'target', 'version'];
  if (
    !sameKeys(active, keys) ||
    active.state !== 'declared' ||
    active.product !== 'skarbiec' ||
    !exactName(active.target) ||
    !exactName(active.version) ||
    !exactDigest(active.sha256) ||
    typeof active.path !== 'string'
  ) {
    return false;
  }
  const managed = join(homedir(), '.stado', 'bin', 'skarbiec');
  if (active.path !== managed) return false;
  const onDisk = createHash('sha256')
    .update(readFileSync(active.path))
    .digest('hex');
  if (onDisk !== active.sha256) {
    throw new Error(
      `Skarbiec at ${active.path} has digest ${onDisk}, not the ${active.sha256} Stado's host report names`,
    );
  }
  return true;
}

export function activeSkarbiecBinary() {
  // The managed launcher already resolved this executable through Stado.
  const inherited = String(process.env.SKARBIEC_BIN || '').trim();
  if (inherited)
    return executable(inherited, 'launcher-provided Skarbiec binary');
  const active = stadoJson(
    ['release', 'active-binary', 'skarbiec', '--json'],
    'active Skarbiec release lookup',
  );
  if (attestedRelease(active))
    return executable(active.path, 'attested active Skarbiec binary');
  if (declaredProgram(active))
    return executable(active.path, 'host-declared Skarbiec binary');
  throw new Error(
    `Stado names neither an attested Skarbiec release nor the host's own declared Skarbiec: ${JSON.stringify(active)}`,
  );
}

export function skarbiecDirectoryEndpoint() {
  const record = stadoJson(
    ['service', 'directory', 'endpoint', 'skarbiec', '--json'],
    'Skarbiec service-directory lookup',
  );
  if (
    record?.service !== 'skarbiec' ||
    typeof record?.url !== 'string' ||
    !record.url
  ) {
    throw new Error('Stado service directory has no Skarbiec endpoint');
  }
  let endpoint;
  try {
    endpoint = new URL(record.url);
  } catch {
    throw new Error(
      'Stado service directory returned an invalid Skarbiec endpoint',
    );
  }
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(
    endpoint.hostname,
  );
  if (
    (endpoint.protocol !== 'https:' &&
      !(loopback && endpoint.protocol === 'http:')) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== '/' && endpoint.pathname !== '')
  ) {
    throw new Error(
      'Stado service directory returned an unsafe Skarbiec endpoint',
    );
  }
  return endpoint.toString().replace(/\/$/, '');
}

/**
 * The capability broker socket of the shared Skarbiec on this host, as Stado
 * declares the Skarbiec unit's environment here. Never an inherited
 * variable: the per-Weles broker it used to name was retired, and a socket
 * left in an env file from that time is one nothing serves.
 */
export function sharedCapabilitySocket() {
  const self = spawnSync(stadoBinary(), ['registry', 'self', '--name-only'], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const host = self.stdout?.trim();
  if (self.error || self.status !== 0 || !host) {
    throw new Error(
      `Stado could not name this host's registry target (exit ${self.status}): ${[self.error?.message, self.stderr?.trim()].filter(Boolean).join('\n') || 'no diagnostic output'}`,
    );
  }
  const units = stadoJson(
    ['service', 'env', 'skarbiec', '--host', host, '--json'],
    `Skarbiec unit environment on ${host}`,
  );
  const socket = Array.isArray(units)
    ? units[0]?.environment?.SKARBIEC_CAP_SOCKET
    : undefined;
  if (typeof socket !== 'string' || !isAbsolute(socket)) {
    throw new Error(
      `Stado declares no absolute SKARBIEC_CAP_SOCKET for the Skarbiec unit on ${host}`,
    );
  }
  return socket;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const action = process.argv[2];
  if (action === 'active-binary') process.stdout.write(activeSkarbiecBinary());
  else if (action === 'endpoint')
    process.stdout.write(skarbiecDirectoryEndpoint());
  else if (action === 'capability-socket')
    process.stdout.write(sharedCapabilitySocket());
  else
    throw new Error(
      'usage: skarbiec-runtime.mjs active-binary|endpoint|capability-socket',
    );
}
