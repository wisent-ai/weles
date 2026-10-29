// The Spis binding a public browser-evidence task carries: which crawl run,
// catalog, record and attempt it serves, and the exact Weles service identity
// Spis authorized. Every key and URI is recomputed from its parts and must
// match, so a binding cannot point the evidence at another record.
import { PublicTaskError } from '../wire.mjs';
import { isObject, sha256Text } from '../wire/canonical-json.mjs';
import { PUBLIC_ACTION } from './deployment.mjs';

// A non-empty string; no length is chosen here. A path component is held to
// the portable character set and the URI to its exact stado:// shape below.
function bindingText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      `${name} must be a non-empty string`,
    );
  }
  return value;
}

function portableBindingComponent(value, name) {
  const text = bindingText(value, name);
  if (text === '.' || text === '..' || !/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      `${name} must be one strict portable non-dot path component`,
    );
  }
  return text;
}

function exactStadoUri(value, name) {
  const text = bindingText(value, name);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      `${name} must be an exact stado:// URI`,
    );
  }
  const pathParts = parsed.pathname.split('/');
  if (
    parsed.protocol !== 'stado:' ||
    !parsed.hostname ||
    !parsed.pathname.startsWith('/') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    pathParts.some((part) => part === '.' || part === '..') ||
    parsed.toString() !== text
  ) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      `${name} must be an exact stado:// URI`,
    );
  }
  return text;
}

// Exactly the keys `allowed` names: none missing, none unknown.
function hasExactKeys(value, allowed) {
  const keys = Object.keys(value);
  return (
    keys.every((key) => Object.hasOwn(allowed, key)) &&
    keys.length === Object.keys(allowed).length
  );
}

export function parseSpisBinding(value) {
  if (!isObject(value))
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'input.spisBinding must be an object',
    );
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
  if (!hasExactKeys(value, allowed)) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'input.spisBinding has missing or unknown fields',
    );
  }
  if (value.schema !== 'weles.spis-browser-evidence-binding.v1') {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'unsupported input.spisBinding schema',
    );
  }
  if (
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 0xffffffff
  ) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'spisBinding.attempt must be a positive safe integer',
    );
  }
  if (
    typeof value.source_revision !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.source_revision)
  ) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'spisBinding.source_revision must be a full lowercase Git revision',
    );
  }
  for (const field of ['source_input_sha256', 'reference_sha256']) {
    if (
      typeof value[field] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value[field])
    ) {
      throw new PublicTaskError(
        400,
        'invalid-spis-binding',
        `spisBinding.${field} must be a lowercase SHA-256`,
      );
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
  if (
    !isObject(service) ||
    !hasExactKeys(service, serviceAllowed) ||
    service.name !== 'weles-admission' ||
    service.consumer !== 'spis' ||
    service.capability !== 'browser-evidence' ||
    service.action !== PUBLIC_ACTION ||
    !Number.isSafeInteger(service.directory_generation) ||
    service.directory_generation < 0 ||
    typeof service.host !== 'string' ||
    !/^[A-Za-z0-9._-]+$/.test(service.host) ||
    typeof service.release_id !== 'string' ||
    !/^weles-worker@\d+\.\d+\.\d+$/.test(service.release_id) ||
    typeof service.source_revision !== 'string' ||
    !/^[0-9a-f]{40}$/.test(service.source_revision)
  ) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'spisBinding.service is not the exact authorized Weles service identity',
    );
  }
  let endpoint;
  try {
    endpoint = new URL(service.endpoint);
  } catch {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'spisBinding.service.endpoint must be an absolute task API base URL',
    );
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/v1' ||
    endpoint.toString() !== service.endpoint
  ) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'spisBinding.service.endpoint must be the exact /api/v1 base URL',
    );
  }
  const runId = portableBindingComponent(value.run_id, 'spisBinding.run_id');
  const catalog = portableBindingComponent(
    value.catalog,
    'spisBinding.catalog',
  );
  const record = portableBindingComponent(value.record, 'spisBinding.record');
  const recordKey = portableBindingComponent(
    value.record_key,
    'spisBinding.record_key',
  );
  const attemptId = portableBindingComponent(
    value.attempt_id,
    'spisBinding.attempt_id',
  );
  const catalogKey = sha256Text(
    `${value.source_revision}\0${runId}\0${catalog}`,
  );
  const expectedRecordKey = sha256Text(
    `${catalogKey}\0${record}\0${value.source_input_sha256}`,
  );
  const expectedAttemptId = `attempt-${value.attempt}-${sha256Text(`${recordKey}\0${value.attempt}\0${service.host}`).slice(0, 16)}`;
  const baseUri = `stado://spis-crawls/${runId}/${catalog}/${record}/${recordKey}/attempts/${value.attempt}/${attemptId}`;
  if (
    recordKey !== expectedRecordKey ||
    attemptId !== expectedAttemptId ||
    value.artifact_uri !== `${baseUri}/artifacts.tar.gz` ||
    value.output_uri !== `${baseUri}/worker-output.log`
  ) {
    throw new PublicTaskError(
      400,
      'invalid-spis-binding',
      'spisBinding keys, attempt identity, or artifact URIs are not canonical',
    );
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
