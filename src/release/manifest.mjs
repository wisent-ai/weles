/**
 * The Weles deployment-manifest contract, and the argument reader the release
 * commands share.
 *
 * This is the contract a candidate manifest is judged against: exact property
 * sets, SemVer versions, 40-character revisions, one artifact per platform, and
 * the API schemas a release claims. It used to sit in a `scripts/release`
 * folder as a library for files an operator ran by hand; the contract is
 * product code, so it lives here and is reached through `weles release`.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;

const REVISION = /^[0-9a-f]{40}$/;

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

const API_SCHEMA = /^weles\.[a-z0-9-]+\.v[1-9][0-9]*$/;

const PLATFORMS = { 'darwin-arm64': true, 'darwin-x64': true, 'linux-x64': true };
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const BROWSER_CANDIDATE_ATTESTATION_V1 = 'https://weles.wisent.com/attestations/browser-candidate/v1';
const DEPLOYMENT_MANIFEST_ATTESTATION_V1 = 'https://weles.wisent.com/attestations/deployment-manifest/v1';

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

export function validateManifest(value) {
  const manifest = exactProperties(value, [
    'schema', 'deploymentId', 'createdAt', 'sourceRevision', 'worker', 'web',
    'client', 'browsers',
  ], 'manifest');
  if (manifest.schema !== 'weles.deployment.v2') throw new Error('unsupported deployment manifest schema');
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

  return manifest;
}

export async function sha256(path) {
  const hash = createHash('sha256');
  const file = createReadStream(path);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}

export async function writeAtomic(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export async function loadManifest(path) {
  const raw = await readFile(path);
  return { raw, manifest: validateManifest(JSON.parse(raw.toString('utf8'))), sha256: createHash('sha256').update(raw).digest('hex') };
}
