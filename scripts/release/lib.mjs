import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const API_SCHEMA = /^weles\.[a-z0-9-]+\.v[1-9][0-9]*$/;
const PLATFORMS = { 'darwin-arm64': true, 'darwin-x64': true, 'linux-x64': true };
export const RELEASE_RINGS = Object.freeze(['candidate', 'development', 'canary', 'production']);

export function parseArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`expected --name value, received ${key ?? '<end>'}`);
    values.set(key.slice(2), value);
  }
  return values;
}

export function requiredArg(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function releaseRoot(args) {
  return resolve(args.get('release-root') ?? process.env.WELES_RELEASE_ROOT ?? join(homedir(), '.local/share/weles-releases'));
}

export function stateRoot(args) {
  return resolve(args.get('state-root') ?? process.env.WELES_RELEASE_STATE_ROOT ?? join(homedir(), '.local/state/weles-release'));
}

export function ringStateRoot(state, ring, host) {
  if (!RELEASE_RINGS.includes(ring)) throw new Error('ring must be candidate, development, canary, or production');
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) throw new Error('host must be a safe state-path segment');
  return join(state, 'rings', ring, host);
}

export function assertPromotionTransition(promotion, ring, receiptStatus = 'activated') {
  if (!RELEASE_RINGS.includes(ring)) throw new Error('ring must be candidate, development, canary, or production');
  if (receiptStatus === 'rolled_back') return;
  const targetIndex = RELEASE_RINGS.indexOf(ring);
  if (targetIndex === 0) {
    if (promotion && promotion.ring !== ring) {
      throw new Error(`manifest already advanced to ${promotion.ring}; it cannot return to candidate`);
    }
    return;
  }
  const requiredPreviousRing = RELEASE_RINGS[targetIndex - 1];
  if (promotion?.ring !== requiredPreviousRing && promotion?.ring !== ring) {
    throw new Error(`${ring} promotion requires the same manifest to be active in ${requiredPreviousRing}`);
  }
}

export function hostPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform;
  return `${platform}-${arch}`;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function exactProperties(value, required, name) {
  const item = object(value, name);
  const expected = new Set(required);
  const missing = required.filter((key) => !(key in item));
  const unexpected = Object.keys(item).filter((key) => !expected.has(key));
  if (missing.length || unexpected.length) {
    throw new Error(`${name} properties mismatch; missing=[${missing.join(',')}] unexpected=[${unexpected.join(',')}]`);
  }
  return item;
}


function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text`);
  return value;
}

function exactSha(value, name) {
  const candidate = text(value, name);
  if (!SHA256.test(candidate)) throw new Error(`${name} must be lowercase SHA-256`);
  return candidate;
}

function artifact(value, name) {
  const item = exactProperties(value, ['platform', 'url', 'sha256', 'entrypoint', 'provenanceUrl', 'provenanceRepository'], name);
  const platform = text(item.platform, `${name}.platform`);
  if (!PLATFORMS[platform]) throw new Error(`${name}.platform is unsupported`);
  const url = new URL(text(item.url, `${name}.url`));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name}.url must be credential-free HTTPS without a fragment`);
  }
  exactSha(item.sha256, `${name}.sha256`);
  const entrypoint = text(item.entrypoint, `${name}.entrypoint`);
  if (entrypoint.startsWith('/') || entrypoint.split('/').includes('..')) throw new Error(`${name}.entrypoint must stay inside the artifact`);
  const provenance = new URL(text(item.provenanceUrl, `${name}.provenanceUrl`));
  if (provenance.protocol !== 'https:' || provenance.username || provenance.password || provenance.hash) {
    throw new Error(`${name}.provenanceUrl must be credential-free HTTPS without a fragment`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text(item.provenanceRepository, `${name}.provenanceRepository`))) {
    throw new Error(`${name}.provenanceRepository is invalid`);
  }
  return item;
}
function revision(value, name) {
  const candidate = text(value, name);
  if (!REVISION.test(candidate)) throw new Error(`${name} must be a full Git SHA`);
  return candidate;
}

function apiSchemas(value, name) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    throw new Error(`${name} must be a non-empty unique array`);
  }
  for (const schema of value) {
    if (typeof schema !== 'string' || !API_SCHEMA.test(schema)) throw new Error(`${name} contains an invalid API schema`);
  }
  return value;
}

function versionRange(value, name) {
  const range = exactProperties(value, ['minimum', 'maximum'], name);
  const minimum = Number(range.minimum);
  const maximum = Number(range.maximum);
  if (!Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(maximum) || maximum < minimum) {
    throw new Error(`${name} must be an ordered positive integer range`);
  }
  return range;
}


export function validateManifest(value) {
  const manifest = exactProperties(value, [
    'schema', 'deploymentId', 'createdAt', 'sourceRevision', 'worker', 'web',
    'database', 'client', 'browsers', 'compatibility',
  ], 'manifest');
  if (manifest.schema !== 'weles.deployment.v1') throw new Error('unsupported deployment manifest schema');
  if (!/^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/.test(text(manifest.deploymentId, 'deploymentId'))) throw new Error('deploymentId is invalid');
  const createdAt = text(manifest.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be an ISO date-time');
  revision(manifest.sourceRevision, 'sourceRevision');

  const worker = exactProperties(manifest.worker, ['version', 'sourceRevision', 'artifacts'], 'worker');
  if (!SEMVER.test(text(worker.version, 'worker.version'))) throw new Error('worker.version must be SemVer');
  revision(worker.sourceRevision, 'worker.sourceRevision');
  if (!Array.isArray(worker.artifacts) || !worker.artifacts.length) throw new Error('worker.artifacts is empty');
  worker.artifacts.forEach((item, index) => artifact(item, `worker.artifacts[${index}]`));
  if (new Set(worker.artifacts.map((item) => item.platform)).size !== worker.artifacts.length) throw new Error('worker.artifacts contains duplicate platforms');

  const web = exactProperties(manifest.web, ['deploymentId', 'sourceRevision', 'apiSchemas'], 'web');
  text(web.deploymentId, 'web.deploymentId');
  revision(web.sourceRevision, 'web.sourceRevision');
  apiSchemas(web.apiSchemas, 'web.apiSchemas');

  const client = exactProperties(manifest.client, ['minimumVersion', 'apiSchemas'], 'client');
  if (!SEMVER.test(text(client.minimumVersion, 'client.minimumVersion'))) throw new Error('client.minimumVersion must be SemVer');
  apiSchemas(client.apiSchemas, 'client.apiSchemas');

  const browsers = exactProperties(manifest.browsers, ['chromium', 'firefox'], 'browsers');
  for (const family of ['chromium', 'firefox']) {
    const browser = exactProperties(browsers[family], ['release', 'sourceRevision', 'capabilitiesSha256', 'artifacts'], `browsers.${family}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text(browser.release, `browsers.${family}.release`))) throw new Error(`browsers.${family}.release is invalid`);
    revision(browser.sourceRevision, `browsers.${family}.sourceRevision`);
    exactSha(browser.capabilitiesSha256, `browsers.${family}.capabilitiesSha256`);
    if (!Array.isArray(browser.artifacts) || !browser.artifacts.length) throw new Error(`browsers.${family}.artifacts is empty`);
    browser.artifacts.forEach((item, index) => artifact(item, `browsers.${family}.artifacts[${index}]`));
    if (new Set(browser.artifacts.map((item) => item.platform)).size !== browser.artifacts.length) throw new Error(`browsers.${family}.artifacts contains duplicate platforms`);
  }

  const database = exactProperties(manifest.database, ['schemaVersion', 'migrationSetSha256'], 'database');
  const schemaVersion = Number(database.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('database.schemaVersion must be a positive integer');
  exactSha(database.migrationSetSha256, 'database.migrationSetSha256');
  const compatibility = exactProperties(manifest.compatibility, ['workerDatabase', 'webDatabase'], 'compatibility');
  const workerRange = versionRange(compatibility.workerDatabase, 'compatibility.workerDatabase');
  const webRange = versionRange(compatibility.webDatabase, 'compatibility.webDatabase');
  if (schemaVersion < workerRange.minimum || schemaVersion > workerRange.maximum) throw new Error('database schema is outside worker compatibility');
  if (schemaVersion < webRange.minimum || schemaVersion > webRange.maximum) throw new Error('database schema is outside web compatibility');
  return manifest;
}

export async function sha256(path) {
  const hash = createHash('sha256');
  const file = createReadStream(path);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}
async function treeSha256(root) {
  const hash = createHash('sha256');
  async function walk(relativeDirectory) {
    const directory = join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (relativePath === '.installed.json') continue;
      const absolutePath = join(root, relativePath);
      if (entry.isDirectory()) {
        const metadata = await lstat(absolutePath);
        hash.update(`${JSON.stringify(['directory', relativePath, metadata.mode & 0o777])}\n`);
        await walk(relativePath);
      } else if (entry.isFile()) {
        const metadata = await lstat(absolutePath);
        hash.update(`${JSON.stringify(['file', relativePath, metadata.mode & 0o777, metadata.size])}\n`);
        for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
      } else {
        throw new Error(`installed component contains unsupported entry: ${relativePath}`);
      }
    }
  }
  await walk('');
  return hash.digest('hex');
}

export async function writeAtomic(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export async function download(url, destination) {
  const headers = {};
  const token = process.env.WELES_RELEASE_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed ${response.status} ${url}`);
  if (new URL(response.url).protocol !== 'https:') throw new Error(`download redirected outside HTTPS: ${response.url}`);
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
}

export function verifyAttestation(path, repository, bundlePath) {
  if ((process.env.WELES_VERIFY_ATTESTATIONS ?? '1') !== '1') {
    throw new Error('artifact attestation verification cannot be disabled for immutable releases');
  }
  execFileSync('gh', ['attestation', 'verify', path, '--bundle', bundlePath, '--repo', repository], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_TOKEN: process.env.WELES_RELEASE_TOKEN ?? process.env.GH_TOKEN ?? '' },
  });
}

export function selectArtifact(component, platform = hostPlatform()) {
  const matches = component.artifacts.filter((item) => item.platform === platform);
  if (matches.length !== 1) throw new Error(`expected exactly one ${platform} artifact, found ${matches.length}`);
  return matches[0];
}

export async function loadManifest(path) {
  const raw = await readFile(path);
  return { raw, manifest: validateManifest(JSON.parse(raw.toString('utf8'))), sha256: createHash('sha256').update(raw).digest('hex') };
}

export async function fetchManifest(url, expectedSha256, root) {
  if (expectedSha256 && !SHA256.test(expectedSha256)) throw new Error('--manifest-sha256 must be lowercase SHA-256');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.manifest-${process.pid}.json`);
  const provenanceTemporary = join(root, `.manifest-${process.pid}.sigstore.json`);
  await download(url, temporary);
  const loaded = await loadManifest(temporary);
  if (expectedSha256 && loaded.sha256 !== expectedSha256) throw new Error(`manifest digest mismatch: expected ${expectedSha256}, received ${loaded.sha256}`);
  const provenanceUrl = new URL(url);
  provenanceUrl.pathname = `${provenanceUrl.pathname}.sigstore.json`;
  await download(provenanceUrl, provenanceTemporary);
  try {
    verifyAttestation(temporary, 'wisent-ai/weles', provenanceTemporary);
  } finally {
    await rm(provenanceTemporary, { force: true });
  }
  const destination = join(root, 'manifests', `${loaded.sha256}.json`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await access(destination);
    if (await sha256(destination) !== loaded.sha256) {
      throw new Error(`cached manifest ${loaded.sha256} is corrupted`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await rename(temporary, destination);
    return { ...loaded, path: destination };
  }
  await rm(temporary, { force: true });
  return { ...loaded, path: destination };
}

function safeArchiveEntries(path) {
  const listing = execFileSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entries = listing.split('\n').filter(Boolean);
  if (!entries.length) throw new Error(`archive ${basename(path)} is empty`);
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`unsafe archive entry: ${entry}`);
  }
  const verbose = execFileSync('tar', ['-tvzf', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (verbose.split('\n').some((line) => /^[lh]/.test(line))) {
    throw new Error(`archive ${basename(path)} contains a link`);
  }
}

export async function waitForDrain(state, targetManifestSha256, timeoutMs) {
  const drainPath = join(state, 'drain-target');
  await writeAtomic(drainPath, `${targetManifestSha256}\n`);
  const activeDirectory = join(state, 'active');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let markers = [];
    try {
      markers = await readdir(activeDirectory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    let live = 0;
    for (const marker of markers) {
      const markerPath = join(activeDirectory, marker);
      let pid = 0;
      try {
        pid = Number(JSON.parse(await readFile(markerPath, 'utf8')).pid);
      } catch {
        await rm(markerPath, { force: true });
        continue;
      }
      try {
        process.kill(pid, 0);
        live += 1;
      } catch {
        await rm(markerPath, { force: true });
      }
    }
    if (live === 0) return drainPath;
    if (Date.now() >= deadline) throw new Error(`worker drain timed out with ${live} active slots`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
}

export async function installArtifact(options) {
  const { artifact: selected, component, releaseId, manifestSha256, root } = options;
  const destination = join(root, 'components', component, releaseId, selected.platform);
  const recordPath = join(destination, '.installed.json');
  try {
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    const observedTreeSha256 = await treeSha256(destination);
    if (record.sha256 !== selected.sha256 || record.manifestSha256 !== manifestSha256
        || !SHA256.test(record.treeSha256) || record.treeSha256 !== observedTreeSha256) {
      throw new Error(`installed ${component} destination has different provenance or content`);
    }
    const entrypoint = join(destination, selected.entrypoint);
    await access(entrypoint);
    if (!(await lstat(entrypoint)).isFile()) throw new Error(`${component} entrypoint is not a regular file`);
    return { destination, entrypoint, record };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const stagingRoot = await mkdtemp(join(root, `.install-${component}-`));
  const archivePath = join(stagingRoot, basename(new URL(selected.url).pathname) || `${component}.tar.gz`);
  try {
    await download(selected.url, archivePath);
    const digest = await sha256(archivePath);
    if (digest !== selected.sha256) throw new Error(`${component} digest mismatch: expected ${selected.sha256}, received ${digest}`);
    const provenancePath = join(stagingRoot, 'provenance.sigstore.json');
    await download(selected.provenanceUrl, provenancePath);
    verifyAttestation(archivePath, selected.provenanceRepository, provenancePath);
    safeArchiveEntries(archivePath);
    const extracted = join(stagingRoot, 'extracted');
    await mkdir(extracted);
    execFileSync('tar', ['-xzf', archivePath, '-C', extracted], { stdio: ['ignore', 'pipe', 'pipe'] });
    const entrypoint = resolve(extracted, selected.entrypoint);
    if (!entrypoint.startsWith(`${extracted}${sep}`)) throw new Error(`${component} entrypoint escapes extraction root`);
    await access(entrypoint);
    if (!(await lstat(entrypoint)).isFile()) throw new Error(`${component} entrypoint is not a regular file`);
    const installedTreeSha256 = await treeSha256(extracted);
    const record = {
      schema: 'weles.installed-component.v1',
      component,
      releaseId,
      platform: selected.platform,
      sha256: selected.sha256,
      manifestSha256,
      treeSha256: installedTreeSha256,
      sourceUrl: selected.url,
      entrypoint: selected.entrypoint,
      installedAt: new Date().toISOString(),
    };
    await writeFile(join(extracted, '.installed.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(extracted, destination);
    return { destination, entrypoint: join(destination, selected.entrypoint), record };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function copyManifest(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
}
