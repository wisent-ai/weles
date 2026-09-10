import { PublicTaskError } from '../wire.mjs';
import { isObject, sha256Text } from '../wire/canonical-json.mjs';
import { PUBLIC_ACTION } from './deployment.mjs';

function boundedBindingText(value, name, maximum = 1_024) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new PublicTaskError(400, 'invalid-spis-binding', `${name} must be a bounded non-empty string`);
  }
  return value;
}

function portableBindingComponent(value, name) {
  const text = boundedBindingText(value, name, 240);
  if (text === '.' || text === '..' || !/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new PublicTaskError(400, 'invalid-spis-binding', `${name} must be one strict portable non-dot path component`);
  }
  return text;
}

function exactStadoUri(value, name) {
  const text = boundedBindingText(value, name, 4_096);
  let parsed;
  try { parsed = new URL(text); } catch {
    throw new PublicTaskError(400, 'invalid-spis-binding', `${name} must be an exact stado:// URI`);
  }
  const pathParts = parsed.pathname.split('/');
  if (parsed.protocol !== 'stado:' || !parsed.hostname || !parsed.pathname.startsWith('/')
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || pathParts.some((part) => part === '.' || part === '..')
      || parsed.toString() !== text) {
    throw new PublicTaskError(400, 'invalid-spis-binding', `${name} must be an exact stado:// URI`);
  }
  return text;
}

export function parseSpisBinding(value) {
  if (!isObject(value)) throw new PublicTaskError(400, 'invalid-spis-binding', 'input.spisBinding must be an object');
  const allowed = Object.freeze({
    artifact_uri: true,
    attempt: true,
    attempt_id: true,
    catalog: true,
    output_uri: true,
    record: true,
    record_key: true,
    reference_sha256: true,
    run_id: true,
    schema: true,
    service: true,
    source_input_sha256: true,
    source_revision: true,
  });
  if (Object.keys(value).some((key) => !Object.hasOwn(allowed, key)) || Object.keys(value).length !== 13) {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'input.spisBinding has missing or unknown fields');
  }
  if (value.schema !== 'weles.spis-browser-evidence-binding.v1') {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'unsupported input.spisBinding schema');
  }
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 0xffffffff) {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'spisBinding.attempt must be a positive safe integer');
  }
  if (typeof value.source_revision !== 'string' || !/^[0-9a-f]{40}$/.test(value.source_revision)) {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'spisBinding.source_revision must be a full lowercase Git revision');
  }
  for (const field of ['source_input_sha256', 'reference_sha256']) {
    if (typeof value[field] !== 'string' || !/^[0-9a-f]{64}$/.test(value[field])) {
      throw new PublicTaskError(400, 'invalid-spis-binding', `spisBinding.${field} must be a lowercase SHA-256`);
    }
  }
  const service = value.service;
  const serviceAllowed = Object.freeze({
    action: true,
    capability: true,
    consumer: true,
    directory_generation: true,
    endpoint: true,
    host: true,
    name: true,
    release_id: true,
    source_revision: true,
  });
  if (!isObject(service)
      || Object.keys(service).some((key) => !Object.hasOwn(serviceAllowed, key))
      || Object.keys(service).length !== 9
      || service.name !== 'weles-admission'
      || service.consumer !== 'spis'
      || service.capability !== 'browser-evidence'
      || service.action !== PUBLIC_ACTION
      || !Number.isSafeInteger(service.directory_generation)
      || service.directory_generation < 0
      || typeof service.host !== 'string'
      || !/^[A-Za-z0-9._-]+$/.test(service.host)
      || typeof service.release_id !== 'string'
      || !/^weles-worker@\d+\.\d+\.\d+$/.test(service.release_id)
      || typeof service.source_revision !== 'string'
      || !/^[0-9a-f]{40}$/.test(service.source_revision)) {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'spisBinding.service is not the exact authorized Weles service identity');
  }
  let endpoint;
  try { endpoint = new URL(service.endpoint); } catch {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'spisBinding.service.endpoint must be an absolute task API base URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/api/v1' || endpoint.toString() !== service.endpoint) {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'spisBinding.service.endpoint must be the exact /api/v1 base URL');
  }
  const runId = portableBindingComponent(value.run_id, 'spisBinding.run_id');
  const catalog = portableBindingComponent(value.catalog, 'spisBinding.catalog');
  const record = portableBindingComponent(value.record, 'spisBinding.record');
  const recordKey = portableBindingComponent(value.record_key, 'spisBinding.record_key');
  const attemptId = portableBindingComponent(value.attempt_id, 'spisBinding.attempt_id');
  const catalogKey = sha256Text(`${value.source_revision}\0${runId}\0${catalog}`);
  const expectedRecordKey = sha256Text(`${catalogKey}\0${record}\0${value.source_input_sha256}`);
  const expectedAttemptId = `attempt-${value.attempt}-${sha256Text(`${recordKey}\0${value.attempt}\0${service.host}`).slice(0, 16)}`;
  const baseUri = `stado://spis-crawls/${runId}/${catalog}/${record}/${recordKey}/attempts/${value.attempt}/${attemptId}`;
  if (recordKey !== expectedRecordKey || attemptId !== expectedAttemptId
      || value.artifact_uri !== `${baseUri}/artifacts.tar.gz`
      || value.output_uri !== `${baseUri}/worker-output.log`) {
    throw new PublicTaskError(400, 'invalid-spis-binding', 'spisBinding keys, attempt identity, or artifact URIs are not canonical');
  }
  return {
    schema: value.schema,
    run_id: runId,
    catalog,
    record,
    record_key: recordKey,
    attempt: value.attempt,
    attempt_id: attemptId,
    source_revision: value.source_revision,
    source_input_sha256: value.source_input_sha256,
    reference_sha256: value.reference_sha256,
    artifact_uri: exactStadoUri(value.artifact_uri, 'spisBinding.artifact_uri'),
    output_uri: exactStadoUri(value.output_uri, 'spisBinding.output_uri'),
    service: {
      name: service.name,
      consumer: service.consumer,
      capability: service.capability,
      directory_generation: service.directory_generation,
      host: service.host,
      endpoint: service.endpoint,
      action: service.action,
      release_id: service.release_id,
      source_revision: service.source_revision,
    },
  };
}

export function createDeployedIdentity({
  identity,
  expectedReleaseId,
  trajectoryReady,
  artifactRetentionReady,
  readServiceIdentity,
}) {
  function validatedServiceIdentity(value) {
    if (!isObject(value)
        || Object.keys(value).length !== 9
        || value.name !== 'weles-admission'
        || value.consumer !== 'spis'
        || value.capability !== 'browser-evidence'
        || value.action !== PUBLIC_ACTION
        || !Number.isSafeInteger(value.generation)
        || value.generation < 0
        || typeof value.active_host !== 'string'
        || !/^[A-Za-z0-9._-]+$/.test(value.active_host)
        || typeof value.endpoint !== 'string'
        || value.release_id !== expectedReleaseId
        || value.source_revision !== identity.source_revision) {
      throw new Error('deployed public service identity does not match the immutable Weles release');
    }
    const endpoint = new URL(value.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || endpoint.pathname !== '/api/v1' || endpoint.toString() !== value.endpoint) {
      throw new Error('deployed public service endpoint is invalid');
    }
    return {
      name: value.name,
      generation: value.generation,
      consumer: value.consumer,
      capability: value.capability,
      active_host: value.active_host,
      endpoint: value.endpoint,
      action: value.action,
      release_id: value.release_id,
      source_revision: value.source_revision,
    };
  }

  const staticReadiness = Object.freeze({
    releaseVersion: typeof identity.release_version === 'string' && /^\d+\.\d+\.\d+$/.test(identity.release_version),
    releaseDigest: typeof identity.release_sha256 === 'string' && /^[0-9a-f]{64}$/.test(identity.release_sha256),
    sourceRevision: typeof identity.source_revision === 'string' && /^[0-9a-f]{40}$/.test(identity.source_revision),
    trajectory: trajectoryReady === true,
    artifactRetention: artifactRetentionReady === true,
  });
  const staticReady = Object.values(staticReadiness).every(Boolean);
  let identityReady = false;
  let lastServiceIdentity = null;
  const readinessStatus = () => ({ ...staticReadiness, serviceIdentity: identityReady });

  function bindingServiceIdentity(serviceIdentity) {
    return {
      name: serviceIdentity.name,
      consumer: serviceIdentity.consumer,
      capability: serviceIdentity.capability,
      directory_generation: serviceIdentity.generation,
      host: serviceIdentity.active_host,
      endpoint: serviceIdentity.endpoint,
      action: serviceIdentity.action,
      release_id: serviceIdentity.release_id,
      source_revision: serviceIdentity.source_revision,
    };
  }

  // A read that did not yield the exact deployed identity leaves no identity
  // behind: readiness drops and the retained copy is discarded before the
  // error travels on to the caller. Kept out of the catch clause below so the
  // clause holds nothing but the propagation.
  function forgetServiceIdentity() {
    identityReady = false;
    lastServiceIdentity = null;
  }

  async function currentServiceIdentity() {
    try {
      lastServiceIdentity = validatedServiceIdentity(await readServiceIdentity());
      identityReady = true;
      return lastServiceIdentity;
    } catch (error) {
      forgetServiceIdentity();
      throw error;
    }
  }

  // The named answer to "is the deployed identity readable right now": either
  // the exact identity, or a refusal carrying the sentence that explains it.
  // `/api/v1/version` publishes the same state as `ready: false` with
  // `deployed-service-identity-mismatch`, so a caller that must keep going
  // branches on `ok` and says why instead of holding an unreadable identity.
  async function serviceIdentityReadiness() {
    try {
      return { ok: true, serviceIdentity: await currentServiceIdentity() };
    } catch (error) {
      return { ok: false, reason: `deployed service identity is unreadable: ${error.message}` };
    }
  }

  return Object.freeze({
    staticReady,
    readinessStatus,
    identityReady: () => identityReady,
    lastServiceIdentity: () => lastServiceIdentity,
    bindingServiceIdentity,
    currentServiceIdentity,
    serviceIdentityReadiness,
  });
}
