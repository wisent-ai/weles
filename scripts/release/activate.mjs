#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertPromotionTransition,
  hostPlatform,
  loadManifest,
  parseArgs,
  requiredArg,
  ringStateRoot,
  selectArtifact,
  stateRoot,
  writeAtomic,
  waitForDrain,
} from './lib.mjs';

const args = parseArgs();
const manifestSha256 = requiredArg(args, 'manifest-sha256');
const host = requiredArg(args, 'host');
const ring = requiredArg(args, 'ring');
const receiptStatus = args.get('receipt-status') ?? 'activated';
if (!['activated', 'rolled_back'].includes(receiptStatus)) throw new Error('--receipt-status must be activated or rolled_back');
const state = stateRoot(args);
const ringState = ringStateRoot(state, ring, host);
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

const workerCredentialHelper = resolve(
  installation.components.worker.entrypoint,
  '../deploy/skarbiec-acquire.mjs',
);
const workerCredentialScopes = resolve(
  installation.components.worker.entrypoint,
  '../deploy/skarbiec-acquisition-scopes.conf',
);
await access(workerCredentialHelper);
await access(workerCredentialScopes);

function acquireDatabaseCredential(consumer, item, field) {
  const endpoint = process.env.WC_SKARBIEC_URL?.trim();
  if (!endpoint) throw new Error('release activation requires WC_SKARBIEC_URL');
  return execFileSync(process.execPath, [
    workerCredentialHelper,
    endpoint,
    workerCredentialScopes,
    consumer,
    item,
    field,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  }).trim();
}

process.env.SUPABASE_URL ||= acquireDatabaseCredential(
  'weles-database-url-bootstrap',
  'weles-database',
  'url',
);
process.env.SUPABASE_SERVICE_ROLE_KEY ||= acquireDatabaseCredential(
  'weles-database-service-role-bootstrap',
  'weles-database',
  'service_role_key',
);

const compatibility = manifest.compatibility.workerDatabase;
if (manifest.database.schemaVersion < compatibility.minimum || manifest.database.schemaVersion > compatibility.maximum) {
  throw new Error(`manifest database schema ${manifest.database.schemaVersion} is outside worker range ${compatibility.minimum}..${compatibility.maximum}`);
}

await mkdir(ringState, { recursive: true, mode: 0o700 });
await mkdir(join(state, 'locks'), { recursive: true, mode: 0o700 });
const lockPath = join(state, 'locks', 'activation.lock');
let lock;
try {
  lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), ring, targetHost: host, manifestSha256, acquiredAt: new Date().toISOString() })}\n`);
} catch (error) {
  if (error?.code === 'EEXIST') throw new Error(`another release transition holds ${lockPath}`);
  throw error;
}
const clearAbandonedLock = () => rmSync(lockPath, { force: true });
process.once('exit', clearAbandonedLock);

const currentPath = join(ringState, 'current.json');
const previousPath = join(ringState, 'previous.json');
const promotionPath = join(state, 'promotions', `${manifestSha256}.json`);
let previous = null;
let promotion = null;
try { previous = JSON.parse(await readFile(currentPath, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
try { promotion = JSON.parse(await readFile(promotionPath, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }

assertPromotionTransition(promotion, ring, receiptStatus);
if (!previous && ring === 'production' && args.get('legacy-drained') !== 'true') {
  throw new Error('first immutable production activation requires --legacy-drained true after producers are paused and in-flight legacy work is complete');
}

let evidenceApproval = null;
if (receiptStatus === 'activated') {
  const probierzRoot = resolve(requiredArg(args, 'probierz-root'));
  const evidenceReceipt = resolve(requiredArg(args, 'evidence-receipt'));
  const runIds = requiredArg(args, 'run-ids');
  const evidenceArgs = [
    join(resolve(import.meta.dirname, '../..'), 'scripts/release/evidence-gate.mjs'),
    '--probierz-root', probierzRoot,
    '--manifest', installation.manifestPath,
    '--receipt', evidenceReceipt,
    '--run-ids', runIds,
  ];
  if (args.get('public-key')) evidenceArgs.push('--public-key', resolve(args.get('public-key')));
  else evidenceArgs.push('--fingerprint', requiredArg(args, 'fingerprint'));
  evidenceApproval = JSON.parse(execFileSync(process.execPath, evidenceArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  }));
}

const drainTimeoutMs = Number(args.get('drain-timeout-ms') ?? 15 * 60 * 1000);
const drainPath = join(ringState, 'drain-target');
const deploymentGeneration = Number(manifest.deploymentId.slice(0, 10).replaceAll('-', '')) * 1_000_000
  + Number(manifest.deploymentId.split('.')[1]);
if (!Number.isSafeInteger(deploymentGeneration)) throw new Error('deploymentId cannot be represented as a lease generation');

const runtimeDirectory = join(ringState, 'launch', manifestSha256);
const runtimeEnvPath = join(runtimeDirectory, 'runtime.env');
const wrapperPath = join(runtimeDirectory, 'weles-worker');
const apiSchemas = manifest.web.apiSchemas.join(',');
const activationInstanceId = `weles-${ring}-${manifest.deploymentId}-${Date.now()}-${process.pid}`;
const environment = {
  WELES_WORKER_VERSION: manifest.worker.version,
  WELES_SOURCE_REVISION: manifest.worker.sourceRevision,
  WELES_WORKER_ARTIFACT_SHA256: workerArtifact.sha256,
  WELES_DEPLOYMENT_MANIFEST_SHA256: manifestSha256,
  WELES_DEPLOYMENT_ID: manifest.deploymentId,
  WELES_DEPLOYMENT_GENERATION: String(deploymentGeneration),
  WELES_DEPLOYMENT_RING: ring,
  WELES_INSTANCE_ID: activationInstanceId,
  WELES_CLAIMS_ENABLED: ring === 'production' ? '1' : '0',
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
  WELES_RELEASE_STATE_ROOT: ringState,
  WELES_DRAIN_FILE: drainPath,
};
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
const envText = Object.entries(environment).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n');
await writeAtomic(runtimeEnvPath, `${envText}\n`);
const home = homedir();
const configuredWorkerEnv = resolve(args.get('worker-env-file') ?? process.env.WELES_WORKER_ENV_FILE ?? join(home, '.config/weles/worker.env'));
const legacyWorkerEnv = resolve(join(home, 'weles/var/worker.env'));
const wrapper = `#!/bin/sh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
set -a
if [ -f ${shellQuote(configuredWorkerEnv)} ]; then
  . ${shellQuote(configuredWorkerEnv)}
elif [ -f ${shellQuote(legacyWorkerEnv)} ]; then
  . ${shellQuote(legacyWorkerEnv)}
else
  echo "weles worker env file is missing" >&2
  exit 1
fi
. ${shellQuote(runtimeEnvPath)}
set +a
NODE_BIN="\${WELES_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Weles worker Node runtime is missing" >&2
  exit 1
fi
if [ -z "\${SUPABASE_URL:-}" ]; then
  export SUPABASE_URL="$("$NODE_BIN" ${shellQuote(workerCredentialHelper)} "\${WC_SKARBIEC_URL:?WC_SKARBIEC_URL is required}" ${shellQuote(workerCredentialScopes)} weles-database-url-bootstrap weles-database url)"
fi
if [ -z "\${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  export SUPABASE_SERVICE_ROLE_KEY="$("$NODE_BIN" ${shellQuote(workerCredentialHelper)} "\${WC_SKARBIEC_URL:?WC_SKARBIEC_URL is required}" ${shellQuote(workerCredentialScopes)} weles-database-service-role-bootstrap weles-database service_role_key)"
fi
exec "$NODE_BIN" ${shellQuote(installation.components.worker.entrypoint)}
`;
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
  const deployed = JSON.parse(stadoCommand(['service', 'deploy', 'weles-worker', '--host', host, '--from', path, '--json']));
  return { retired, deployed };
}
async function setActiveLease(deploymentId, generation, activeManifestSha256) {
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!baseUrl || !serviceKey) throw new Error('worker lease cutover requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${baseUrl}/rest/v1/system_settings?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      key: 'weles_active_worker_lease',
      value: { schema: 'weles.worker-lease.v1', deploymentId, generation, manifestSha256: activeManifestSha256, updatedAt: new Date().toISOString() },
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
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' },
  });
  if (!response.ok) throw new Error(`failed to clear active worker lease (${response.status})`);
}

const heartbeatKey = ring === 'production' ? 'weles_deployment_version' : `weles_deployment_version:${ring}:${activationInstanceId}`;
async function waitForHeartbeat(expectedSha256, expectedInstanceId) {
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!baseUrl || !serviceKey) throw new Error('release health gate requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const timeout = Number(args.get('health-timeout-ms') ?? 120_000);
  const healthDeadline = Date.now() + timeout;
  while (Date.now() < healthDeadline) {
    const response = await fetch(`${baseUrl}/rest/v1/system_settings?key=eq.${encodeURIComponent(heartbeatKey)}&select=value`, {
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
    host_id: host,
    ring,
    worker_version: manifest.worker.version,
    source_revision: manifest.worker.sourceRevision,
    web_deployment_id: manifest.web.deploymentId,
    web_source_revision: manifest.web.sourceRevision,
    worker_artifact_sha256: workerArtifact.sha256,
    chromium_release: manifest.browsers.chromium.release,
    chromium_artifact_sha256: chromiumArtifact.sha256,
    firefox_release: manifest.browsers.firefox.release,
    firefox_artifact_sha256: firefoxArtifact.sha256,
    client_minimum_version: manifest.client.minimumVersion,
    database_schema_version: manifest.database.schemaVersion,
    status,
    previous_manifest_sha256: previousManifestSha256,
    evidence,
    recorded_at: new Date().toISOString(),
  };
  await writeAtomic(join(state, 'receipts', ring, host, `${Date.now()}-${manifestSha256}-${status}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (baseUrl && serviceKey) {
    const response = await fetch(`${baseUrl}/rest/v1/weles_deployment_receipts`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(receipt),
    });
    if (!response.ok) throw new Error(`failed to persist deployment receipt (${response.status})`);
  }
  return receipt;
}

let cutoverAttempted = false;
try {
  await waitForDrain(ringState, manifestSha256, drainTimeoutMs);
  cutoverAttempted = true;
  if (ring === 'production') await setActiveLease(manifest.deploymentId, deploymentGeneration, manifestSha256);
  const stadoEvidence = deploy(wrapperPath);
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
  if (previous?.manifestSha256) await writeAtomic(previousPath, `${JSON.stringify(previous, null, 2)}\n`);
  await writeAtomic(currentPath, `${JSON.stringify(current, null, 2)}\n`);
  await rm(drainPath, { force: true });
  const receipt = await recordReceipt(receiptStatus, { stado: stadoEvidence, heartbeat, probierz: evidenceApproval }, previous?.manifestSha256 ?? null);
  if (receiptStatus === 'activated') {
    const nextPromotion = {
      schema: 'weles.promotion.v1',
      manifestSha256,
      deploymentId: manifest.deploymentId,
      ring,
      host,
      evidenceApproval,
      promotedAt: new Date().toISOString(),
    };
    await writeAtomic(promotionPath, `${JSON.stringify(nextPromotion, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ current, receipt }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await recordReceipt('failed', { error: message, probierz: evidenceApproval }, previous?.manifestSha256 ?? null).catch(() => undefined);
  if (!cutoverAttempted) {
    await rm(drainPath, { force: true });
    throw error;
  }
  if (previous?.wrapperPath && previous?.manifestSha256) {
    if (ring === 'production' && previous.deploymentId) {
      const previousGeneration = Number(previous.deploymentId.slice(0, 10).replaceAll('-', '')) * 1_000_000 + Number(previous.deploymentId.split('.')[1]);
      await setActiveLease(previous.deploymentId, previousGeneration, previous.manifestSha256);
    }
    await writeAtomic(drainPath, `${previous.manifestSha256}\n`);
    deploy(previous.wrapperPath);
    await writeAtomic(currentPath, `${JSON.stringify(previous, null, 2)}\n`);
    await rm(drainPath, { force: true });
  } else {
    if (ring === 'production') await clearActiveLease();
    await rm(drainPath, { force: true });
  }
  throw error;
} finally {
  process.off('exit', clearAbandonedLock);
  await lock.close().catch(() => undefined);
  await rm(lockPath, { force: true });
}
