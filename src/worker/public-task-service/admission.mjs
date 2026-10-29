import { constants as http } from 'node:http2';

import { PublicTaskError } from './wire.mjs';
import {
  canonicalJson,
  constantTimeTextEqual,
  digest,
  isObject,
} from './wire/canonical-json.mjs';
import {
  PUBLIC_ACTION,
  assertBoundedJson,
  assertDeclaredFields,
  exactHttpsOrigin,
  exactPublicHttpsUrl,
  loadConfig,
} from './admission/deployment.mjs';
import { createDeployedIdentity } from './admission/identity.mjs';
import { parseSpisBinding } from './admission/spis-binding.mjs';

export { PUBLIC_ACTION, loadConfig, createDeployedIdentity };

export const TASK_SCHEMA = 'weles.task.current';
export const CANCELLATION_SCHEMA = 'weles.cancellation.current';
// The key is hashed into its reservation's file name, so no length is chosen.
const IDEMPOTENCY_RE = /^[\w.:-]+$/;
// The fields of weles.task.current, its input and weles.cancellation.current.
// Nothing else is admitted, whatever it is called.
const TASK_FIELDS = Object.freeze([
  'action',
  'credentialRefs',
  'evidencePolicy',
  'input',
  'justification',
  'organizationId',
  'origin',
  'schema',
]);
const INPUT_FIELDS = Object.freeze([
  'constraints',
  'objective',
  'product_url',
  'spisBinding',
]);
const CANCELLATION_FIELDS = Object.freeze([
  'organizationId',
  'reason',
  'schema',
]);

export function parseTaskRequest(body, config) {
  if (!isObject(body) || body.schema !== TASK_SCHEMA) {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'unsupported-task-schema',
      'unsupported task schema',
    );
  }
  assertBoundedJson(body, 'task');
  assertDeclaredFields(body, TASK_FIELDS, 'task', 'invalid-task');
  if (body.organizationId !== config.organizationId) {
    throw new PublicTaskError(
      http.HTTP_STATUS_FORBIDDEN,
      'organization-denied',
      'organizationId is outside the authenticated tenant',
    );
  }
  const origin = exactHttpsOrigin(body.origin);
  if (!config.allowedOrigins.has('*') && !config.allowedOrigins.has(origin)) {
    throw new PublicTaskError(
      http.HTTP_STATUS_FORBIDDEN,
      'origin-denied',
      'origin is not allowed by service policy',
    );
  }
  if (body.action !== PUBLIC_ACTION) {
    throw new PublicTaskError(
      http.HTTP_STATUS_FORBIDDEN,
      'action-denied',
      'action is not allowed by service policy',
    );
  }
  if (!isObject(body.input))
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-input',
      'input must be an object',
    );
  assertDeclaredFields(body.input, INPUT_FIELDS, 'task.input', 'invalid-input');
  assertBoundedJson(body.input);
  const url = exactPublicHttpsUrl(body.input.product_url);
  if (new URL(url).origin !== origin) {
    throw new PublicTaskError(
      http.HTTP_STATUS_FORBIDDEN,
      'origin-target-mismatch',
      'task origin must equal the exact browser target origin',
    );
  }
  if (
    typeof body.input.objective !== 'string' ||
    !body.input.objective.trim()
  ) {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-input',
      'input.objective must be a non-empty string',
    );
  }
  if (
    !Array.isArray(body.input.constraints) ||
    canonicalJson(body.input.constraints) !==
      canonicalJson(config.policy.constraints)
  ) {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-input',
      'input.constraints must equal the exact typed browser-evidence constraint array',
    );
  }
  const spisBinding = parseSpisBinding(body.input.spisBinding);
  if (
    !Array.isArray(body.credentialRefs) ||
    body.credentialRefs.some(
      (entry) => typeof entry !== 'string' || !entry.trim(),
    )
  ) {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-credential-refs',
      'credentialRefs must be a string array',
    );
  }
  if (body.credentialRefs.length) {
    throw new PublicTaskError(
      http.HTTP_STATUS_FORBIDDEN,
      'credential-refs-denied',
      'browser-evidence tasks cannot receive credential references',
    );
  }
  if (body.evidencePolicy !== 'full') {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-evidence-policy',
      'browser-evidence tasks require evidencePolicy=full',
    );
  }
  if (typeof body.justification !== 'string' || !body.justification.trim()) {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-justification',
      'justification must be a non-empty string',
    );
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
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'unsupported-cancellation-schema',
      'unsupported cancellation schema',
    );
  }
  assertBoundedJson(body, 'cancellation');
  assertDeclaredFields(
    body,
    CANCELLATION_FIELDS,
    'cancellation',
    'invalid-cancellation',
  );
  if (body.organizationId !== config.organizationId) {
    throw new PublicTaskError(
      http.HTTP_STATUS_FORBIDDEN,
      'organization-denied',
      'organizationId is outside the authenticated tenant',
    );
  }
  if (typeof body.reason !== 'string' || !body.reason.trim()) {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-cancellation',
      'reason must be a non-empty string',
    );
  }
  return { organizationId: config.organizationId, reason: body.reason };
}

export function idempotencyKey(request) {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !IDEMPOTENCY_RE.test(value)) {
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-idempotency-key',
      'valid Idempotency-Key header is required',
    );
  }
  return value;
}

export function bearerAuthorized(request, expected) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const match = /^Bearer\s+(?<token>.+)$/i.exec(authorization);
  return Boolean(match && constantTimeTextEqual(match.groups.token, expected));
}
