// How the public task API (POST /api/v1/tasks, GET /api/v1/tasks/<id>,
// POST /api/v1/tasks/<id>/cancel) refuses a request: every cause, declared
// once. `wire` is the `error` code the answer has always carried, so a caller
// that branches on it keeps working; `id` names the cause exactly, and the
// answer adds `cause`, `remedy` and `docs`.
'use strict';

const { declare } = require('../index.cjs');

const TEST = 'tests/admission/failures.mjs';

const cause = (fields) => declare('admission', fields);

const MEDIA_TYPE_MISSING = cause({
  id: 'media-type-missing',
  wire: 'unsupported-media-type',
  status: 415,
  code: 'refused',
  failed: 'reading the body of {method} {path}',
  cause:
    'the request states no Content-Type, and a public task body is read only as application/json',
  observed: 'Content-Type: none',
  remedy: 'send the body with the header Content-Type: application/json',
  test: `${TEST}::submit_refuses_a_body_without_content_type`,
});

const MEDIA_TYPE_WRONG = cause({
  id: 'media-type-wrong',
  wire: 'unsupported-media-type',
  status: 415,
  code: 'refused',
  failed: 'reading the body of {method} {path}',
  cause: 'the request states a Content-Type other than application/json',
  observed: 'Content-Type: {media_type}',
  remedy:
    'send the body as JSON with the header Content-Type: application/json',
  test: `${TEST}::submit_refuses_a_body_of_another_media_type`,
});

const BEARER_MISSING = cause({
  id: 'bearer-missing',
  wire: 'unauthorized',
  status: 401,
  code: 'auth',
  failed: 'authenticating {method} {path}',
  cause:
    'the request carries no Authorization: Bearer header, and every public task route takes the Spis admission bearer',
  observed: 'Authorization: {authorization}',
  remedy:
    'send Authorization: Bearer <token>, the token field of the Skarbiec item weles-spis-public-admission this worker was started with',
  test: `${TEST}::submit_refuses_a_request_without_a_bearer`,
});

const BEARER_WRONG = cause({
  id: 'bearer-wrong',
  wire: 'unauthorized',
  status: 401,
  code: 'auth',
  failed: 'authenticating {method} {path}',
  cause:
    'the bearer is not the one this worker admits: it belongs to another deployment, or the item was rotated after the caller read it',
  observed:
    'a bearer of {length} characters that does not match WELES_PUBLIC_API_BEARER',
  remedy:
    'read the token field of the Skarbiec item weles-spis-public-admission again and send it; if it was rotated, restart the worker so it reads the new one',
  test: `${TEST}::submit_refuses_a_bearer_this_worker_does_not_admit`,
});

const RECOVERING = cause({
  id: 'worker-recovering',
  wire: 'worker-recovering',
  status: 503,
  code: 'infra_down',
  failed: 'admitting a public task',
  cause:
    'the worker is recovering its durable task state, or its last recovery failed and left admission paused',
  observed: 'dispatcher: {dispatcher}',
  remedy:
    'read GET /worker/status for the recovery failure, repair the state it names under the run results directory, then POST /worker/restart',
  test: `${TEST}::submit_refuses_while_recovery_failed`,
});

const NOT_READY = cause({
  id: 'prerequisites-not-ready',
  wire: 'service-not-ready',
  status: 503,
  code: 'config',
  failed: 'admitting a public task',
  cause:
    'a prerequisite the deployment must state is missing: a release version, digest or source revision, the generic_browser_task trajectory, or the artifact store (STADO_API_URL and WELES_STADO_OBJECT_API_TOKEN)',
  observed: 'prerequisites: {prerequisites}',
  remedy:
    'start the worker through its release launcher with the Stado object store declared for it; GET /api/v1/version lists which prerequisite is false',
  test: `${TEST}::submit_refuses_when_the_artifact_store_is_not_declared`,
});

const DRAINING = cause({
  id: 'service-draining',
  wire: 'service-draining',
  status: 503,
  code: 'infra_down',
  failed: 'admitting a public task',
  cause:
    'the worker received a termination signal and stops admitting work while its running tasks settle',
  observed: 'the service is draining after a termination signal',
  remedy:
    'send the task again once the worker has restarted; GET /api/v1/version answers ready: true when it admits work',
  test: `${TEST}::submit_refuses_while_the_worker_drains`,
});

const IDEMPOTENCY_MISSING = cause({
  id: 'idempotency-key-missing',
  wire: 'invalid-idempotency-key',
  status: 400,
  code: 'refused',
  failed: 'reading the Idempotency-Key of {method} {path}',
  cause:
    'the request carries no Idempotency-Key header, so a retry could not be told from a new request',
  observed: 'Idempotency-Key: none',
  remedy:
    'send an Idempotency-Key header of letters, digits, _, ., : or -, the same one each time the same request is retried',
  test: `${TEST}::submit_refuses_a_request_without_an_idempotency_key`,
});

const IDEMPOTENCY_INVALID = cause({
  id: 'idempotency-key-invalid',
  wire: 'invalid-idempotency-key',
  status: 400,
  code: 'refused',
  failed: 'reading the Idempotency-Key of {method} {path}',
  cause:
    'the Idempotency-Key holds a character other than letters, digits, _, ., : or -',
  observed: 'Idempotency-Key: {key}',
  remedy: 'send a key of only those characters, such as a UUID',
  test: `${TEST}::submit_refuses_an_idempotency_key_with_other_characters`,
});

const BODY_NOT_JSON = cause({
  id: 'body-not-json',
  wire: 'invalid-json',
  status: 400,
  code: 'refused',
  failed: 'reading the body of {method} {path}',
  cause: 'the body is not a JSON document',
  observed: 'the parser said: {answer}',
  remedy: 'send one JSON object as the body',
  test: `${TEST}::submit_refuses_a_body_that_is_not_json`,
});

const TASK_SCHEMA = cause({
  id: 'task-schema-unsupported',
  wire: 'unsupported-task-schema',
  status: 400,
  code: 'refused',
  failed: 'reading the task',
  cause: 'the body is not an object whose schema is {expected}',
  observed: 'schema: {schema}',
  remedy: 'send a task object with "schema": "{expected}"',
  test: `${TEST}::submit_refuses_a_task_of_another_schema`,
});

const UNSAFE_NUMBER = cause({
  id: 'json-number-unsafe',
  wire: 'invalid-input',
  status: 400,
  code: 'refused',
  failed: 'reading {path}',
  cause:
    'it holds a number that is not a safe integer (a fraction, or beyond 2^53 - 1), which canonical public JSON does not carry',
  observed: '{path} = {value}',
  remedy: 'send that value as a whole number within 2^53 - 1, or as a string',
  test: `${TEST}::submit_refuses_a_number_that_is_not_a_safe_integer`,
});

const LONE_SURROGATE = cause({
  id: 'json-lone-surrogate',
  wire: 'invalid-input',
  status: 400,
  code: 'refused',
  failed: 'reading {path}',
  cause:
    'a string or key holds a lone UTF-16 surrogate, which is not text and has no canonical encoding',
  observed: 'the lone surrogate is in {path}',
  remedy:
    'send the text as valid Unicode: encode the character whole, or drop the stray half',
  test: `${TEST}::submit_refuses_a_lone_utf16_surrogate`,
});

const TASK_FIELDS = cause({
  id: 'task-fields-undeclared',
  wire: 'invalid-task',
  status: 400,
  code: 'refused',
  failed: 'reading the task',
  cause: 'its fields are not exactly the ones {schema} declares',
  observed: '{reasons}',
  remedy:
    'send exactly the fields {declared}; a credential enters a task only as a reference in credentialRefs',
  test: `${TEST}::submit_refuses_a_task_with_undeclared_or_missing_fields`,
});

const ORGANIZATION = cause({
  id: 'organization-denied',
  wire: 'organization-denied',
  status: 403,
  code: 'refused',
  failed: 'admitting a task for organization {organization}',
  cause:
    'the bearer authenticates one tenant and the request names another organization',
  observed: 'organizationId: {organization}',
  remedy:
    'send the organization_id field of the Skarbiec item weles-spis-public-admission as organizationId',
  test: `${TEST}::submit_refuses_another_organization`,
});

const ORIGIN_INVALID = cause({
  id: 'origin-invalid',
  wire: 'invalid-origin',
  status: 400,
  code: 'refused',
  failed: 'reading the task origin',
  cause:
    'origin is not an exact HTTPS origin (scheme and host, no path, no trailing slash)',
  observed: 'origin: {origin}; {answer}',
  remedy:
    'send origin as https://<host>, for example the origin of input.product_url',
  test: `${TEST}::submit_refuses_an_origin_that_is_not_https`,
});

const ORIGIN_DENIED = cause({
  id: 'origin-denied',
  wire: 'origin-denied',
  status: 403,
  code: 'refused',
  failed: 'admitting a task for origin {origin}',
  cause:
    'the origin is not in the service policy WELES_PUBLIC_API_ALLOWED_ORIGINS',
  observed: 'allowed origins: {allowed}',
  remedy:
    'send a task for an allowed origin, or add the origin to WELES_PUBLIC_API_ALLOWED_ORIGINS in the worker unit and restart it',
  test: `${TEST}::submit_refuses_an_origin_the_policy_does_not_allow`,
});

const ACTION_DENIED = cause({
  id: 'action-denied',
  wire: 'action-denied',
  status: 403,
  code: 'refused',
  failed: 'admitting a task for action {action}',
  cause: 'the public API runs only the action {allowed}',
  observed: 'action: {action}',
  remedy:
    'send "action": "{allowed}"; other actions run through the operator API, not the public one',
  test: `${TEST}::submit_refuses_an_action_the_policy_does_not_allow`,
});

const INPUT_NOT_OBJECT = cause({
  id: 'input-not-object',
  wire: 'invalid-input',
  status: 400,
  code: 'refused',
  failed: 'reading task.input',
  cause: 'input is not a JSON object',
  observed: 'input: {input}',
  remedy:
    'send input as an object holding product_url, objective, constraints and spisBinding',
  test: `${TEST}::submit_refuses_an_input_that_is_not_an_object`,
});

const INPUT_FIELDS = cause({
  id: 'input-fields-undeclared',
  wire: 'invalid-input',
  status: 400,
  code: 'refused',
  failed: 'reading task.input',
  cause:
    'its fields are not exactly the ones the task schema declares for input',
  observed: '{reasons}',
  remedy: 'send exactly the fields {declared}',
  test: `${TEST}::submit_refuses_an_input_with_undeclared_fields`,
});

const PRODUCT_URL = cause({
  id: 'product-url-invalid',
  wire: 'invalid-input',
  status: 400,
  code: 'refused',
  failed: 'reading input.product_url',
  cause: 'it is not an exact canonical public HTTPS URL without credentials',
  observed: 'product_url: {url}; {answer}',
  remedy:
    'send the page as https://<host>/<path>, written as new URL() writes it (lowercase host, a path of at least /), with no user or password',
  test: `${TEST}::submit_refuses_a_product_url_that_is_not_canonical_https`,
});

const TARGET_MISMATCH = cause({
  id: 'origin-target-mismatch',
  wire: 'origin-target-mismatch',
  status: 403,
  code: 'refused',
  failed: 'admitting a task for {url}',
  cause:
    'the task origin is not the origin of the page it asks the browser to open',
  observed: 'origin {origin}, page origin {target}',
  remedy: 'send origin equal to the origin of input.product_url',
  test: `${TEST}::submit_refuses_a_page_outside_the_task_origin`,
});

const OBJECTIVE = cause({
  id: 'objective-empty',
  wire: 'invalid-input',
  status: 400,
  code: 'refused',
  failed: 'reading input.objective',
  cause:
    'objective is not a non-empty string, so the run would have nothing to do',
  observed: 'objective: {objective}',
  remedy: 'send one sentence saying what the browser should record on the page',
  test: `${TEST}::submit_refuses_an_empty_objective`,
});

const CONSTRAINTS = cause({
  id: 'constraints-mismatch',
  wire: 'invalid-input',
  status: 400,
  code: 'refused',
  failed: 'reading input.constraints',
  cause:
    'the constraints are not exactly the browser-evidence policy {policy} this worker enforces',
  observed: 'sent {constraints}; the policy states {expected}',
  remedy:
    'send input.constraints as exactly {expected}; GET /api/v1/version names the policy and its digest',
  test: `${TEST}::submit_refuses_constraints_other_than_the_policy`,
});

const binding = (id, cause, observed, remedy, test) =>
  declare('admission', {
    id,
    wire: 'invalid-spis-binding',
    status: 400,
    code: 'refused',
    failed: 'reading input.spisBinding',
    cause,
    observed,
    remedy,
    test: `${TEST}::${test}`,
  });

const SPIS_NOT_OBJECT = binding(
  'spis-binding-not-object',
  'spisBinding is not a JSON object',
  'spisBinding: {value}',
  'send the binding Spis issued for the crawl attempt as an object of schema weles.spis-browser-evidence-binding.v1',
  'submit_refuses_a_spis_binding_that_is_not_an_object',
);
const SPIS_FIELDS = binding(
  'spis-binding-fields',
  'its fields are not exactly the ones weles.spis-browser-evidence-binding.v1 declares',
  'undeclared: {undeclared}; missing: {missing}',
  'send exactly the fields {declared}',
  'submit_refuses_a_spis_binding_with_missing_fields',
);
const SPIS_SCHEMA = binding(
  'spis-binding-schema',
  'its schema is not weles.spis-browser-evidence-binding.v1',
  'schema: {schema}',
  'send the binding as Spis writes it for this worker, schema weles.spis-browser-evidence-binding.v1',
  'submit_refuses_a_spis_binding_of_another_schema',
);
const SPIS_ATTEMPT = binding(
  'spis-binding-attempt',
  'attempt is not a whole number from 1 to 4294967295',
  'attempt: {attempt}',
  'send the attempt number Spis counted for the record, starting at 1',
  'submit_refuses_a_spis_attempt_of_zero',
);
const SPIS_REVISION = binding(
  'spis-binding-source-revision',
  'source_revision is not a full lowercase 40-character Git commit',
  'source_revision: {value}',
  'send the full commit of the Spis source the crawl ran from',
  'submit_refuses_a_spis_source_revision_that_is_not_a_commit',
);
const SPIS_DIGEST = binding(
  'spis-binding-digest',
  '{field} is not a lowercase 64-character SHA-256',
  '{field}: {value}',
  'send the SHA-256 Spis computed, in lowercase hex',
  'submit_refuses_a_spis_digest_that_is_not_sha256',
);
const SPIS_SERVICE = binding(
  'spis-binding-service',
  'service is not the exact authorized Weles service identity: weles-admission for consumer spis, capability browser-evidence and action generic_browser_task, with a directory generation, host, release id and source revision',
  'service: {value}',
  'send the service identity GET /api/v1/version answers as serviceIdentity, with its generation as directory_generation and its active_host as host',
  'submit_refuses_a_spis_service_of_another_capability',
);
const SPIS_ENDPOINT = binding(
  'spis-binding-endpoint',
  'service.endpoint is not the exact absolute /api/v1 base URL, with no credentials, query or fragment',
  'service.endpoint: {value}',
  'send the endpoint GET /api/v1/version answers in serviceIdentity',
  'submit_refuses_a_spis_endpoint_that_is_not_the_task_api',
);
const SPIS_COMPONENT = binding(
  'spis-binding-component',
  '{field} is not one portable path component (letters, digits, ., _ or -, and not . or ..)',
  '{field}: {value}',
  'send the {field} Spis wrote, which is one such component',
  'submit_refuses_a_spis_component_that_is_a_path',
);
const SPIS_CANONICAL = binding(
  'spis-binding-not-canonical',
  'the record key, attempt id or artifact URIs are not the ones recomputed from the binding, so the evidence would land on another record',
  'record_key {record_key} (expected {expected_record_key}); attempt_id {attempt_id} (expected {expected_attempt_id}); artifact_uri {artifact_uri} (expected {expected_artifact_uri}); output_uri {output_uri} (expected {expected_output_uri})',
  'send the binding exactly as Spis computed it; do not edit one field of it',
  'submit_refuses_a_spis_binding_whose_keys_do_not_recompute',
);

const CREDENTIAL_REFS = cause({
  id: 'credential-refs-invalid',
  wire: 'invalid-credential-refs',
  status: 400,
  code: 'refused',
  failed: 'reading task.credentialRefs',
  cause: 'credentialRefs is not an array of non-empty strings',
  observed: 'credentialRefs: {value}',
  remedy: 'send "credentialRefs": [] for a browser-evidence task',
  test: `${TEST}::submit_refuses_credential_refs_that_are_not_a_list`,
});

const CREDENTIAL_DENIED = cause({
  id: 'credential-refs-denied',
  wire: 'credential-refs-denied',
  status: 403,
  code: 'refused',
  failed: 'admitting a task that names credentials',
  cause:
    'a browser-evidence task records a public page and is never handed a credential',
  observed: 'credentialRefs: {value}',
  remedy:
    'send "credentialRefs": []; a page behind a sign-in is not public evidence',
  test: `${TEST}::submit_refuses_a_task_that_names_credentials`,
});

const EVIDENCE_POLICY = cause({
  id: 'evidence-policy-invalid',
  wire: 'invalid-evidence-policy',
  status: 400,
  code: 'refused',
  failed: 'reading task.evidencePolicy',
  cause:
    'a browser-evidence task keeps its full evidence, and evidencePolicy says otherwise',
  observed: 'evidencePolicy: {value}',
  remedy: 'send "evidencePolicy": "full"',
  test: `${TEST}::submit_refuses_an_evidence_policy_other_than_full`,
});

const JUSTIFICATION = cause({
  id: 'justification-empty',
  wire: 'invalid-justification',
  status: 400,
  code: 'refused',
  failed: 'reading task.justification',
  cause:
    'justification is not a non-empty string, and every admitted task records why it runs',
  observed: 'justification: {value}',
  remedy: 'send one sentence saying why this page is recorded',
  test: `${TEST}::submit_refuses_an_empty_justification`,
});

const IDEMPOTENCY_CONFLICT = cause({
  id: 'idempotency-conflict',
  wire: 'idempotency-conflict',
  status: 409,
  code: 'refused',
  failed: 'admitting the task under Idempotency-Key {key}',
  cause:
    'the key was already used for a request with different content, so this is not a retry of it',
  observed:
    'the key is bound to request digest {bound}; this request digests to {digest}',
  remedy:
    'send a new Idempotency-Key for a new request, or resend the original request unchanged to read its task',
  test: `${TEST}::submit_refuses_a_reused_key_for_another_request`,
});

const IDENTITY_UNREADABLE = cause({
  id: 'service-identity-unreadable',
  wire: 'service-not-ready',
  status: 503,
  code: 'config',
  failed: 'reading the deployed Weles service identity',
  cause:
    'the placement policy, the service-directory snapshot or the admission endpoint Stado publishes on this host is missing, unreadable, or names another release, host or endpoint',
  observed: '{answer}',
  remedy:
    'republish them with Stado on this host (stado host publish-placement-policy and the weles-admission forward), then send the task again; GET /worker/status names the failure as serviceIdentityFailure',
  test: `${TEST}::submit_refuses_when_the_service_identity_is_unpublished`,
});

const IDENTITY_MISMATCH = cause({
  id: 'service-identity-mismatch',
  wire: 'service-identity-mismatch',
  status: 403,
  code: 'refused',
  failed: 'admitting a task bound to service {bound}',
  cause:
    'spisBinding.service is not the service identity this worker is deployed as: Spis bound the attempt to another host, generation or release',
  observed: 'bound {bound}; deployed {deployed}',
  remedy:
    'have Spis read GET /api/v1/version again and bind the attempt to the identity it answers',
  test: `${TEST}::submit_refuses_a_binding_to_another_service_generation`,
});

const TARGET_UNRESOLVED = cause({
  id: 'target-unresolved',
  wire: 'network-target-denied',
  status: 403,
  code: 'not_found',
  failed: 'resolving the page host {host}',
  cause:
    'the host has no DNS answer: it does not exist, or this worker cannot reach a resolver',
  observed: '{answer}',
  remedy:
    'check the host name in input.product_url; if it resolves elsewhere, check the DNS configuration of the worker host',
  test: `${TEST}::submit_refuses_a_page_host_without_dns`,
});

const TARGET_NOT_PUBLIC = cause({
  id: 'target-not-public',
  wire: 'network-target-denied',
  status: 403,
  code: 'refused',
  failed: 'resolving the page host {host}',
  cause:
    'the host resolves to an address IANA does not declare globally reachable (loopback, private, link-local and the like), and a public task opens only public pages',
  observed: '{answer}',
  remedy:
    'send a page whose host resolves only to public addresses; a private page is opened through the operator API',
  test: `${TEST}::submit_refuses_a_page_host_on_a_private_address`,
});

const TARGET_REGISTRY = cause({
  id: 'address-registry-unreadable',
  wire: 'network-target-denied',
  status: 503,
  code: 'infra_down',
  failed: 'judging the addresses of {host}',
  cause:
    'the IANA special-purpose address registries could not be read, so no address can be judged public',
  observed: '{answer}',
  remedy:
    'let the worker host reach https://www.iana.org/assignments/ (directly or through its HTTPS_PROXY), then send the task again',
  test: `${TEST}::submit_refuses_when_the_address_registry_is_unreachable`,
});

const STATE_UNWRITABLE = cause({
  id: 'task-state-unwritable',
  wire: 'task-state-unwritable',
  status: 500,
  code: 'config',
  failed: 'recording the public task under {root}',
  cause:
    'the worker cannot write its task state: the directory is not writable by the service user, or the disk is full',
  observed: '{answer}',
  remedy:
    'give the service user write access to {root} and free space on its disk, then send the task again with the same Idempotency-Key',
  test: `${TEST}::submit_refuses_when_task_state_is_unwritable`,
});

const TASK_ID = cause({
  id: 'task-id-invalid',
  wire: 'invalid-task-id',
  status: 400,
  code: 'refused',
  failed: 'reading the task id in {path}',
  cause: 'a task id is the UUID the submission answered as taskId',
  observed: 'task id: {task_id}',
  remedy: 'use the taskId of the submission answer',
  test: `${TEST}::status_refuses_a_task_id_that_is_not_a_uuid`,
});

const TASK_NOT_FOUND = cause({
  id: 'task-not-found',
  wire: 'task-not-found',
  status: 404,
  code: 'not_found',
  failed: 'reading public task {task_id}',
  cause:
    'this worker holds no task of that id: it was submitted to another worker, or its state was removed',
  observed: 'no task-{task_id}.json under {root}',
  remedy:
    'read the task from the worker that answered its submission (its serviceIdentity names the host)',
  test: `${TEST}::status_refuses_a_task_this_worker_never_held`,
});

const WAIT_INVALID = cause({
  id: 'wait-invalid',
  wire: 'invalid-wait',
  status: 400,
  code: 'refused',
  failed: 'reading the wait parameter of {path}',
  cause: 'wait takes only the value terminal',
  observed: 'wait={wait}',
  remedy:
    'send ?wait=terminal to hold the answer until the task ends, or no wait to read it now',
  test: `${TEST}::status_refuses_a_wait_other_than_terminal`,
});

const RECORD_UNREADABLE = cause({
  id: 'task-record-unreadable',
  wire: 'task-record-unreadable',
  status: 500,
  code: 'config',
  failed: 'reading public task {task_id}',
  cause:
    'its record under the run results directory cannot be read by the service user, or is not a task of this organization: it was edited, truncated or written by another deployment',
  observed: '{answer}',
  remedy:
    'restore {file} from the worker host backup, or remove it so the task reads as not found',
  test: `${TEST}::status_refuses_a_task_record_that_is_not_json`,
});

const CANCELLATION_SCHEMA = cause({
  id: 'cancellation-schema-unsupported',
  wire: 'unsupported-cancellation-schema',
  status: 400,
  code: 'refused',
  failed: 'reading the cancellation',
  cause: 'the body is not an object whose schema is {expected}',
  observed: 'schema: {schema}',
  remedy: 'send a cancellation object with "schema": "{expected}"',
  test: `${TEST}::cancel_refuses_a_cancellation_of_another_schema`,
});

const CANCELLATION_FIELDS = cause({
  id: 'cancellation-fields-undeclared',
  wire: 'invalid-cancellation',
  status: 400,
  code: 'refused',
  failed: 'reading the cancellation',
  cause: 'its fields are not exactly the ones {schema} declares',
  observed: '{reasons}',
  remedy: 'send exactly the fields {declared}',
  test: `${TEST}::cancel_refuses_a_cancellation_with_undeclared_fields`,
});

const REASON = cause({
  id: 'cancellation-reason-empty',
  wire: 'invalid-cancellation',
  status: 400,
  code: 'refused',
  failed: 'reading the cancellation',
  cause: 'reason is not a non-empty string, and every cancellation records why',
  observed: 'reason: {value}',
  remedy: 'send one sentence saying who cancels the task and why',
  test: `${TEST}::cancel_refuses_a_cancellation_without_a_reason`,
});

const CANCELLATION_CONFLICT = cause({
  id: 'cancellation-conflict',
  wire: 'cancellation-conflict',
  status: 409,
  code: 'refused',
  failed: 'cancelling public task {task_id}',
  cause:
    'the task already has a cancellation under another Idempotency-Key or reason, and one task is cancelled once',
  observed:
    'recorded cancellation: key {recorded_key}, reason {recorded_reason}',
  remedy:
    'read the task with GET /api/v1/tasks/{task_id}; to retry the recorded cancellation, resend it with its key and reason',
  test: `${TEST}::cancel_refuses_a_second_cancellation_with_another_reason`,
});

const SUBMIT = Object.freeze({
  id: 'admission.submit',
  command: 'POST /api/v1/tasks',
  summary:
    'Admit one public browser-evidence task: the request is authenticated, its form and its Spis binding are checked, the deployed service identity and the page host are verified, and the task is recorded and queued.',
  causes: [
    MEDIA_TYPE_MISSING,
    MEDIA_TYPE_WRONG,
    BEARER_MISSING,
    BEARER_WRONG,
    RECOVERING,
    NOT_READY,
    DRAINING,
    IDEMPOTENCY_MISSING,
    IDEMPOTENCY_INVALID,
    BODY_NOT_JSON,
    TASK_SCHEMA,
    UNSAFE_NUMBER,
    LONE_SURROGATE,
    TASK_FIELDS,
    ORGANIZATION,
    ORIGIN_INVALID,
    ORIGIN_DENIED,
    ACTION_DENIED,
    INPUT_NOT_OBJECT,
    INPUT_FIELDS,
    PRODUCT_URL,
    TARGET_MISMATCH,
    OBJECTIVE,
    CONSTRAINTS,
    SPIS_NOT_OBJECT,
    SPIS_FIELDS,
    SPIS_SCHEMA,
    SPIS_ATTEMPT,
    SPIS_REVISION,
    SPIS_DIGEST,
    SPIS_SERVICE,
    SPIS_ENDPOINT,
    SPIS_COMPONENT,
    SPIS_CANONICAL,
    CREDENTIAL_REFS,
    CREDENTIAL_DENIED,
    EVIDENCE_POLICY,
    JUSTIFICATION,
    IDEMPOTENCY_CONFLICT,
    IDENTITY_UNREADABLE,
    IDENTITY_MISMATCH,
    TARGET_UNRESOLVED,
    TARGET_NOT_PUBLIC,
    TARGET_REGISTRY,
    STATE_UNWRITABLE,
  ],
});

const STATUS = Object.freeze({
  id: 'admission.status',
  command: 'GET /api/v1/tasks/<task-id>',
  summary:
    'Read one public task, or with ?wait=terminal hold the answer until it ends; a terminal task carries its signed receipt.',
  causes: [
    BEARER_MISSING,
    BEARER_WRONG,
    TASK_ID,
    WAIT_INVALID,
    TASK_NOT_FOUND,
    RECORD_UNREADABLE,
  ],
});

const CANCEL = Object.freeze({
  id: 'admission.cancel',
  command: 'POST /api/v1/tasks/<task-id>/cancel',
  summary:
    'Cancel one public task: a queued task ends cancelled at once, a running one is stopped and ends cancelled, a terminal one is answered as it ended.',
  causes: [
    MEDIA_TYPE_MISSING,
    MEDIA_TYPE_WRONG,
    BEARER_MISSING,
    BEARER_WRONG,
    IDEMPOTENCY_MISSING,
    IDEMPOTENCY_INVALID,
    BODY_NOT_JSON,
    CANCELLATION_SCHEMA,
    CANCELLATION_FIELDS,
    ORGANIZATION,
    REASON,
    TASK_ID,
    TASK_NOT_FOUND,
    CANCELLATION_CONFLICT,
  ],
});

module.exports = {
  SUBMIT,
  STATUS,
  CANCEL,
  causes: Object.freeze({
    MEDIA_TYPE_MISSING,
    MEDIA_TYPE_WRONG,
    BEARER_MISSING,
    BEARER_WRONG,
    RECOVERING,
    NOT_READY,
    DRAINING,
    IDEMPOTENCY_MISSING,
    IDEMPOTENCY_INVALID,
    BODY_NOT_JSON,
    TASK_SCHEMA,
    UNSAFE_NUMBER,
    LONE_SURROGATE,
    TASK_FIELDS,
    ORGANIZATION,
    ORIGIN_INVALID,
    ORIGIN_DENIED,
    ACTION_DENIED,
    INPUT_NOT_OBJECT,
    INPUT_FIELDS,
    PRODUCT_URL,
    TARGET_MISMATCH,
    OBJECTIVE,
    CONSTRAINTS,
    SPIS_NOT_OBJECT,
    SPIS_FIELDS,
    SPIS_SCHEMA,
    SPIS_ATTEMPT,
    SPIS_REVISION,
    SPIS_DIGEST,
    SPIS_SERVICE,
    SPIS_ENDPOINT,
    SPIS_COMPONENT,
    SPIS_CANONICAL,
    CREDENTIAL_REFS,
    CREDENTIAL_DENIED,
    EVIDENCE_POLICY,
    JUSTIFICATION,
    IDEMPOTENCY_CONFLICT,
    IDENTITY_UNREADABLE,
    IDENTITY_MISMATCH,
    TARGET_UNRESOLVED,
    TARGET_NOT_PUBLIC,
    TARGET_REGISTRY,
    STATE_UNWRITABLE,
    TASK_ID,
    TASK_NOT_FOUND,
    WAIT_INVALID,
    RECORD_UNREADABLE,
    CANCELLATION_SCHEMA,
    CANCELLATION_FIELDS,
    REASON,
    CANCELLATION_CONFLICT,
  }),
};
