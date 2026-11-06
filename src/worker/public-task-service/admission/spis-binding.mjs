// The Spis binding a public browser-evidence task carries: which crawl run,
// catalog, record and attempt it serves, and the exact Weles service identity
// Spis authorized. Every key and URI is recomputed from its parts and must
// match, so a binding cannot point the evidence at another record.
import { DeclaredError } from '../../../errors/index.cjs';
import { causes } from '../../../errors/operations/admission.cjs';
import { isObject, sha256Text } from '../wire/canonical-json.mjs';
import { PUBLIC_ACTION } from './deployment.mjs';

// A non-empty string; no length is chosen here. A path component is held to
// the portable character set and the URI to its exact stado:// shape below.
function portableBindingComponent(value, name) {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  )
    throw new DeclaredError(causes.SPIS_COMPONENT, {
      field: name,
      value: JSON.stringify(value) ?? typeof value,
    });
  return value;
}

// The keys `value` holds that `allowed` does not name, and those it lacks.
function keyDifference(value, allowed) {
  const keys = Object.keys(value);
  return {
    undeclared: keys.filter((key) => !Object.hasOwn(allowed, key)),
    missing: Object.keys(allowed).filter((key) => !keys.includes(key)),
  };
}

// Exactly the keys `allowed` names: none missing, none unknown.
function hasExactKeys(value, allowed) {
  const { undeclared, missing } = keyDifference(value, allowed);
  return !undeclared.length && !missing.length;
}

const listed = (keys) => (keys.length ? keys.join(', ') : 'none');

export function parseSpisBinding(value) {
  if (!isObject(value))
    throw new DeclaredError(causes.SPIS_NOT_OBJECT, {
      value: JSON.stringify(value) ?? typeof value,
    });
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
  const difference = keyDifference(value, allowed);
  if (difference.undeclared.length || difference.missing.length)
    throw new DeclaredError(causes.SPIS_FIELDS, {
      undeclared: listed(difference.undeclared),
      missing: listed(difference.missing),
      declared: Object.keys(allowed).join(', '),
    });
  if (value.schema !== 'weles.spis-browser-evidence-binding.v1')
    throw new DeclaredError(causes.SPIS_SCHEMA, {
      schema: JSON.stringify(value.schema),
    });
  if (
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 0xffffffff
  )
    throw new DeclaredError(causes.SPIS_ATTEMPT, {
      attempt: JSON.stringify(value.attempt),
    });
  if (
    typeof value.source_revision !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.source_revision)
  )
    throw new DeclaredError(causes.SPIS_REVISION, {
      value: JSON.stringify(value.source_revision),
    });
  for (const field of ['source_input_sha256', 'reference_sha256']) {
    if (
      typeof value[field] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value[field])
    )
      throw new DeclaredError(causes.SPIS_DIGEST, {
        field: `spisBinding.${field}`,
        value: JSON.stringify(value[field]),
      });
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
  )
    throw new DeclaredError(causes.SPIS_SERVICE, {
      value: JSON.stringify(service),
    });
  const endpointRefused = () =>
    new DeclaredError(causes.SPIS_ENDPOINT, {
      value: JSON.stringify(service.endpoint),
    });
  if (typeof service.endpoint !== 'string' || !URL.canParse(service.endpoint))
    throw endpointRefused();
  const endpoint = new URL(service.endpoint);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/v1' ||
    endpoint.toString() !== service.endpoint
  )
    throw endpointRefused();
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
  )
    throw new DeclaredError(causes.SPIS_CANONICAL, {
      record_key: recordKey,
      expected_record_key: expectedRecordKey,
      attempt_id: attemptId,
      expected_attempt_id: expectedAttemptId,
      artifact_uri: JSON.stringify(value.artifact_uri),
      expected_artifact_uri: `${baseUri}/artifacts.tar.gz`,
      output_uri: JSON.stringify(value.output_uri),
      expected_output_uri: `${baseUri}/worker-output.log`,
    });
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
    // Both equal the stado:// URIs recomputed above from portable parts.
    artifact_uri: value.artifact_uri,
    output_uri: value.output_uri,
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
