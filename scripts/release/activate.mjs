#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  hostPlatform,
  loadManifest,
  parseArgs,
  requiredArg,
  selectArtifact,
  stateRoot,
  writeAtomic,
  waitForDrain,
} from './lib.mjs';

const args = parseArgs();
const manifestSha256 = requiredArg(args, 'manifest-sha256');
const host = requiredArg(args, 'host');
const ring = requiredArg(args, 'ring');
if (!['candidate', 'development', 'canary', 'production'].includes(ring)) throw new Error('--ring must be candidate, development, canary, or production');
const receiptStatus = args.get('receipt-status') ?? 'activated';
if (!['activated', 'rolled_back'].includes(receiptStatus)) throw new Error('--receipt-status must be activated or rolled_back');
const state = stateRoot(args);
const installationPath = join(state, 'installations', `${manifestSha256}.json`);
const installation = JSON.parse(await readFile(installationPath, 'utf8'));
if (installation.manifestSha256 !== manifestSha256) throw new Error('installation record digest mismatch');
const loaded = await loadManifest(installation.manifestPath);
if (loaded.sha256 !== manifestSha256) throw new Error('stored manifest digest mismatch');
const { manifest } = loaded;
const platform = installation.platform ?? hostPlatform();
const workerArtifact = selectArtifact(manifest.worker, platform);
const chromiumArtifact = selectArtifact(manifest.browsers.chromium, platform);
const firefoxArtifact = selectArtifact(manifest.browsers.firefox, platform);
for (const component of Object.values(installation.components)) await access(component.entrypoint);

const compatibility = manifest.compatibility.workerDatabase;
if (manifest.database.schemaVersion < compatibility.minimum || manifest.database.schemaVersion > compatibility.maximum) {
  throw new Error(`manifest database schema ${manifest.database.schemaVersion} is outside worker range ${compatibility.minimum}..${compatibility.maximum}`);
}

const currentPath = join(state, 'current.json');
let previous = null;
try { previous = JSON.parse(await readFile(currentPath, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (!previous && args.get('legacy-drained') !== 'true') {
  throw new Error('first immutable activation requires --legacy-drained true after producers are paused and in-flight legacy work is complete');
}
const drainTimeoutMs = Number(args.get('drain-timeout-ms') ?? 15 * 60 * 1000);
const drainPath = await waitForDrain(state, manifestSha256, drainTimeoutMs);
const deploymentGeneration = Number(manifest.deploymentId.slice(0, 10).replaceAll('-', '')) * 1_000_000
  + Number(manifest.deploymentId.split('.')[1]);
if (!Number.isSafeInteger(deploymentGeneration)) throw new Error('deploymentId cannot be represented as a lease generation');

const runtimeDirectory = join(state, 'launch', manifestSha256);
const runtimeEnvPath = join(runtimeDirectory, 'runtime.env');
const wrapperPath = join(runtimeDirectory, 'weles-worker');
const apiSchemas = manifest.web.apiSchemas.join(',');
const activationInstanceId = `weles-${manifest.deploymentId}-${Date.now()}-${process.pid}`;
const environment = {
  WELES_WORKER_VERSION: manifest.worker.version,
  WELES_SOURCE_REVISION: manifest.worker.sourceRevision,
  WELES_WORKER_ARTIFACT_SHA256: workerArtifact.sha256,
  WELES_DEPLOYMENT_MANIFEST_SHA256: manifestSha256,
  WELES_DEPLOYMENT_ID: manifest.deploymentId,
  WELES_DEPLOYMENT_GENERATION: String(deploymentGeneration),
  WELES_DEPLOYMENT_RING: ring,
  WELES_INSTANCE_ID: activationInstanceId,
  WELES_CHROMIUM_RELEASE: manifest.browsers.chromium.release,
  WELES_CHROMIUM_SHA256: chromiumArtifact.sha256,
  WELES_CHROMIUM_BIN: installation.components.chromium.entrypoint,
  WELES_FIREFOX_RELEASE: manifest.browsers.firefox.release,
  WELES_FIREFOX_SHA256: firefoxArtifact.sha256,
  WELES_FIREFOX_BIN: installation.components.firefox.entrypoint,
  WELES_DATABASE_SCHEMA_VERSION: String(manifest.database.schemaVersion),
  WELES_DATABASE_SCHEMA_MINIMUM: String(compatibility.minimum),
  WELES_DATABASE_SCHEMA_MAXIMUM: String(compatibility.maximum),
  WELES_API_SCHEMAS: apiSchemas,
  WELES_RELEASE_STATE_ROOT: state,
  WELES_DRAIN_FILE: drainPath,
};
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
const envText = Object.entries(environment).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n');
await writeAtomic(runtimeEnvPath, `${envText}\n`);
const home = homedir();
const configuredWorkerEnv = resolve(args.get('worker-env-file') ?? process.env.WELES_WORKER_ENV_FILE ?? join(home, '.config/weles/worker.env'));
const legacyWorkerEnv = resolve(join(home, 'weles/var/worker.env'));
const wrapper = `#!/bin/sh\nset -eu\nset -a\nif [ -f ${shellQuote(configuredWorkerEnv)} ]; then\n  . ${shellQuote(configuredWorkerEnv)}\nelif [ -f ${shellQuote(legacyWorkerEnv)} ]; then\n  . ${shellQuote(legacyWorkerEnv)}\nelse\n  echo "weles worker env file is missing" >&2\n  exit 1\nfi\n. ${shellQuote(runtimeEnvPath)}\nset +a\nexec /usr/bin/env node ${shellQuote(installation.components.worker.entrypoint)}\n`;
await writeAtomic(wrapperPath, wrapper, 0o700);

function stadoCommand(commandArgs) {
  return execFileSync(process.env.STADO_BIN ?? 'stado', commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function deploy(path) {
  let retired = null;
  try {
    retired = JSON.parse(stadoCommand(['service', 'retire', 'weles-worker', '--host', host, '--json']));
  } catch (error) {
    const detail = `${error?.message ?? ''}\n${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    if (!detail.includes('is not a registry-managed service')) throw error;
  }
  const deployed = JSON.parse(stadoCommand([
    'service', 'deploy', 'weles-worker', '--host', host, '--from', path, '--json',
  ]));
  return JSON.stringify({ retired, deployed });
}
async function setActiveLease(deploymentId, generation, activeManifestSha256) {
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!baseUrl || !serviceKey) throw new Error('worker lease cutover requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${baseUrl}/rest/v1/system_settings?on_conflict=key`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      key: 'weles_active_worker_lease',
      value: {
        schema: 'weles.worker-lease.v1',
        deploymentId,
        generation,
        manifestSha256: activeManifestSha256,
        updatedAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`failed to set active worker lease (${response.status})`);
}
async function clearActiveLease() {
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!baseUrl || !serviceKey) throw new Error('worker lease rollback requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${baseUrl}/rest/v1/system_settings?key=eq.weles_active_worker_lease`, {
    method: 'DELETE',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=minimal',
    },
  });
  if (!response.ok) throw new Error(`failed to clear active worker lease (${response.status})`);
}



async function waitForHeartbeat(expectedSha256, expectedInstanceId) {
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!baseUrl || !serviceKey) throw new Error('release health gate requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const timeout = Number(args.get('health-timeout-ms') ?? 120_000);
  const healthDeadline = Date.now() + timeout;
  while (Date.now() < healthDeadline) {
    const response = await fetch(`${baseUrl}/rest/v1/system_settings?key=eq.weles_deployment_version&select=value`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json' },
    });
    if (response.ok) {
      const rows = await response.json();
      if (rows[0]?.value?.release?.deployment_manifest_sha256 === expectedSha256
          && rows[0]?.value?.instance_id === expectedInstanceId) return rows[0].value;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
  }
  throw new Error(`worker heartbeat did not report manifest ${expectedSha256} from instance ${expectedInstanceId}`);
}

async function recordReceipt(status, evidence, previousManifestSha256 = null) {
  const receipt = {
    deployment_id: manifest.deploymentId,
    manifest_sha256: manifestSha256,
    host_id: host || hostname(),
    ring,
    worker_version: manifest.worker.version,
    source_revision: manifest.worker.sourceRevision,
    web_deployment_id: manifest.web.deploymentId,
    web_source_revision: manifest.web.sourceRevision,
    worker_artifact_sha256: workerArtifact.sha256,
    chromium_release: manifest.browsers.chromium.release,
    chromium_artifact_sha256: chromiumArtifact.sha256,
    firefox_artifact_sha256: firefoxArtifact.sha256,
    client_minimum_version: manifest.client.minimumVersion,
    firefox_release: manifest.browsers.firefox.release,
    database_schema_version: manifest.database.schemaVersion,
    status,
    previous_manifest_sha256: previousManifestSha256,
    evidence,
    recorded_at: new Date().toISOString(),
  };
  await writeAtomic(join(state, 'receipts', `${Date.now()}-${manifestSha256}-${status}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (baseUrl && serviceKey) {
    const response = await fetch(`${baseUrl}/rest/v1/weles_deployment_receipts`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(receipt),
    });
    if (!response.ok) throw new Error(`failed to persist deployment receipt (${response.status})`);
  }
  return receipt;
}

try {
  await setActiveLease(manifest.deploymentId, deploymentGeneration, manifestSha256);
  const stadoEvidence = JSON.parse(deploy(wrapperPath));
  const heartbeat = await waitForHeartbeat(manifestSha256, activationInstanceId);
  const current = {
    schema: 'weles.active-deployment.v1',
    manifestSha256,
    deploymentId: manifest.deploymentId,
    ring,
    leaseGeneration: deploymentGeneration,
    instanceId: activationInstanceId,
    host,
    installationPath,
    wrapperPath,
    activatedAt: new Date().toISOString(),
  };
  if (previous?.manifestSha256) {
    await writeAtomic(join(state, 'previous.json'), `${JSON.stringify(previous, null, 2)}\n`);
  }
  await writeAtomic(currentPath, `${JSON.stringify(current, null, 2)}\n`);
  await rm(drainPath, { force: true });
  const receipt = await recordReceipt(receiptStatus, { stado: stadoEvidence, heartbeat }, previous?.manifestSha256 ?? null);
  process.stdout.write(`${JSON.stringify({ current, receipt }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await recordReceipt('failed', { error: message }, previous?.manifestSha256 ?? null).catch(() => undefined);
  if (previous?.wrapperPath && previous?.manifestSha256) {
    if (previous.deploymentId) {
      const previousGeneration = Number(previous.deploymentId.slice(0, 10).replaceAll('-', '')) * 1_000_000
        + Number(previous.deploymentId.split('.')[1]);
      await setActiveLease(previous.deploymentId, previousGeneration, previous.manifestSha256);
    }
    await writeAtomic(drainPath, `${previous.manifestSha256}\n`);
    deploy(previous.wrapperPath);
    await writeAtomic(currentPath, `${JSON.stringify(previous, null, 2)}\n`);
    await rm(drainPath, { force: true });
  } else {
    await clearActiveLease();
    await rm(drainPath, { force: true });
  }
  throw error;
}
