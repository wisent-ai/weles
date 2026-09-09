import { PublicTaskError } from './wire.mjs';
import { canonicalJson, constantTimeTextEqual, digest, isObject } from './wire/canonical-json.mjs';
import {
  MAX_TEXT,
  PUBLIC_ACTION,
  assertBoundedJson,
  exactHttpsOrigin,
  exactPublicHttpsUrl,
  loadConfig,
} from './admission/deployment.mjs';
import { createDeployedIdentity, parseSpisBinding } from './admission/identity.mjs';

export { PUBLIC_ACTION, loadConfig, createDeployedIdentity };

export const TASK_SCHEMA = 'weles.task.current';
export const CANCELLATION_SCHEMA = 'weles.cancellation.current';
const IDEMPOTENCY_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const SAFE_INPUT_KEYS = Object.freeze({
  constraints: true,
  objective: true,
  product_url: true,
  spisBinding: true,
});

export function parseTaskRequest(body, config) {
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

export function parseCancellation(body, config) {
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

export function idempotencyKey(request) {
  const value = String(request.headers['idempotency-key'] ?? '');
  if (!IDEMPOTENCY_RE.test(value)) {
    throw new PublicTaskError(400, 'invalid-idempotency-key', 'valid Idempotency-Key header is required');
  }
  return value;
}

export function bearerAuthorized(request, expected) {
  const authorization = String(request.headers.authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(match && constantTimeTextEqual(match[1], expected));
}
