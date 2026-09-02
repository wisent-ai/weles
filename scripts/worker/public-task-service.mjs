import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signPayload,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  lstat,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const TASK_SCHEMA = 'weles.task.current';
const CANCELLATION_SCHEMA = 'weles.cancellation.current';
const STATUS_SCHEMA = 'weles.task-status.v1';
const RECEIPT_SCHEMA = 'weles.receipt.current';
const VERSION_SCHEMA = 'weles.version.v1';
const EVIDENCE_SCHEMA = 'weles.browser-evidence-manifest.v1';
const NON_SUCCESS_EVIDENCE_SCHEMA = 'weles.browser-evidence-manifest.v2';
const EVIDENCE_PATH_COMPONENT_RE = /^[A-Za-z0-9._-]+$/;
const PUBLIC_ACTION = 'generic_browser_task';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const SENSITIVE_KEY_RE = /password|secret|token|cookie|authorization|proxy.?auth/i;
const SAFE_INPUT_KEYS = Object.freeze({
  constraints: true,
  objective: true,
  product_url: true,
  spisBinding: true,
});
const TERMINAL_STATUSES = Object.freeze({ succeeded: true, failed: true, cancelled: true });
const MAX_TEXT = 4_000;
const MAX_OBJECT_KEYS = 128;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_EVIDENCE_FILES = 10_000;
const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_WITHHELD_EDGE_BYTES = 2 * 1024 * 1024;
const MAX_WITHHELD_EDGES = 2_048;
const RECEIPT_MANIFEST_NAME = 'evidence-manifest.json';
const WITHHELD_EDGES_NAME = 'browser_evidence_withheld_edges.ndjson';
const POLICY_FILE_NAME = 'browser_evidence_policy.json';

class PublicTaskError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
class EvidenceRetentionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requiredEnvironment(name, environment) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`missing required ${name}`);
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Exact request/receipt digest intersection: RFC 8785 JSON ordering and
// serialization, restricted to null, booleans, strings, safe integers, arrays,
// and plain objects. IEEE-754 fractional values are deliberately outside the
// public contract so producer and verifier cannot round the same request apart.
function canonicalJson(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new PublicTaskError(400, 'invalid-json-number', 'canonical public JSON permits safe integers only');
  }
  if (typeof value === 'string' && containsLoneSurrogate(value)) {
    throw new PublicTaskError(400, 'invalid-json-string', 'canonical public JSON rejects lone UTF-16 surrogates');
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.some(containsLoneSurrogate)) {
      throw new PublicTaskError(400, 'invalid-json-string', 'canonical public JSON rejects lone UTF-16 surrogates');
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new PublicTaskError(400, 'invalid-json', 'request contains a non-JSON value');
  return encoded;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function digest(value) {
  return `sha256:${sha256(value)}`;
}
function sha256Text(value) {
  return sha256(Buffer.from(value, 'utf8'));
}

function constantTimeTextEqual(actual, expected) {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function parseAllowedOrigins(raw) {
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('WELES_PUBLIC_API_ALLOWED_ORIGINS must not be empty');
  if (entries.includes('*')) {
    if (entries.length !== 1) throw new Error('WELES_PUBLIC_API_ALLOWED_ORIGINS wildcard must stand alone');
    return new Set(['*']);
  }
  const origins = entries.map((entry) => {
    const parsed = new URL(entry);
    if (parsed.protocol !== 'https:' || parsed.origin !== entry) {
      throw new Error('WELES_PUBLIC_API_ALLOWED_ORIGINS entries must be exact HTTPS origins');
    }
    return entry;
  });
  return new Set(origins);
}

function normalizePublicKey(value) {
  return createPublicKey(value).export({ format: 'der', type: 'spki' }).toString('base64');
}

function loadConfig(environment, policy) {
  const bearer = requiredEnvironment('WELES_PUBLIC_API_BEARER', environment);
  if (Buffer.byteLength(bearer) < 32) throw new Error('WELES_PUBLIC_API_BEARER must contain at least 32 bytes');
  const organizationId = requiredEnvironment('WELES_PUBLIC_API_ORGANIZATION_ID', environment);
  if (!UUID_RE.test(organizationId)) throw new Error('WELES_PUBLIC_API_ORGANIZATION_ID must be a UUID');
  const keyId = requiredEnvironment('WELES_RECEIPT_KEY_ID', environment);
  const keySetVersion = requiredEnvironment('WELES_RECEIPT_KEY_SET_VERSION', environment);
  const privateKey = createPrivateKey(requiredEnvironment('WELES_RECEIPT_PRIVATE_KEY', environment));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('WELES_RECEIPT_PRIVATE_KEY must be Ed25519');
  const keySetValue = JSON.parse(requiredEnvironment('WELES_RECEIPT_PUBLIC_KEYS_JSON', environment));
  if (!isObject(keySetValue) || Object.keys(keySetValue).length === 0) {
    throw new Error('WELES_RECEIPT_PUBLIC_KEYS_JSON must be a non-empty object');
  }
  const publicKey = keySetValue[keyId];
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error('WELES_RECEIPT_PUBLIC_KEYS_JSON does not carry WELES_RECEIPT_KEY_ID');
  }
  const derivedPublicKey = createPublicKey(privateKey);
  if (!constantTimeTextEqual(normalizePublicKey(publicKey), normalizePublicKey(derivedPublicKey))) {
    throw new Error('receipt private key does not match its out-of-band public key set');
  }
  if (!isObject(policy) || typeof policy.version !== 'string') throw new Error('browser-evidence policy is invalid');
  return Object.freeze({
    bearer,
    organizationId,
    keyId,
    keySetVersion,
    privateKey,
    allowedOrigins: parseAllowedOrigins(requiredEnvironment('WELES_PUBLIC_API_ALLOWED_ORIGINS', environment)),
    policy,
    policyDigest: digest(canonicalJson(policy)),
  });
}

function assertBoundedJson(value, path = 'input', depth = 0) {
  if (depth > 16) throw new PublicTaskError(400, 'invalid-input', `${path} is too deeply nested`);
  if (typeof value === 'string' && value.length > MAX_TEXT) {
    throw new PublicTaskError(400, 'invalid-input', `${path} exceeds ${MAX_TEXT} characters`);
  }
  if (typeof value === 'string' && containsLoneSurrogate(value)) {
    throw new PublicTaskError(400, 'invalid-input', `${path} rejects lone UTF-16 surrogates`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new PublicTaskError(400, 'invalid-input', `${path} permits safe integers only`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new PublicTaskError(400, 'invalid-input', `${path} has too many entries`);
    value.forEach((entry, index) => assertBoundedJson(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) throw new PublicTaskError(400, 'invalid-input', `${path} has too many keys`);
  for (const [key, entry] of entries) {
    if (containsLoneSurrogate(key)) {
      throw new PublicTaskError(400, 'invalid-input', `${path} contains a key with a lone UTF-16 surrogate`);
    }
    if (SENSITIVE_KEY_RE.test(key)) {
      throw new PublicTaskError(400, 'sensitive-input-denied', `plaintext secret-shaped field denied at ${path}.${key}`);
    }
    assertBoundedJson(entry, `${path}.${key}`, depth + 1);
  }
}

function exactHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new PublicTaskError(400, 'invalid-origin', 'origin must be an exact HTTPS origin');
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new PublicTaskError(400, 'invalid-origin', 'origin must be an exact HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== value) {
    throw new PublicTaskError(400, 'invalid-origin', 'origin must be an exact HTTPS origin');
  }
  return value;
}

function exactPublicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4_096) {
    throw new PublicTaskError(400, 'invalid-input', 'input.product_url must be a bounded public HTTPS URL');
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new PublicTaskError(400, 'invalid-input', 'input.product_url must be a bounded public HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.toString() !== value) {
    throw new PublicTaskError(400, 'invalid-input', 'input.product_url must be exact canonical HTTPS without credentials');
  }
  return parsed.toString();
}

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

function parseSpisBinding(value) {
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

function parseTaskRequest(body, config) {
  if (!isObject(body) || body.schema !== TASK_SCHEMA) {
    throw new PublicTaskError(400, 'unsupported-task-schema', 'unsupported task schema');
  }
  assertBoundedJson(body, 'task');
  const allowedKeys = Object.freeze({
    action: true,
    credentialRefs: true,
    evidencePolicy: true,
    input: true,
    justification: true,
    organizationId: true,
    origin: true,
    schema: true,
  });
  if (Object.keys(body).some((key) => !Object.hasOwn(allowedKeys, key)) || Object.keys(body).length !== 8) {
    throw new PublicTaskError(400, 'invalid-task', 'task has missing or unknown fields');
  }
  if (body.organizationId !== config.organizationId) {
    throw new PublicTaskError(403, 'organization-denied', 'organizationId is outside the authenticated tenant');
  }
  const origin = exactHttpsOrigin(body.origin);
  if (!config.allowedOrigins.has('*') && !config.allowedOrigins.has(origin)) {
    throw new PublicTaskError(403, 'origin-denied', 'origin is not allowed by service policy');
  }
  if (body.action !== PUBLIC_ACTION) {
    throw new PublicTaskError(403, 'action-denied', 'action is not allowed by service policy');
  }
  if (!isObject(body.input)) throw new PublicTaskError(400, 'invalid-input', 'input must be an object');
  if (Object.keys(body.input).length !== 4
      || Object.keys(body.input).some((key) => !Object.hasOwn(SAFE_INPUT_KEYS, key))) {
    throw new PublicTaskError(400, 'invalid-input', 'input must contain every-and-only product_url, objective, constraints, and spisBinding');
  }
  assertBoundedJson(body.input);
  const url = exactPublicHttpsUrl(body.input.product_url);
  if (new URL(url).origin !== origin) {
    throw new PublicTaskError(403, 'origin-target-mismatch', 'task origin must equal the exact browser target origin');
  }
  if (typeof body.input.objective !== 'string' || !body.input.objective.trim() || body.input.objective.length > MAX_TEXT) {
    throw new PublicTaskError(400, 'invalid-input', 'input.objective must be a bounded non-empty string');
  }
  if (body.input.headless !== undefined && body.input.headless !== true) {
    throw new PublicTaskError(400, 'invalid-input', 'browser-evidence tasks require headless=true');
  }
  if (body.input.browser !== undefined && body.input.browser !== 'chromium') {
    throw new PublicTaskError(400, 'invalid-input', 'browser-evidence tasks require browser=chromium');
  }
  if (!Array.isArray(body.input.constraints)
      || canonicalJson(body.input.constraints) !== canonicalJson(config.policy.constraints)) {
    throw new PublicTaskError(400, 'invalid-input', 'input.constraints must equal the exact typed browser-evidence constraint array');
  }
  const spisBinding = parseSpisBinding(body.input.spisBinding);
  if (!Array.isArray(body.credentialRefs) || body.credentialRefs.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new PublicTaskError(400, 'invalid-credential-refs', 'credentialRefs must be a string array');
  }
  if (body.credentialRefs.length !== 0) {
    throw new PublicTaskError(403, 'credential-refs-denied', 'browser-evidence tasks cannot receive credential references');
  }
  if (body.evidencePolicy !== 'full') {
    throw new PublicTaskError(400, 'invalid-evidence-policy', 'browser-evidence tasks require evidencePolicy=full');
  }
  if (typeof body.justification !== 'string' || !body.justification.trim() || body.justification.length > 2_000) {
    throw new PublicTaskError(400, 'invalid-justification', 'justification must be a bounded non-empty string');
  }
  const request = {
    schema: body.schema,
    organizationId: body.organizationId,
    origin: body.origin,
    action: body.action,
    input: { ...body.input, product_url: url, spisBinding },
    credentialRefs: [],
    evidencePolicy: body.evidencePolicy,
    justification: body.justification,
  };
  return {
    request,
    requestDigest: digest(canonicalJson(request)),
    spisBinding,
    executionInput: {
      url,
      objective: body.input.objective,
      flow_name: 'artifacts',
      headless: true,
      browser: 'chromium',
      proxy: 'none',
      constraints: [...config.policy.constraints],
    },
  };
}

function parseCancellation(body, config) {
  if (!isObject(body) || body.schema !== CANCELLATION_SCHEMA) {
    throw new PublicTaskError(400, 'unsupported-cancellation-schema', 'unsupported cancellation schema');
  }
  assertBoundedJson(body, 'cancellation');
  const allowedKeys = Object.freeze({ organizationId: true, reason: true, schema: true });
  if (Object.keys(body).some((key) => !Object.hasOwn(allowedKeys, key)) || Object.keys(body).length !== 3) {
    throw new PublicTaskError(400, 'invalid-cancellation', 'cancellation has missing or unknown fields');
  }
  if (body.organizationId !== config.organizationId) {
    throw new PublicTaskError(403, 'organization-denied', 'organizationId is outside the authenticated tenant');
  }
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2_000) {
    throw new PublicTaskError(400, 'invalid-cancellation', 'reason must be a bounded non-empty string');
  }
  return { organizationId: config.organizationId, reason: body.reason };
}

function idempotencyKey(request) {
  const value = String(request.headers['idempotency-key'] ?? '');
  if (!IDEMPOTENCY_RE.test(value)) {
    throw new PublicTaskError(400, 'invalid-idempotency-key', 'valid Idempotency-Key header is required');
  }
  return value;
}

function bearerAuthorized(request, expected) {
  const authorization = String(request.headers.authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(match && constantTimeTextEqual(match[1], expected));
}

function publicStatus(task, dispatcher) {
  const terminal = Object.hasOwn(TERMINAL_STATUSES, task.status);
  if (terminal && !task.receipt) {
    throw new Error('terminal public task has no retained-evidence receipt');
  }
  const base = {
    schema: STATUS_SCHEMA,
    taskId: task.id,
    organizationId: task.request.organizationId,
    origin: task.request.origin,
    action: task.request.action,
    status: task.status,
    serviceIdentity: task.serviceIdentity,
    dispatcher,
    requestIdentity: {
      requestDigest: task.requestDigest,
      spisBinding: task.spisBinding,
    },
  };
  if (!terminal) return base;
  return {
    ...base,
    outcome: task.status === 'succeeded' ? 'completed' : task.status,
    resultDigest: task.resultDigest,
    receipt: task.receipt,
  };
}

function safeTaskFilename(taskId) {
  if (!UUID_RE.test(taskId)) throw new PublicTaskError(400, 'invalid-task-id', 'invalid taskId');
  return `task-${taskId.toLowerCase()}.json`;
}

async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function atomicJsonWrite(path, document) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicBufferWrite(path, body) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function stableMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function hashStableFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new EvidenceRetentionError('evidence-file-unsafe', `evidence path is not a regular file: ${path}`);
  if (before.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new EvidenceRetentionError('evidence-file-too-large', `evidence file exceeds the per-file limit: ${path}`);
  }
  const hasher = createHash('sha256');
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.once('error', rejectHash);
    stream.once('end', resolveHash);
  });
  const after = await lstat(path);
  if (!stableMetadata(before, after)) throw new EvidenceRetentionError('evidence-file-unstable', `evidence file changed while hashing: ${path}`);
  return { bytes: after.size, sha256: hasher.digest('hex'), metadata: after };
}

async function collectEvidenceFiles(root) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new EvidenceRetentionError('evidence-root-unsafe', 'evidence root is not a regular directory');
  const files = [];
  const stack = [{ directory: root, relative: '' }];
  let totalBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!EVIDENCE_PATH_COMPONENT_RE.test(entry.name)) {
        throw new EvidenceRetentionError(
          'evidence-path-unsafe',
          `evidence path component is not portable: ${entry.name}`,
        );
      }
      if (entry.isSymbolicLink()) throw new EvidenceRetentionError('evidence-symlink', `symlink is forbidden in evidence: ${entry.name}`);
      const fullPath = join(current.directory, entry.name);
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push({ directory: fullPath, relative: relativePath });
        continue;
      }
      if (!entry.isFile()) throw new EvidenceRetentionError('evidence-entry-unsafe', `non-regular evidence entry is forbidden: ${relativePath}`);
      if (entry.name === RECEIPT_MANIFEST_NAME || entry.name === '.uploaded.json') continue;
      if (files.length >= MAX_EVIDENCE_FILES) {
        throw new EvidenceRetentionError('evidence-file-count-exceeded', 'evidence file count exceeds the limit');
      }
      const hashed = await hashStableFile(fullPath);
      totalBytes += hashed.bytes;
      if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
        throw new EvidenceRetentionError('evidence-total-too-large', 'evidence bytes exceed the total limit');
      }
      files.push({
        path: relativePath,
        bytes: hashed.bytes,
        sha256: hashed.sha256,
        fullPath,
        metadata: hashed.metadata,
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}


async function retainedWithheldEdges(files) {
  const edges = [];
  let bytes = 0;
  for (const file of files.filter((candidate) => basename(candidate.path) === WITHHELD_EDGES_NAME)) {
    bytes += file.bytes;
    if (bytes > MAX_WITHHELD_EDGE_BYTES) throw new EvidenceRetentionError('withheld-edge-bytes-exceeded', 'withheld-edge evidence exceeds the byte limit');
    const lines = (await readFile(file.fullPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (edges.length >= MAX_WITHHELD_EDGES) throw new EvidenceRetentionError('withheld-edge-count-exceeded', 'withheld-edge evidence exceeds the edge limit');
      try {
        const edge = JSON.parse(line);
        if (!isObject(edge)) throw new Error('edge is not an object');
        edges.push(edge);
      } catch {
        throw new EvidenceRetentionError('withheld-edge-malformed', `withheld-edge evidence is not valid NDJSON: ${file.path}`);
      }
    }
  }
  return edges;
}

function receiptFor(task, evidenceDigest, config) {
  const outcome = task.completion.status === 'succeeded'
    ? 'completed'
    : task.completion.status;
  const coreClaims = {
    taskId: task.id,
    organizationId: task.request.organizationId,
    origin: task.request.origin,
    action: task.request.action,
    outcome,
    evidenceDigest,
  };
  const claims = {
    ...coreClaims,
    requestDigest: task.requestDigest,
    resultDigest: task.completion.resultDigest,
    spisBinding: task.spisBinding,
  };
  const signedPayload = canonicalJson(claims);
  const signature = signPayload(null, Buffer.from(signedPayload, 'utf8'), config.privateKey).toString('base64');
  return {
    schema: RECEIPT_SCHEMA,
    ...coreClaims,
    requestDigest: task.requestDigest,
    resultDigest: task.completion.resultDigest,
    spisBinding: task.spisBinding,
    keyId: config.keyId,
    signature,
    signedPayload,
  };
}

function terminalCompletion(output, aborted, _redact, requestedUrl = null) {
  let completion;
  if (aborted || output?.cancelled) {
    completion = { status: 'cancelled', result: { state: 'cancelled' }, error: null, capture: null };
  } else if (output?.ok) {
    const captureResult = isObject(output.result) ? output.result : null;
    let effectiveUrl = null;
    let finalUrl = null;
    try {
      effectiveUrl = typeof captureResult?.url === 'string' ? new URL(captureResult.url).toString() : null;
      finalUrl = typeof captureResult?.final_url === 'string' ? new URL(captureResult.final_url).toString() : null;
    } catch {}
    const captureValid = typeof requestedUrl === 'string'
      && effectiveUrl === requestedUrl
      && typeof finalUrl === 'string'
      && new URL(finalUrl).origin === new URL(requestedUrl).origin;
    if (!captureValid) {
      completion = {
        status: 'failed',
        result: { state: 'failed', executionRunId: output.run_id ?? null },
        error: 'browser evidence capture identity is missing or inconsistent',
        capture: { requestedUrl, effectiveUrl, finalUrl },
      };
    } else {
      const value = { requestedUrl, effectiveUrl, finalUrl };
      completion = {
        status: 'succeeded',
        result: { state: 'succeeded', value, executionRunId: output.run_id },
        error: null,
        capture: value,
      };
    }
  } else {
    const failure = output?.timed_out ? 'browser evidence task timed out' : 'browser evidence task failed';
    completion = {
      status: 'failed',
      result: { state: 'failed', executionRunId: output?.run_id ?? null },
      error: failure,
      capture: { requestedUrl, effectiveUrl: null, finalUrl: null },
    };
  }
  return { ...completion, resultDigest: digest(canonicalJson(completion.result)) };
}

function publicEvidenceKind(path) {
  const name = basename(path);
  if (name === 'browser_evidence_final.png') return 'screenshot';
  if (name === 'browser_evidence_accessibility_tree.txt') return 'accessibility_tree';
  return `artifact:${path}`;
}

function publicEvidenceInventory(files, taskId) {
  return files.map((file) => ({
    kind: publicEvidenceKind(file.path),
    uri: `stado://weles/recordings/${taskId}/${file.path}`,
    sha256: file.sha256,
    bytes: file.bytes,
  }));
}

export function createPublicTaskService(options) {
  const config = loadConfig(options.environment ?? process.env, options.policy);
  const taskRoot = join(options.runResultsRoot, 'public-tasks');
  const mappingRoot = join(taskRoot, 'idempotency');
  const active = new Map();
  const taskLocks = new Map();
  const identity = options.releaseIdentity;
  const expectedReleaseId = `weles-worker@${identity.release_version ?? ''}`;
  if (options.concurrency !== 1) {
    throw new Error('public task concurrency must be exactly 1');
  }
  if (!Number.isSafeInteger(options.taskTimeoutMs)
      || options.taskTimeoutMs < 15 * 60 * 1_000
      || options.taskTimeoutMs > 6 * 60 * 60 * 1_000) {
    throw new Error('public task timeout must be between 15 minutes and 6 hours');
  }
  const queue = [];
  const queued = new Set();
  let dispatching = false;
  let dispatcherHealthy = true;
  let draining = false;
  function dispatcherStatus() {
    return {
      configuredConcurrency: options.concurrency,
      taskTimeoutMs: options.taskTimeoutMs,
      active: active.size,
      queued: queue.length,
      healthy: dispatcherHealthy,
    };
  }

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
    trajectory: options.trajectoryReady === true,
    artifactRetention: options.artifactRetentionReady === true,
  });
  const staticReady = Object.values(staticReadiness).every(Boolean);
  let identityReady = false;
  let lastServiceIdentity = null;
  const readinessStatus = () => ({ ...staticReadiness, serviceIdentity: identityReady });
  const taskPath = (taskId) => join(taskRoot, safeTaskFilename(taskId));
  const mappingPath = (key) => join(mappingRoot, `${sha256(`${config.organizationId}\0${key}`)}.json`);

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

  async function currentServiceIdentity() {
    try {
      lastServiceIdentity = validatedServiceIdentity(await options.readServiceIdentity());
      identityReady = true;
      return lastServiceIdentity;
    } catch (error) {
      identityReady = false;
      lastServiceIdentity = null;
      throw error;
    }
  }

  async function ensureRoots() {
    await mkdir(options.runResultsRoot, { recursive: true, mode: 0o700 });
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(options.runResultsRoot);
    await mkdir(mappingRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(taskRoot);
    await syncDirectory(mappingRoot);
  }

  async function loadTask(taskId) {
    try {
      const task = await readJson(taskPath(taskId));
      if (!isObject(task)
          || task.id !== taskId
          || task.request?.organizationId !== config.organizationId
          || typeof task.requestDigest !== 'string'
          || !isObject(task.spisBinding)
          || !isObject(task.serviceIdentity)) {
        throw new Error('public task document failed identity validation');
      }
      return task;
    } catch (error) {
      if (error?.code === 'ENOENT') throw new PublicTaskError(404, 'task-not-found', 'not found');
      throw error;
    }
  }

  async function persistTask(task) {
    task.updatedAt = new Date().toISOString();
    await atomicJsonWrite(taskPath(task.id), task);
  }

  async function withTaskLock(taskId, operation) {
    const previous = taskLocks.get(taskId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    const current = previous.then(() => gate);
    taskLocks.set(taskId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (taskLocks.get(taskId) === current) taskLocks.delete(taskId);
    }
  }

  function validateReservation(reservation) {
    if (!isObject(reservation)
        || reservation.schema !== 'weles.public-task-reservation.v1'
        || !UUID_RE.test(reservation.taskId ?? '')
        || typeof reservation.requestDigest !== 'string'
        || !isObject(reservation.task)
        || reservation.task.id !== reservation.taskId
        || reservation.task.requestDigest !== reservation.requestDigest
        || reservation.task.request?.organizationId !== config.organizationId) {
      throw new Error('public task reservation failed validation');
    }
    return reservation;
  }

  async function materializeReservation(reservation) {
    try {
      const task = await loadTask(reservation.taskId);
      if (task.requestDigest !== reservation.requestDigest) {
        throw new Error('public task reservation disagrees with task state');
      }
      return task;
    } catch (error) {
      if (!(error instanceof PublicTaskError) || error.status !== 404) throw error;
      await persistTask(reservation.task);
      return reservation.task;
    }
  }

  async function readReservation(key) {
    try {
      return validateReservation(await readJson(mappingPath(key)));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function createReservation(key, task) {
    await ensureRoots();
    const path = mappingPath(key);
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    try {
      const reservation = {
        schema: 'weles.public-task-reservation.v1',
        taskId: task.id,
        requestDigest: task.requestDigest,
        task,
      };
      await handle.writeFile(`${JSON.stringify(reservation, null, 2)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(path, { force: true });
      await syncDirectory(mappingRoot);
      throw error;
    }
    await handle.close();
    await syncDirectory(mappingRoot);
    return true;
  }

  async function convertEvidenceFailure(task, error) {
    const runRoot = join(options.recordingsRoot, task.id);
    const failureRoot = join(
      options.recordingsRoot,
      '.public-task-retention-failures',
      `${task.id}-${Date.now()}`,
    );
    await mkdir(dirname(failureRoot), { recursive: true, mode: 0o700 });
    await rename(runRoot, failureRoot);
    await syncDirectory(dirname(failureRoot));
    const diagnosticRoot = join(runRoot, 'artifacts');
    await mkdir(diagnosticRoot, { recursive: true, mode: 0o700 });
    const code = error instanceof EvidenceRetentionError ? error.code : 'storage-retries-exhausted';
    const diagnostic = {
      schema: 'weles.browser-evidence-retention-failure.v1',
      taskId: task.id,
      outcome: 'failed',
      code,
      message: String(error?.message ?? error).slice(0, 1_000),
      limits: {
        manifestBytes: MAX_EVIDENCE_MANIFEST_BYTES,
        inventoryBytes: MAX_EVIDENCE_TOTAL_BYTES,
        fileBytes: MAX_EVIDENCE_FILE_BYTES,
      },
    };
    await atomicBufferWrite(
      join(diagnosticRoot, 'browser_evidence_retention_failure.json'),
      Buffer.from(`${canonicalJson(diagnostic)}\n`, 'utf8'),
    );
    const result = { state: 'failed', executionRunId: task.id };
    task.completion = {
      status: 'failed',
      result,
      resultDigest: digest(canonicalJson(result)),
      error: `browser evidence retention failed: ${code}`,
      capture: task.completion?.capture ?? null,
      completedAt: new Date().toISOString(),
    };
    task.retentionFailure = { code, quarantinedAt: new Date().toISOString() };
    task.retentionAttempts = 0;
    await persistTask(task);
  }

  async function finalize(task) {
    if (!task.completion || task.receipt) return task;
    const runRoot = join(options.recordingsRoot, task.id);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(options.recordingsRoot);
    let files;
    try {
      files = await collectEvidenceFiles(runRoot);
    } catch (error) {
      if (!(error instanceof EvidenceRetentionError)) throw error;
      await convertEvidenceFailure(task, error);
      files = await collectEvidenceFiles(runRoot);
    }
    const evidenceInventory = publicEvidenceInventory(files, task.id);
    if (task.completion.status === 'succeeded') {
      const screenshot = evidenceInventory.find((entry) => entry.kind === 'screenshot');
      const accessibilityTree = evidenceInventory.find((entry) => entry.kind === 'accessibility_tree');
      if (!screenshot || !accessibilityTree || screenshot.bytes <= 0 || accessibilityTree.bytes <= 0) {
        throw new EvidenceRetentionError('required-evidence-missing', 'successful browser-evidence task lacks required screenshot or accessibility tree');
      }
      if (!files.some((file) => basename(file.path) === POLICY_FILE_NAME)) {
        throw new EvidenceRetentionError('policy-evidence-missing', 'successful browser-evidence task has no retained policy document');
      }
    }
    const kinds = evidenceInventory.map((entry) => entry.kind);
    const uris = evidenceInventory.map((entry) => entry.uri);
    if (new Set(kinds).size !== kinds.length || new Set(uris).size !== uris.length) {
      throw new EvidenceRetentionError('evidence-identity-duplicate', 'evidence inventory kind and URI identities must be unique');
    }
    const withheldEdges = await retainedWithheldEdges(files);
    const successful = task.completion.status === 'succeeded';
    const manifest = {
      schema: successful ? EVIDENCE_SCHEMA : NON_SUCCESS_EVIDENCE_SCHEMA,
      taskId: task.id,
      organizationId: task.request.organizationId,
      origin: task.request.origin,
      action: task.request.action,
      outcome: successful ? 'completed' : task.completion.status,
      requestDigest: task.requestDigest,
      resultDigest: task.completion.resultDigest,
      spisBinding: task.spisBinding,
      requestedUrl: task.executionInput.url,
      ...(successful ? {
        effectiveUrl: task.completion.capture.effectiveUrl,
        finalUrl: task.completion.capture.finalUrl,
      } : {}),
      evidenceInventory,
    };
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
    if (manifestBytes.byteLength > MAX_EVIDENCE_MANIFEST_BYTES) {
      throw new EvidenceRetentionError('evidence-manifest-too-large', 'canonical evidence manifest exceeds the 4 MiB limit');
    }
    const manifestPath = join(runRoot, RECEIPT_MANIFEST_NAME);
    try {
      const metadata = await lstat(manifestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_EVIDENCE_MANIFEST_BYTES) {
        throw new EvidenceRetentionError('evidence-manifest-unsafe', 'existing evidence manifest is unsafe or oversized');
      }
      const existing = await readFile(manifestPath);
      if (!existing.equals(manifestBytes)) {
        throw new EvidenceRetentionError('evidence-manifest-conflict', 'existing evidence manifest disagrees with recomputed immutable task identity');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await atomicBufferWrite(manifestPath, manifestBytes);
    }

    const locators = await options.uploadArtifacts(task.id);
    const manifestUri = `stado://weles/recordings/${task.id}/${RECEIPT_MANIFEST_NAME}`;
    const retained = locators && Object.values(locators).some((entries) => Array.isArray(entries) && entries.includes(manifestUri));
    if (!retained) throw new Error('durable artifact storage did not acknowledge the exact evidence manifest');
    const stableFiles = await collectEvidenceFiles(runRoot);
    const stableInventory = publicEvidenceInventory(stableFiles, task.id);
    if (canonicalJson(stableInventory) !== canonicalJson(evidenceInventory)) {
      throw new EvidenceRetentionError('evidence-changed', 'evidence changed between hashing and durable retention');
    }
    const manifestReadback = await options.readArtifactIdentity(manifestUri, MAX_EVIDENCE_MANIFEST_BYTES);
    if (manifestReadback.bytes !== manifestBytes.byteLength
        || manifestReadback.sha256 !== sha256(manifestBytes)) {
      throw new Error('durable evidence manifest readback differs from the retained canonical bytes');
    }
    for (const entry of evidenceInventory) {
      const readback = await options.readArtifactIdentity(entry.uri, MAX_EVIDENCE_FILE_BYTES);
      if (readback.bytes !== entry.bytes || readback.sha256 !== entry.sha256) {
        throw new Error(`durable evidence readback differs from inventory: ${entry.kind}`);
      }
    }
    const stableWithheldEdges = await retainedWithheldEdges(stableFiles);
    if (canonicalJson(stableWithheldEdges) !== canonicalJson(withheldEdges)) {
      throw new EvidenceRetentionError('withheld-edge-changed', 'withheld-edge evidence changed before receipt signing');
    }

    const evidenceDigest = sha256(manifestBytes);
    const receipt = receiptFor(task, evidenceDigest, config);
    task.status = task.completion.status;
    task.resultDigest = task.completion.resultDigest;
    task.result = {
      ...task.completion.result,
      evidenceManifest: { uri: manifestUri, sha256: evidenceDigest },
      withheldEdgeCount: withheldEdges.length,
    };
    task.captureIdentity = task.completion.capture;
    task.error = task.completion.error;
    task.receipt = receipt;
    task.evidence = {
      manifestUri,
      sha256: evidenceDigest,
      inventory: evidenceInventory,
      keyId: config.keyId,
      keySetVersion: config.keySetVersion,
      policyVersion: config.policy.version,
      policyDigest: config.policyDigest,
      requestDigest: task.requestDigest,
      resultDigest: task.completion.resultDigest,
      spisBinding: task.spisBinding,
    };
    delete task.evidenceError;
    await persistTask(task);
    return task;
  }

  async function retainCompletion(task) {
    try {
      return await finalize(task);
    } catch (error) {
      if (error instanceof EvidenceRetentionError && !task.retentionFailure) {
        await convertEvidenceFailure(task, error);
        try {
          return await finalize(task);
        } catch (retryError) {
          error = retryError;
        }
      }
      task.retentionAttempts = Number(task.retentionAttempts ?? 0) + 1;
      if (task.retentionAttempts >= 3 && !task.retentionFailure) {
        await convertEvidenceFailure(
          task,
          new EvidenceRetentionError('storage-retries-exhausted', 'durable evidence retention retries were exhausted'),
        );
        try {
          return await finalize(task);
        } catch {
          task.retentionAttempts = 3;
        }
      }
      task.evidenceError = task.retentionFailure
        ? 'failed evidence receipt retention is pending'
        : 'evidence retention is pending';
      await persistTask(task);
      return task;
    }
  }

  async function executeTask(taskId, controller) {
    let output;
    try {
      const task = await loadTask(taskId);
      output = await options.runTrajectory({
        action: task.request.action,
        params: task.executionInput,
        runId: task.id,
        signal: controller.signal,
        policy: config.policy,
        networkTarget: task.networkTarget,
      });
    } catch {
      output = { ok: false, run_id: taskId, result: null, timed_out: false };
    }
    await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (task.receipt) return;
      const cancellationWins = Boolean(task.cancellation) || controller.signal.aborted;
      task.completion = {
        ...terminalCompletion(output, cancellationWins, options.redact, task.executionInput.url),
        completedAt: new Date().toISOString(),
      };
      await persistTask(task);
      await retainCompletion(task);
    });
  }

  async function startTask(taskId) {
    let controller = null;
    await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (draining || task.receipt || task.completion) return;
      if (task.cancellation) {
        task.completion = {
          ...terminalCompletion(null, true, options.redact, task.executionInput.url),
          completedAt: new Date().toISOString(),
        };
        await persistTask(task);
        await retainCompletion(task);
        return;
      }
      if (task.status !== 'queued' || active.has(task.id)) return;
      controller = new AbortController();
      active.set(task.id, { controller, promise: Promise.resolve() });
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      await persistTask(task);
    });
    if (!controller) return;
    const running = active.get(taskId);
    const promise = executeTask(taskId, controller)
      .finally(() => {
        if (active.get(taskId)?.controller === controller) active.delete(taskId);
        void dispatchQueue();
      });
    running.promise = promise;
  }

  async function dispatchQueue() {
    if (dispatching || draining) return;
    dispatching = true;
    try {
      while (!draining && active.size < options.concurrency && queue.length > 0) {
        const taskId = queue.shift();
        queued.delete(taskId);
        try {
          await startTask(taskId);
          dispatcherHealthy = true;
        } catch {
          queue.unshift(taskId);
          queued.add(taskId);
          dispatcherHealthy = false;
          break;
        }
      }
    } finally {
      dispatching = false;
    }
  }

  async function enqueue(taskId) {
    if (!queued.has(taskId) && !active.has(taskId)) {
      queue.push(taskId);
      queued.add(taskId);
    }
    await dispatchQueue();
  }

  function removeQueued(taskId) {
    if (!queued.delete(taskId)) return;
    const index = queue.indexOf(taskId);
    if (index >= 0) queue.splice(index, 1);
  }

  async function existingSubmission(key, requestDigest) {
    const reservation = await readReservation(key);
    if (!reservation) return null;
    if (reservation.requestDigest !== requestDigest) {
      throw new PublicTaskError(409, 'idempotency-conflict', 'Idempotency-Key is already bound to a different request');
    }
    return materializeReservation(reservation);
  }

  async function submit(request, body) {
    if (!staticReady) throw new PublicTaskError(503, 'service-not-ready', 'public task prerequisites are not ready');
    if (draining) throw new PublicTaskError(503, 'service-draining', 'service is draining');
    const key = idempotencyKey(request);
    const parsed = parseTaskRequest(body, config);
    const existing = await existingSubmission(key, parsed.requestDigest);
    let serviceIdentity;
    try {
      serviceIdentity = await currentServiceIdentity();
    } catch {
      throw new PublicTaskError(503, 'service-not-ready', 'deployed service identity is unavailable or mismatched');
    }
    if (canonicalJson(parsed.spisBinding.service) !== canonicalJson(bindingServiceIdentity(serviceIdentity))) {
      throw new PublicTaskError(403, 'service-identity-mismatch', 'spisBinding.service does not match the deployed Weles service identity');
    }
    let networkTarget;
    try {
      networkTarget = await options.resolveTarget(parsed.executionInput.url);
    } catch {
      throw new PublicTaskError(403, 'network-target-denied', 'target did not resolve exclusively to stable public addresses');
    }
    const now = new Date().toISOString();
    const task = {
      schema: 'weles.public-task-record.v1',
      id: randomUUID(),
      requestDigest: parsed.requestDigest,
      request: parsed.request,
      spisBinding: parsed.spisBinding,
      serviceIdentity,
      executionInput: parsed.executionInput,
      networkTarget,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      result: null,
      resultDigest: null,
      error: null,
      receipt: null,
      cancellation: null,
    };
    if (!await createReservation(key, task)) {
      const raced = await existingSubmission(key, parsed.requestDigest);
      if (!raced) throw new Error('idempotency reservation disappeared after a concurrent claim');
      return { status: 200, payload: publicStatus(raced, dispatcherStatus()) };
    }
    await persistTask(task);
    await enqueue(task.id);
    const accepted = await loadTask(task.id);
    return { status: 202, payload: publicStatus(accepted, dispatcherStatus()) };
  }

  async function getTask(taskId) {
    return withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (task.completion && !task.receipt) await retainCompletion(task);
      return { status: 200, payload: publicStatus(task, dispatcherStatus()) };
    });
  }

  async function cancel(request, taskId, body) {
    const key = idempotencyKey(request);
    const cancellation = parseCancellation(body, config);
    let controller = null;
    const response = await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (Object.hasOwn(TERMINAL_STATUSES, task.status)) {
        return { status: 200, payload: publicStatus(task, dispatcherStatus()) };
      }
      if (task.cancellation
          && (task.cancellation.idempotencyKey !== key || task.cancellation.reason !== cancellation.reason)) {
        throw new PublicTaskError(409, 'cancellation-conflict', 'task already has a different cancellation operation');
      }
      if (!task.cancellation) {
        task.cancellation = {
          idempotencyKey: key,
          reason: cancellation.reason,
          requestedAt: new Date().toISOString(),
        };
      }
      const running = active.get(task.id);
      if (running) {
        controller = running.controller;
        await persistTask(task);
        return { status: 202, payload: publicStatus(task, dispatcherStatus()) };
      }
      removeQueued(task.id);
      task.completion = {
        ...terminalCompletion(null, true, options.redact, task.executionInput.url),
        completedAt: new Date().toISOString(),
      };
      await persistTask(task);
      await retainCompletion(task);
      return {
        status: Object.hasOwn(TERMINAL_STATUSES, task.status) ? 200 : 202,
        payload: publicStatus(task, dispatcherStatus()),
      };
    });
    controller?.abort();
    return response;
  }

  async function cleanInterruptedTemporaryFiles(directory, entries) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.tmp')) {
        await rm(join(directory, entry.name), { force: true });
      }
    }
    await syncDirectory(directory);
  }

  async function recover() {
    await ensureRoots();
    await currentServiceIdentity().catch(() => null);
    const mappingEntries = await readdir(mappingRoot, { withFileTypes: true });
    await cleanInterruptedTemporaryFiles(mappingRoot, mappingEntries);
    for (const entry of mappingEntries) {
      if (entry.name.endsWith('.tmp')) continue;
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
        throw new Error(`unexpected public task reservation entry: ${entry.name}`);
      }
      await materializeReservation(validateReservation(await readJson(join(mappingRoot, entry.name))));
    }

    const taskEntries = await readdir(taskRoot, { withFileTypes: true });
    await cleanInterruptedTemporaryFiles(taskRoot, taskEntries);
    const taskIds = [];
    for (const entry of taskEntries) {
      if (entry.name === 'idempotency' || entry.name.endsWith('.tmp')) continue;
      const match = /^task-([0-9a-f-]+)\.json$/.exec(entry.name);
      if (!entry.isFile() || !match || !UUID_RE.test(match[1])) {
        throw new Error(`unexpected public task state entry: ${entry.name}`);
      }
      taskIds.push(match[1]);
    }
    const recoveredQueue = [];
    for (const taskId of taskIds) {
      await withTaskLock(taskId, async () => {
        const task = await loadTask(taskId);
        if (task.receipt) return;
        if (task.completion) {
          await retainCompletion(task);
          return;
        }
        if (task.cancellation) {
          task.completion = {
            ...terminalCompletion(null, true, options.redact, task.executionInput.url),
            completedAt: new Date().toISOString(),
          };
          await persistTask(task);
          await retainCompletion(task);
          return;
        }
        if (task.status === 'running') {
          task.completion = {
            ...terminalCompletion({ ok: false, run_id: task.id }, false, options.redact, task.executionInput.url),
            error: 'browser evidence execution was interrupted by service restart',
            completedAt: new Date().toISOString(),
          };
          await persistTask(task);
          await retainCompletion(task);
        }
      });
      const recovered = await loadTask(taskId);
      if (recovered.status === 'queued' && !recovered.completion && !recovered.cancellation) {
        recoveredQueue.push({ taskId, createdAt: recovered.createdAt });
      }
    }
    recoveredQueue.sort((left, right) => {
      const byCreatedAt = String(left.createdAt).localeCompare(String(right.createdAt));
      return byCreatedAt || left.taskId.localeCompare(right.taskId);
    });
    for (const entry of recoveredQueue) {
      queue.push(entry.taskId);
      queued.add(entry.taskId);
    }
    await dispatchQueue();
  }

  const health = Object.freeze({
    get ready() { return staticReady && identityReady; },
    get prerequisites() { return readinessStatus(); },
    get serviceIdentity() { return lastServiceIdentity; },
    get dispatcher() { return dispatcherStatus(); },
    basePath: '/api/v1',
    action: PUBLIC_ACTION,
    consumer: 'spis',
    capability: 'browser-evidence',
    releaseId: expectedReleaseId,
    releaseSha256: identity.release_sha256,
    sourceRevision: identity.source_revision,
    taskTimeoutMs: options.taskTimeoutMs,
    receiptKeyId: config.keyId,
    receiptKeySetVersion: config.keySetVersion,
    browserEvidencePolicy: config.policy.version,
    browserEvidencePolicyDigest: config.policyDigest,
  });

  async function handle(request, url, readBody) {
    if (request.method === 'GET' && url.pathname === '/api/v1/version') {
      let serviceIdentity;
      try { serviceIdentity = await currentServiceIdentity(); } catch {
        return {
          status: 503,
          payload: {
            schema: VERSION_SCHEMA,
            service: 'weles-admission',
            ready: false,
            releaseId: expectedReleaseId,
            sourceRevision: identity.source_revision,
            deploymentManifestSha256: identity.release_sha256,
            error: 'deployed-service-identity-mismatch',
          },
        };
      }
      const admissionReady = staticReady && identityReady;
      return {
        status: admissionReady ? 200 : 503,
        payload: {
          schema: VERSION_SCHEMA,
          service: 'weles-admission',
          release: identity.release_version,
          releaseId: expectedReleaseId,
          sourceRevision: identity.source_revision,
          deploymentManifestSha256: identity.release_sha256,
          serviceIdentity,
          ready: admissionReady,
          prerequisites: readinessStatus(),
          dispatcher: dispatcherStatus(),
          taskTimeoutMs: options.taskTimeoutMs,
          client: { currentVersion: '0.1.0', minimumVersion: '0.1.0', supportedGenerations: 2 },
          apiSchemas: [TASK_SCHEMA, CANCELLATION_SCHEMA, STATUS_SCHEMA, RECEIPT_SCHEMA, VERSION_SCHEMA],
          publicTask: { ...health, serviceIdentity, ready: admissionReady },
        },
      };
    }

    const taskMatch = /^\/api\/v1\/tasks\/([0-9a-f-]+)$/.exec(url.pathname);
    const cancelMatch = /^\/api\/v1\/tasks\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
    const isSubmit = request.method === 'POST' && url.pathname === '/api/v1/tasks';
    const isGet = request.method === 'GET' && Boolean(taskMatch);
    const isCancel = request.method === 'POST' && Boolean(cancelMatch);
    if (!isSubmit && !isGet && !isCancel) return null;
    if ((isSubmit || isCancel)
        && String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      throw new PublicTaskError(415, 'unsupported-media-type', 'public task bodies require Content-Type: application/json');
    }
    if (!bearerAuthorized(request, config.bearer)) {
      throw new PublicTaskError(401, 'unauthorized', 'unauthorized');
    }
    if (isSubmit) return submit(request, await readBody(request));
    if (isGet) return getTask(taskMatch[1]);
    return cancel(request, cancelMatch[1], await readBody(request));
  }

  async function shutdown() {
    draining = true;
    queue.length = 0;
    queued.clear();
    for (const running of active.values()) running.controller.abort();
    await Promise.allSettled([...active.values()].map((running) => running.promise));
  }

  return Object.freeze({ health, handle, recover, shutdown });
}

export function publicTaskErrorResponse(error) {
  if (error instanceof PublicTaskError) {
    return { status: error.status, payload: { error: error.code, message: error.message } };
  }
  return null;
}
