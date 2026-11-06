// Every way the public task API refuses a request, provoked against the real
// Weles API server (src/worker/weles-api-server.mjs) over HTTP: one test per
// declared cause of admission.submit, admission.status and admission.cancel
// (src/errors/operations/admission.cjs). Each refusal must answer the
// declared HTTP status, the `error` code callers branch on, the cause's id,
// a message naming what failed, why and what was sent, and the fix.
//
// The server runs on a free loopback port with its HOME, recordings, keys and
// the documents Stado publishes for a host under build/real-tests/; the page
// host is resolved through this machine's DNS and judged against the IANA
// registries it reads from www.iana.org, as in production. No task is
// admitted far enough to start a browser.
//
// Usage: node --test tests/admission/failures.mjs
// The report is build/real-tests/admission-failures/<uuid>/report.json.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import {
  evidenceFor,
  exchange,
  freePort,
  publish,
  sandbox,
  sourceRevision,
  spisBinding,
  startServer,
} from './server.mjs';

const require = createRequire(import.meta.url);
const {
  SUBMIT,
  STATUS,
  CANCEL,
} = require('../../src/errors/operations/admission.cjs');
// The policy the server enforces, from the build it runs.
const {
  SPIS_BROWSER_EVIDENCE_POLICY,
} = require('../../dist/agent/browser-evidence-policy/withheld-ledger.js');

const evidence = evidenceFor('admission-failures');
const { report } = evidence;
report.scope = 'public task API refusals, one per declared cause';

const box = sandbox(join(evidence.directory, 'sandbox'));
const revision = sourceRevision();
let server;
let port;
let service;

/** Stop or start the server's dispatcher through the operator API. */
async function dispatcher(action, base = server.base) {
  const answer = await exchange(report, base, `/worker/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${box.apiToken}` },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

before(async () => {
  port = await freePort();
  service = publish(box, port, revision);
  server = await startServer(box, port);
  // Admitted tasks stay queued: no browser is started by this test.
  await dispatcher('stop');
});

after(async () => {
  if (server) report.server_output = await server.stop();
  evidence.finish();
});

/** A task carrying exactly what the API admits. */
function task() {
  return {
    schema: 'weles.task.current',
    organizationId: box.organizationId,
    origin: box.origin,
    action: 'generic_browser_task',
    input: {
      product_url: `${box.origin}/`,
      objective: 'Record the page',
      constraints: [...SPIS_BROWSER_EVIDENCE_POLICY.constraints],
      spisBinding: spisBinding(service, revision),
    },
    credentialRefs: [],
    evidencePolicy: 'full',
    justification: 'evidence for a catalogue record',
  };
}

function headers(extra = {}) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${box.bearer}`,
    'idempotency-key': randomUUID(),
    ...extra,
  };
}

function submit(body, extra = {}, base = server.base) {
  return exchange(report, base, '/api/v1/tasks', {
    method: 'POST',
    headers: headers(extra),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * The answer is the declared cause `id` of `operation`: its status, its wire
 * code, its id, a message holding every `names` and the remedy declared.
 */
function refused(operation, id, answer, names = []) {
  const cause = operation.causes.find((entry) => entry.id === id);
  assert.ok(cause, `${operation.id} declares ${id}`);
  report.cases.push({ operation: operation.id, cause: id, answer });
  assert.equal(answer.status, cause.status ?? answer.status);
  assert.equal(
    answer.body.error,
    cause.wire ?? cause.id,
    JSON.stringify(answer.body),
  );
  assert.equal(answer.body.cause, cause.id, JSON.stringify(answer.body));
  assert.equal(typeof answer.body.remedy, 'string');
  assert.ok(answer.body.remedy.length > 0);
  assert.ok(answer.body.message.includes('; observed: '), answer.body.message);
  assert.ok(
    answer.body.docs.startsWith('https://weles.wisent.com/docs/errors#'),
  );
  for (const name of names)
    assert.ok(
      answer.body.message.includes(name),
      `${id}: the message names ${name}: ${answer.body.message}`,
    );
  assert.doesNotMatch(answer.body.message, new RegExp(box.bearer));
}

test('submit_refuses_a_body_without_content_type', async () => {
  const answer = await exchange(report, server.base, '/api/v1/tasks', {
    method: 'POST',
    headers: { authorization: `Bearer ${box.bearer}` },
    body: new Uint8Array(Buffer.from(JSON.stringify(task()))),
  });
  refused(SUBMIT, 'media-type-missing', answer, ['Content-Type: none']);
});

test('submit_refuses_a_body_of_another_media_type', async () => {
  const answer = await submit(task(), { 'content-type': 'text/plain' });
  refused(SUBMIT, 'media-type-wrong', answer, ['text/plain']);
});

test('submit_refuses_a_request_without_a_bearer', async () => {
  const answer = await exchange(report, server.base, '/api/v1/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(task()),
  });
  refused(SUBMIT, 'bearer-missing', answer, ['Authorization: none']);
});

test('submit_refuses_a_bearer_this_worker_does_not_admit', async () => {
  const answer = await submit(task(), { authorization: 'Bearer wrong-bearer' });
  refused(SUBMIT, 'bearer-wrong', answer, ['12 characters']);
});

test('submit_refuses_a_request_without_an_idempotency_key', async () => {
  const answer = await exchange(report, server.base, '/api/v1/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${box.bearer}`,
    },
    body: JSON.stringify(task()),
  });
  refused(SUBMIT, 'idempotency-key-missing', answer, ['Idempotency-Key: none']);
});

test('submit_refuses_an_idempotency_key_with_other_characters', async () => {
  const answer = await submit(task(), { 'idempotency-key': 'key with spaces' });
  refused(SUBMIT, 'idempotency-key-invalid', answer, ['"key with spaces"']);
});

test('submit_refuses_a_body_that_is_not_json', async () => {
  const answer = await submit('{"schema":');
  refused(SUBMIT, 'body-not-json', answer, ['invalid_json']);
});

test('submit_refuses_a_task_of_another_schema', async () => {
  const answer = await submit({ ...task(), schema: 'weles.task.v0' });
  refused(SUBMIT, 'task-schema-unsupported', answer, ['"weles.task.v0"']);
});

test('submit_refuses_a_number_that_is_not_a_safe_integer', async () => {
  const body = task();
  body.input.spisBinding.attempt = 1.5;
  const answer = await submit(body);
  refused(SUBMIT, 'json-number-unsafe', answer, [
    'task.input.spisBinding.attempt',
    '1.5',
  ]);
});

test('submit_refuses_a_lone_utf16_surrogate', async () => {
  const answer = await submit(
    JSON.stringify(task()).replace('Record the page', 'Record \\ud800 page'),
  );
  refused(SUBMIT, 'json-lone-surrogate', answer, ['task.input.objective']);
});

test('submit_refuses_a_task_with_undeclared_or_missing_fields', async () => {
  const body = { ...task(), api_key: 'x' };
  delete body.justification;
  const answer = await submit(body);
  refused(SUBMIT, 'task-fields-undeclared', answer, [
    'task.api_key',
    'task.justification',
  ]);
});

test('submit_refuses_another_organization', async () => {
  const other = randomUUID();
  const answer = await submit({ ...task(), organizationId: other });
  refused(SUBMIT, 'organization-denied', answer, [other]);
});

test('submit_refuses_an_origin_that_is_not_https', async () => {
  const answer = await submit({ ...task(), origin: 'http://example.com' });
  refused(SUBMIT, 'origin-invalid', answer, ['"http://example.com"', 'http:']);
});

test('submit_refuses_an_origin_the_policy_does_not_allow', async () => {
  const answer = await submit({ ...task(), origin: 'https://other.example' });
  refused(SUBMIT, 'origin-denied', answer, [box.origin]);
});

test('submit_refuses_an_action_the_policy_does_not_allow', async () => {
  const answer = await submit({ ...task(), action: 'linkedin_login' });
  refused(SUBMIT, 'action-denied', answer, ['"linkedin_login"']);
});

test('submit_refuses_an_input_that_is_not_an_object', async () => {
  const answer = await submit({ ...task(), input: 'open the page' });
  refused(SUBMIT, 'input-not-object', answer, ['"open the page"']);
});

test('submit_refuses_an_input_with_undeclared_fields', async () => {
  const body = task();
  body.input.session = 'x';
  const answer = await submit(body);
  refused(SUBMIT, 'input-fields-undeclared', answer, ['task.input.session']);
});

test('submit_refuses_a_product_url_that_is_not_canonical_https', async () => {
  const body = task();
  body.input.product_url = 'https://user:pw@example.com/';
  const answer = await submit(body);
  refused(SUBMIT, 'product-url-invalid', answer, ['user or password']);
});

test('submit_refuses_a_page_outside_the_task_origin', async () => {
  const body = task();
  body.input.product_url = 'https://localhost/';
  const answer = await submit(body);
  refused(SUBMIT, 'origin-target-mismatch', answer, ['https://localhost']);
});

test('submit_refuses_an_empty_objective', async () => {
  const body = task();
  body.input.objective = '  ';
  const answer = await submit(body);
  refused(SUBMIT, 'objective-empty', answer, ['"  "']);
});

test('submit_refuses_constraints_other_than_the_policy', async () => {
  const body = task();
  body.input.constraints = ['anything-goes'];
  const answer = await submit(body);
  refused(SUBMIT, 'constraints-mismatch', answer, ['["anything-goes"]']);
});

test('submit_refuses_a_spis_binding_that_is_not_an_object', async () => {
  const body = task();
  body.input.spisBinding = [];
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-not-object', answer, ['[]']);
});

test('submit_refuses_a_spis_binding_with_missing_fields', async () => {
  const body = task();
  delete body.input.spisBinding.record_key;
  body.input.spisBinding.extra = 1;
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-fields', answer, [
    'undeclared: extra',
    'missing: record_key',
  ]);
});

test('submit_refuses_a_spis_binding_of_another_schema', async () => {
  const body = task();
  body.input.spisBinding.schema = 'weles.spis-browser-evidence-binding.v0';
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-schema', answer, ['v0']);
});

test('submit_refuses_a_spis_attempt_of_zero', async () => {
  const body = task();
  body.input.spisBinding.attempt = 0;
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-attempt', answer, ['attempt: 0']);
});

test('submit_refuses_a_spis_source_revision_that_is_not_a_commit', async () => {
  const body = task();
  body.input.spisBinding.source_revision = 'main';
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-source-revision', answer, ['"main"']);
});

test('submit_refuses_a_spis_digest_that_is_not_sha256', async () => {
  const body = task();
  body.input.spisBinding.reference_sha256 = 'ABC';
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-digest', answer, [
    'spisBinding.reference_sha256',
    '"ABC"',
  ]);
});

test('submit_refuses_a_spis_service_of_another_capability', async () => {
  const body = task();
  body.input.spisBinding.service.capability = 'credentials';
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-service', answer, ['"credentials"']);
});

test('submit_refuses_a_spis_endpoint_that_is_not_the_task_api', async () => {
  const body = task();
  body.input.spisBinding.service.endpoint = `http://127.0.0.1:${port}/api/v2`;
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-endpoint', answer, ['/api/v2']);
});

test('submit_refuses_a_spis_component_that_is_a_path', async () => {
  const body = task();
  body.input.spisBinding.catalog = '..';
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-component', answer, [
    'spisBinding.catalog',
    '".."',
  ]);
});

test('submit_refuses_a_spis_binding_whose_keys_do_not_recompute', async () => {
  const body = task();
  body.input.spisBinding.record_key = 'f'.repeat(64);
  const answer = await submit(body);
  refused(SUBMIT, 'spis-binding-not-canonical', answer, [
    `record_key ${'f'.repeat(64)}`,
    'expected',
  ]);
});

test('submit_refuses_credential_refs_that_are_not_a_list', async () => {
  const answer = await submit({ ...task(), credentialRefs: 'vault' });
  refused(SUBMIT, 'credential-refs-invalid', answer, ['"vault"']);
});

test('submit_refuses_a_task_that_names_credentials', async () => {
  const answer = await submit({ ...task(), credentialRefs: ['item-1'] });
  refused(SUBMIT, 'credential-refs-denied', answer, ['["item-1"]']);
});

test('submit_refuses_an_evidence_policy_other_than_full', async () => {
  const answer = await submit({ ...task(), evidencePolicy: 'minimal' });
  refused(SUBMIT, 'evidence-policy-invalid', answer, ['"minimal"']);
});

test('submit_refuses_an_empty_justification', async () => {
  const answer = await submit({ ...task(), justification: '' });
  refused(SUBMIT, 'justification-empty', answer, ['justification: ""']);
});

test('submit_refuses_a_binding_to_another_service_generation', async () => {
  const body = task();
  body.input.spisBinding = spisBinding(
    { ...service, directory_generation: 6 },
    revision,
  );
  const answer = await submit(body);
  refused(SUBMIT, 'service-identity-mismatch', answer, [
    '"directory_generation":6',
    '"directory_generation":7',
  ]);
});

test('submit_refuses_a_page_host_without_dns', async () => {
  const body = {
    ...task(),
    origin: 'https://nonexistent-host.invalid',
  };
  body.input.product_url = 'https://nonexistent-host.invalid/';
  const answer = await submit(body);
  refused(SUBMIT, 'target-unresolved', answer, [
    'nonexistent-host.invalid',
    'ENOTFOUND',
  ]);
});

test('submit_refuses_a_page_host_on_a_private_address', async () => {
  const body = { ...task(), origin: 'https://localhost' };
  body.input.product_url = 'https://localhost/';
  const answer = await submit(body);
  refused(SUBMIT, 'target-not-public', answer, ['localhost', 'non-public']);
});

test('submit_refuses_a_reused_key_for_another_request', async () => {
  const key = randomUUID();
  const first = await submit(task(), { 'idempotency-key': key });
  report.cases.push({ admitted_for_conflict: first });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const answer = await submit(
    { ...task(), justification: 'another request' },
    { 'idempotency-key': key },
  );
  refused(SUBMIT, 'idempotency-conflict', answer, [key, 'sha256:']);
});

test('status_refuses_a_task_id_that_is_not_a_uuid', async () => {
  const answer = await exchange(report, server.base, '/api/v1/tasks/abc-1', {
    headers: headers(),
  });
  refused(STATUS, 'task-id-invalid', answer, ['"abc-1"']);
});

test('status_refuses_a_wait_other_than_terminal', async () => {
  const answer = await exchange(
    report,
    server.base,
    `/api/v1/tasks/${randomUUID()}?wait=forever`,
    { headers: headers() },
  );
  refused(STATUS, 'wait-invalid', answer, ['wait=forever']);
});

test('status_refuses_a_task_this_worker_never_held', async () => {
  const id = randomUUID();
  const answer = await exchange(report, server.base, `/api/v1/tasks/${id}`, {
    headers: headers(),
  });
  refused(STATUS, 'task-not-found', answer, [id, box.taskRoot]);
});

test('status_refuses_a_task_record_that_is_not_json', async () => {
  const id = randomUUID();
  writeFileSync(join(box.taskRoot, `task-${id}.json`), '{"id":');
  const answer = await exchange(report, server.base, `/api/v1/tasks/${id}`, {
    headers: headers(),
  });
  refused(STATUS, 'task-record-unreadable', answer, [id, 'JSON']);
});

const cancellation = () => ({
  schema: 'weles.cancellation.current',
  organizationId: box.organizationId,
  reason: 'superseded',
});

function cancel(body, extra = {}) {
  return exchange(report, server.base, `/api/v1/tasks/${randomUUID()}/cancel`, {
    method: 'POST',
    headers: headers(extra),
    body: JSON.stringify(body),
  });
}

test('cancel_refuses_a_cancellation_of_another_schema', async () => {
  const answer = await cancel({
    ...cancellation(),
    schema: 'weles.task.current',
  });
  refused(CANCEL, 'cancellation-schema-unsupported', answer, [
    '"weles.task.current"',
  ]);
});

test('cancel_refuses_a_cancellation_with_undeclared_fields', async () => {
  const answer = await cancel({ ...cancellation(), cookie: 'x' });
  refused(CANCEL, 'cancellation-fields-undeclared', answer, [
    'cancellation.cookie',
  ]);
});

test('cancel_refuses_a_cancellation_without_a_reason', async () => {
  const answer = await cancel({ ...cancellation(), reason: ' ' });
  refused(CANCEL, 'cancellation-reason-empty', answer, ['reason: " "']);
});

test('cancel_refuses_a_second_cancellation_with_another_reason', async () => {
  // The first cancellation settles the queued task; its evidence cannot be
  // retained (the object store is a closed port), so the task stays open
  // with the recorded cancellation, and another one is the conflict.
  const first = await submit(task());
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const id = first.body.taskId;
  const path = `/api/v1/tasks/${id}/cancel`;
  const once = await exchange(report, server.base, path, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(cancellation()),
  });
  assert.equal(once.status, 202, JSON.stringify(once.body));
  const answer = await exchange(report, server.base, path, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...cancellation(), reason: 'another reason' }),
  });
  refused(CANCEL, 'cancellation-conflict', answer, [id, '"superseded"']);
});

test('submit_refuses_when_task_state_is_unwritable', async () => {
  const mapping = join(box.taskRoot, 'idempotency');
  mkdirSync(mapping, { recursive: true });
  chmodSync(mapping, 0o500);
  try {
    const answer = await submit(task());
    refused(SUBMIT, 'task-state-unwritable', answer, ['EACCES']);
  } finally {
    chmodSync(mapping, 0o700);
  }
});

test('submit_refuses_when_the_service_identity_is_unpublished', async () => {
  const moved = `${box.directoryFile}.withdrawn`;
  renameSync(box.directoryFile, moved);
  try {
    const answer = await submit(task());
    refused(SUBMIT, 'service-identity-unreadable', answer, ['ENOENT']);
  } finally {
    renameSync(moved, box.directoryFile);
  }
});

let spare = 0;
/**
 * Another server, on its own state but admitting the same caller, started
 * with `extra` environment; `run` gets its base and port.
 */
async function withServer(extra, run) {
  spare += 1;
  const other = sandbox(join(evidence.directory, `server-${spare}`), box);
  const otherPort = await freePort();
  publish(other, otherPort, revision);
  const started = await startServer(other, otherPort, extra);
  try {
    return await run(started.base, otherPort);
  } finally {
    report.cases.push({ server_output: await started.stop() });
  }
}

/** A task bound to the service another server on `otherPort` is. */
function taskFor(otherPort) {
  const body = task();
  body.input.spisBinding = spisBinding(
    { ...service, endpoint: `http://127.0.0.1:${otherPort}/api/v1` },
    revision,
  );
  return body;
}

test('submit_refuses_when_the_artifact_store_is_not_declared', async () => {
  await withServer({ STADO_API_URL: undefined }, async (base, otherPort) => {
    const answer = await submit(taskFor(otherPort), {}, base);
    refused(SUBMIT, 'prerequisites-not-ready', answer, [
      '"artifactRetention":false',
    ]);
  });
});

test('submit_refuses_when_the_address_registry_is_unreachable', async () => {
  // Node's fetch goes through HTTPS_PROXY when NODE_USE_ENV_PROXY is set; a
  // proxy on a closed port keeps the IANA registries from being read.
  const closed = await freePort();
  await withServer(
    { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${closed}` },
    async (base, otherPort) => {
      const answer = await submit(taskFor(otherPort), {}, base);
      refused(SUBMIT, 'address-registry-unreadable', answer, [
        'example.com',
        'IANA',
        `127.0.0.1:${closed}`,
      ]);
    },
  );
});

test('submit_refuses_while_the_worker_drains', async () => {
  // The server process exits as soon as its drain settles, so the window in
  // which a request meets a draining service is held open here by draining
  // the same service module the server composes (public-task-service.mjs)
  // and asking it over a real HTTP request.
  const { createPublicTaskService, publicTaskErrorResponse } = await import(
    '../../src/worker/public-task-service.mjs'
  );
  const own = sandbox(join(evidence.directory, 'drain'), box);
  const {
    SPIS_BROWSER_EVIDENCE_POLICY: policy,
  } = require('../../dist/agent/browser-evidence-policy/withheld-ledger.js');
  const drained = createPublicTaskService({
    environment: {
      WELES_PUBLIC_API_BEARER: box.bearer,
      WELES_PUBLIC_API_ORGANIZATION_ID: box.organizationId,
      WELES_PUBLIC_API_ALLOWED_ORIGINS: box.origin,
      WELES_RECEIPT_KEY_ID: box.keyId,
      WELES_RECEIPT_KEY_SET_VERSION: 'receipt-keys',
      WELES_RECEIPT_PRIVATE_KEY: box.privateKey,
      WELES_RECEIPT_PUBLIC_KEYS_JSON: box.publicKeys,
    },
    policy,
    runResultsRoot: own.runResults,
    recordingsRoot: own.recordings,
    releaseIdentity: {
      release_version: '0.0.0',
      release_sha256: 'c'.repeat(64),
      source_revision: revision,
    },
    redact: (value) => value,
    trajectoryReady: true,
    artifactRetentionReady: true,
    readServiceIdentity: () => {
      throw new Error('a draining service reads no identity');
    },
    resolveTarget: () => {
      throw new Error('a draining service resolves no target');
    },
    uploadArtifacts: () => {
      throw new Error('a draining service retains nothing');
    },
    readArtifactIdentity: () => {
      throw new Error('a draining service retains nothing');
    },
    runTrajectory: () => {
      throw new Error('a draining service runs nothing');
    },
  });
  await drained.recover();
  await drained.shutdown();
  const listener = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      await drained.handle(request, url, () => Promise.resolve(task()));
      response.writeHead(500).end();
    } catch (error) {
      const answer = publicTaskErrorResponse(error);
      response
        .writeHead(answer ? answer.status : 500, {
          'content-type': 'application/json',
        })
        .end(
          JSON.stringify(answer ? answer.payload : { error: String(error) }),
        );
    }
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    const answer = await submit(
      task(),
      {},
      `http://127.0.0.1:${listener.address().port}`,
    );
    refused(SUBMIT, 'service-draining', answer, ['termination signal']);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test('submit_refuses_while_recovery_failed', async () => {
  // A task state entry that is no task makes recovery fail; admission stays
  // paused and names the failure until the state is repaired. Last, since it
  // leaves this server recovering.
  writeFileSync(join(box.taskRoot, 'not-a-task.txt'), 'x');
  const restart = await exchange(report, server.base, '/worker/restart', {
    method: 'POST',
    headers: { authorization: `Bearer ${box.apiToken}` },
  });
  assert.notEqual(restart.status, 200, JSON.stringify(restart.body));
  const answer = await submit(task());
  refused(SUBMIT, 'worker-recovering', answer, [
    'unexpected public task state entry: not-a-task.txt',
  ]);
});
