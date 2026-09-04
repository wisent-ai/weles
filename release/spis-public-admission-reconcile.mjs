#!/usr/bin/env node
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const mode = process.argv[2];

function readJson(path) {
  return JSON.parse(path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  const document = `${JSON.stringify(value, null, 2)}\n`;
  if (path === '-') {
    process.stdout.write(document);
    return;
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.new`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, document, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function objectAt(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function arrayAt(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function reconcileRegistry(source, destination, expectedHost, version, sourceRevision) {
  const registry = objectAt(readJson(source), 'registry');
  const directory = objectAt(registry.service_directory, 'service_directory');
  if (!Number.isSafeInteger(directory.generation) || directory.generation < 0) {
    throw new Error('service_directory.generation must be a non-negative safe integer');
  }
  const services = objectAt(directory.services, 'service_directory.services');
  const service = objectAt(services['weles-admission'], 'weles-admission service');
  if (service.active_host !== expectedHost) throw new Error(`weles-admission active_host is not ${expectedHost}`);
  const endpoints = objectAt(service.endpoints, 'weles-admission.endpoints');
  const endpoint = objectAt(endpoints[service.active_host], `weles-admission endpoint ${service.active_host}`);
  if (typeof endpoint.url !== 'string') throw new Error('weles-admission endpoint has no URL');
  const endpointUrl = new URL(endpoint.url);
  if (!['http:', 'https:'].includes(endpointUrl.protocol)
      || endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash
      || !['', '/', '/api/v1'].includes(endpointUrl.pathname)) {
    throw new Error('weles-admission endpoint must be an HTTP origin or end exactly in /api/v1');
  }

  let changed = false;
  if (endpoint.url !== endpointUrl.origin) {
    endpoint.url = endpointUrl.origin;
    changed = true;
  }
  if (endpoint.base_path !== '/api/v1') {
    endpoint.base_path = '/api/v1';
    changed = true;
  }
  const releaseId = `weles-worker@${version}`;
  if (endpoint.release_id !== releaseId) {
    endpoint.release_id = releaseId;
    changed = true;
  }
  if (endpoint.source_revision !== sourceRevision) {
    endpoint.source_revision = sourceRevision;
    changed = true;
  }
  for (const obsolete of ['release_id', 'source_revision']) {
    if (Object.hasOwn(service, obsolete)) {
      delete service[obsolete];
      changed = true;
    }
  }
  if (!service.consumers) {
    service.consumers = {};
    changed = true;
  }
  const consumers = objectAt(service.consumers, 'weles-admission.consumers');
  if (!consumers.spis) {
    consumers.spis = { capabilities: [] };
    changed = true;
  }
  const spis = objectAt(consumers.spis, 'weles-admission.consumers.spis');
  if (!spis.capabilities) {
    spis.capabilities = [];
    changed = true;
  }
  const capabilities = arrayAt(spis.capabilities, 'spis capabilities');
  if (capabilities.some((entry) => typeof entry !== 'string')) throw new Error('spis capabilities must contain strings');
  if (!capabilities.includes('browser-evidence')) {
    capabilities.push('browser-evidence');
    capabilities.sort();
    changed = true;
  }

  const targets = arrayAt(registry.targets, 'targets');
  const target = targets.find((entry) => entry?.name === service.active_host);
  if (!target) throw new Error(`active Weles target ${service.active_host} is absent`);
  const weles = objectAt(target.weles, `${service.active_host}.weles`);
  const actions = arrayAt(weles.actions, `${service.active_host}.weles.actions`);
  if (actions.some((entry) => typeof entry !== 'string')) throw new Error('Weles actions must contain strings');
  if (!actions.includes('generic_browser_task')) {
    actions.push('generic_browser_task');
    actions.sort();
    changed = true;
  }

  if (changed) directory.generation += 1;
  writeJson(destination, registry);
  process.stdout.write(`${JSON.stringify({
    changed,
    generation: directory.generation,
    activeHost: service.active_host,
    endpoint: `${endpoint.url}${endpoint.base_path}`,
  })}\n`);
}

function planChanged(path) {
  const plan = objectAt(readJson(path), 'registry plan');
  if (typeof plan.changed !== 'boolean') throw new Error('registry plan has no boolean changed field');
  if (!plan.changed) process.exit(3);
}

function nonemptyText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a nonempty string`);
  return value;
}

// `stado registry pull --with-generation` answers with one
// `stado.registry-pull-receipt.v1`: the document and the token that makes that
// exact document writable back. Splitting the receipt here is what keeps the
// two together - a generation read apart from its document is a token for a
// document nobody looked at, which is the lost update `--if-generation` exists
// to refuse. The document is written out for the transform and the token is
// printed for the conditional push.
function pullReceipt(receiptPath, destination) {
  const receipt = objectAt(readJson(receiptPath), 'registry pull receipt');
  if (receipt.schema !== 'stado.registry-pull-receipt.v1') {
    throw new Error('registry pull receipt schema is unsupported');
  }
  nonemptyText(receipt.location, 'registry pull receipt location');
  const generation = nonemptyText(receipt.generation, 'registry pull receipt generation');
  const document = objectAt(receipt.document, 'registry pull receipt document');
  writeJson(destination, document);
  process.stdout.write(`${generation}\n`);
}

// `stado registry push --json` answers with one
// `stado.registry-push-receipt.v1` for both outcomes, so neither the write nor
// the refusal has to be scraped out of a sentence. A `pushed` receipt must name
// the token this caller spent and the generation it produced; a `conflict`
// receipt must name the same spent token and carry no new generation.
function pushReceipt(receiptPath, expectedState, expectedGeneration) {
  const receipt = objectAt(readJson(receiptPath), 'registry push receipt');
  if (receipt.schema !== 'stado.registry-push-receipt.v1') {
    throw new Error('registry push receipt schema is unsupported');
  }
  nonemptyText(receipt.location, 'registry push receipt location');
  if (receipt.state !== expectedState) {
    throw new Error(`registry push receipt state is ${receipt.state}, not ${expectedState}`);
  }
  if (receipt.expected_generation !== expectedGeneration) {
    throw new Error('registry push receipt names a different conditional generation');
  }
  if (expectedState === 'pushed') {
    if (receipt.actual_generation !== null) {
      throw new Error('a pushed registry receipt must not name a conflicting generation');
    }
    process.stdout.write(`${nonemptyText(receipt.generation, 'registry push receipt generation')}\n`);
    return;
  }
  if (expectedState !== 'conflict') throw new Error('registry push receipt state is not a supported outcome');
  if (receipt.generation !== null || receipt.replaced !== null) {
    throw new Error('a conflicting registry receipt must not name a written generation');
  }
  if (receipt.actual_generation !== null) {
    nonemptyText(receipt.actual_generation, 'registry push receipt actual generation');
  }
}

function rollbackRegistry(beforePath, committedPath, destination) {
  const before = objectAt(readJson(beforePath), 'pre-activation registry');
  const committed = objectAt(readJson(committedPath), 'committed registry');
  const beforeDirectory = objectAt(before.service_directory, 'pre-activation service_directory');
  const committedDirectory = objectAt(committed.service_directory, 'committed service_directory');
  if (!Number.isSafeInteger(beforeDirectory.generation) || beforeDirectory.generation < 0
      || !Number.isSafeInteger(committedDirectory.generation) || committedDirectory.generation < 0
      || committedDirectory.generation === Number.MAX_SAFE_INTEGER) {
    throw new Error('registry rollback requires valid forward service-directory generations');
  }
  beforeDirectory.generation = committedDirectory.generation + 1;
  writeJson(destination, before);
}

function publishServiceSnapshot(registryPath, destination, expectedHost) {
  const registry = objectAt(readJson(registryPath), 'published registry');
  const directory = objectAt(registry.service_directory, 'service_directory');
  if (!Number.isSafeInteger(directory.generation) || directory.generation < 0) {
    throw new Error('service_directory.generation must be a non-negative safe integer');
  }
  const services = objectAt(directory.services, 'service_directory.services');
  const service = objectAt(services['weles-admission'], 'weles-admission service');
  if (service.active_host !== expectedHost) {
    throw new Error(`weles-admission active_host is not ${expectedHost}`);
  }
  const endpoints = objectAt(service.endpoints, 'weles-admission.endpoints');
  const endpoint = objectAt(endpoints[expectedHost], `weles-admission endpoint ${expectedHost}`);
  const url = new URL(endpoint.url);
  if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || url.origin !== endpoint.url
      || endpoint.base_path !== '/api/v1') {
    throw new Error('published weles-admission endpoint must declare an exact origin and /api/v1 base path');
  }
  if (typeof endpoint.release_id !== 'string' || typeof endpoint.source_revision !== 'string') {
    throw new Error('published weles-admission endpoint release identity is incomplete');
  }
  const publicEndpoint = `${endpoint.url}${endpoint.base_path}`;
  writeJson(destination, {
    schema: 'weles.public-service-directory.v1',
    directory_generation: directory.generation,
    service: {
      name: 'weles-admission',
      active_host: expectedHost,
      endpoint: publicEndpoint,
      action: 'generic_browser_task',
      release_id: endpoint.release_id,
      source_revision: endpoint.source_revision,
    },
  });
}

function credentialPresent(path) {
  const rows = readJson(path);
  if (!Array.isArray(rows)) throw new Error('credential list must be an array');
  const matches = rows.filter((item) => item?.id === 'weles-spis-public-admission');
  if (matches.length > 1) throw new Error('credential metadata contains duplicate weles-spis-public-admission items');
  if (matches.length === 0) process.exit(3);
  const type = matches[0].item_type ?? matches[0].itemType ?? matches[0].kind;
  if (type !== 'internal-authority') throw new Error('weles-spis-public-admission has the wrong item type');
}

function registrySame(leftPath, rightPath) {
  const left = JSON.stringify(readJson(leftPath));
  const right = JSON.stringify(readJson(rightPath));
  if (left !== right) process.exit(3);
}

function releaseSettled(path, target, version, sourceRevision) {
  const report = objectAt(readJson(path), 'release status');
  const rows = arrayAt(report.targets, 'release status targets');
  const matches = rows.filter((row) => row?.product === 'weles-worker' && row?.target === target);
  if (matches.length !== 1) throw new Error('release status does not name the exact Weles target once');
  const row = matches[0];
  const artifacts = Object.values(objectAt(row.desired?.artifacts, 'desired release artifacts'));
  const activeDigest = row.observed?.active_sha256;
  const activeArtifact = artifacts.filter((artifact) => (
    artifact?.artifact_sha256 === activeDigest
      && artifact?.source_revision === sourceRevision
  ));
  if (row.desired?.version !== version
      || row.observed?.schema_version !== 1
      || row.observed?.product !== 'weles-worker'
      || row.observed?.target !== target
      || row.observed?.active_version !== version
      || row.observed?.phase !== 'committed'
      || typeof activeDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(activeDigest)
      || activeArtifact.length !== 1
      || row.software?.verdict !== 'ok'
      || row.software?.failed !== false) {
    throw new Error(`weles-worker ${version} is not healthy at the exact source and digest on ${target}`);
  }
  process.stdout.write(`${JSON.stringify({
    version,
    sourceRevision,
    artifactSha256: activeDigest,
    rolloutGeneration: row.observed.rollout_generation,
  })}\n`);
}

function renderTrust(organizationPath, keySetVersionPath, publicKeysPath, destination) {
  const organizationId = readFileSync(organizationPath, 'utf8').trim();
  const keySetVersion = readFileSync(keySetVersionPath, 'utf8').trim();
  const receiptKeys = JSON.parse(readFileSync(publicKeysPath, 'utf8'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('receipt trust organizationId must be a UUID');
  }
  if (!keySetVersion || !receiptKeys || typeof receiptKeys !== 'object' || Array.isArray(receiptKeys)
      || Object.keys(receiptKeys).length === 0
      || Object.values(receiptKeys).some((value) => typeof value !== 'string' || !value.includes('PUBLIC KEY'))) {
    throw new Error('receipt trust key set is invalid');
  }
  writeJson(destination, {
    schema: 'wisent.spis-weles-receipt-trust.v1',
    organizationId,
    allowedAction: 'generic_browser_task',
    receiptKeys,
    keySetVersion,
  });
}

function versionReady(path, target, version, sourceRevision) {
  const document = objectAt(readJson(path), 'public Weles version');
  const identity = objectAt(document.serviceIdentity, 'public Weles service identity');
  const prerequisites = objectAt(document.prerequisites, 'public Weles prerequisites');
  if (document.schema !== 'weles.version.v1'
      || document.service !== 'weles-admission'
      || document.release !== version
      || document.releaseId !== `weles-worker@${version}`
      || document.sourceRevision !== sourceRevision
      || !/^[0-9a-f]{64}$/.test(document.deploymentManifestSha256 ?? '')
      || document.ready !== true
      || Object.values(prerequisites).some((value) => value !== true)
      || document.dispatcher?.healthy !== true
      || identity.name !== 'weles-admission'
      || identity.consumer !== 'spis'
      || identity.capability !== 'browser-evidence'
      || identity.active_host !== target
      || identity.action !== 'generic_browser_task'
      || identity.release_id !== `weles-worker@${version}`
      || identity.source_revision !== sourceRevision
      || typeof identity.endpoint !== 'string'
      || new URL(identity.endpoint).pathname !== '/api/v1') {
    throw new Error('public Weles version is not ready at the exact service, release, source, and endpoint identity');
  }
}

switch (mode) {
  case 'registry':
    if (process.argv.length !== 8) throw new Error('usage: ... registry CURRENT CANDIDATE HOST VERSION SOURCE_REVISION');
    if (!/^[0-9a-f]{40}$/.test(process.argv[7])) throw new Error('source revision must be a full lowercase Git commit');
    reconcileRegistry(process.argv[3], process.argv[4], process.argv[5], process.argv[6], process.argv[7]);
    break;
  case 'plan-changed':
    if (process.argv.length !== 4) throw new Error('usage: ... plan-changed PLAN');
    planChanged(process.argv[3]);
    break;
  case 'pull-receipt':
    if (process.argv.length !== 5) throw new Error('usage: ... pull-receipt RECEIPT DOCUMENT');
    pullReceipt(process.argv[3], process.argv[4]);
    break;
  case 'push-receipt':
    if (process.argv.length !== 6) throw new Error('usage: ... push-receipt RECEIPT STATE GENERATION');
    pushReceipt(process.argv[3], process.argv[4], process.argv[5]);
    break;
  case 'rollback-registry':
    if (process.argv.length !== 6) throw new Error('usage: ... rollback-registry BEFORE COMMITTED DESTINATION');
    rollbackRegistry(process.argv[3], process.argv[4], process.argv[5]);
    break;
  case 'publish-service':
    if (process.argv.length !== 6) throw new Error('usage: ... publish-service REGISTRY DESTINATION HOST');
    publishServiceSnapshot(process.argv[3], process.argv[4], process.argv[5]);
    break;
  case 'credential-present':
    if (process.argv.length !== 4) throw new Error('usage: ... credential-present CREDENTIALS_JSON');
    credentialPresent(process.argv[3]);
    break;
  case 'same':
    if (process.argv.length !== 5) throw new Error('usage: ... same LEFT RIGHT');
    registrySame(process.argv[3], process.argv[4]);
    break;
  case 'release-settled':
    if (process.argv.length !== 7) throw new Error('usage: ... release-settled STATUS TARGET VERSION SOURCE_REVISION');
    releaseSettled(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
    break;
  case 'version-ready':
    if (process.argv.length !== 7) throw new Error('usage: ... version-ready VERSION_JSON TARGET VERSION SOURCE_REVISION');
    versionReady(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
    break;
  case 'render-trust':
    if (process.argv.length !== 7) throw new Error('usage: ... render-trust ORGANIZATION KEYSET KEYS OUTPUT');
    renderTrust(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
    break;
  default:
    throw new Error('unsupported reconciliation mode');
}
