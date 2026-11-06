// What the public task API admits: a task, a cancellation, an Idempotency-Key
// and a bearer. Every refusal is one declared cause of the admission
// catalogue (src/errors/operations/admission.cjs), naming what failed, why,
// what was sent and what fixes it.
import { DeclaredError } from '../../errors/index.cjs';
import { causes } from '../../errors/operations/admission.cjs';
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

/** A value as a refusal shows it: JSON, or what JSON has no form for. */
function shown(value) {
  const text = JSON.stringify(value);
  return text === undefined ? `no value (${typeof value})` : text;
}

export function parseTaskRequest(body, config) {
  if (!isObject(body) || body.schema !== TASK_SCHEMA) {
    throw new DeclaredError(causes.TASK_SCHEMA, {
      expected: TASK_SCHEMA,
      schema: isObject(body) ? shown(body.schema) : `a ${shown(body)} body`,
    });
  }
  assertBoundedJson(body, 'task');
  assertDeclaredFields(
    body,
    TASK_FIELDS,
    'task',
    causes.TASK_FIELDS,
    TASK_SCHEMA,
  );
  if (body.organizationId !== config.organizationId)
    throw new DeclaredError(causes.ORGANIZATION, {
      organization: shown(body.organizationId),
    });
  const origin = exactHttpsOrigin(body.origin);
  if (!config.allowedOrigins.has('*') && !config.allowedOrigins.has(origin))
    throw new DeclaredError(causes.ORIGIN_DENIED, {
      origin,
      allowed: [...config.allowedOrigins].join(', '),
    });
  if (body.action !== PUBLIC_ACTION)
    throw new DeclaredError(causes.ACTION_DENIED, {
      action: shown(body.action),
      allowed: PUBLIC_ACTION,
    });
  if (!isObject(body.input))
    throw new DeclaredError(causes.INPUT_NOT_OBJECT, {
      input: shown(body.input),
    });
  assertDeclaredFields(
    body.input,
    INPUT_FIELDS,
    'task.input',
    causes.INPUT_FIELDS,
    TASK_SCHEMA,
  );
  const url = exactPublicHttpsUrl(body.input.product_url);
  const target = new URL(url).origin;
  if (target !== origin)
    throw new DeclaredError(causes.TARGET_MISMATCH, { url, origin, target });
  if (typeof body.input.objective !== 'string' || !body.input.objective.trim())
    throw new DeclaredError(causes.OBJECTIVE, {
      objective: shown(body.input.objective),
    });
  if (
    !Array.isArray(body.input.constraints) ||
    canonicalJson(body.input.constraints) !==
      canonicalJson(config.policy.constraints)
  )
    throw new DeclaredError(causes.CONSTRAINTS, {
      policy: config.policy.version,
      constraints: shown(body.input.constraints),
      expected: shown(config.policy.constraints),
    });
  const spisBinding = parseSpisBinding(body.input.spisBinding);
  if (
    !Array.isArray(body.credentialRefs) ||
    body.credentialRefs.some(
      (entry) => typeof entry !== 'string' || !entry.trim(),
    )
  )
    throw new DeclaredError(causes.CREDENTIAL_REFS, {
      value: shown(body.credentialRefs),
    });
  if (body.credentialRefs.length)
    throw new DeclaredError(causes.CREDENTIAL_DENIED, {
      value: shown(body.credentialRefs),
    });
  if (body.evidencePolicy !== 'full')
    throw new DeclaredError(causes.EVIDENCE_POLICY, {
      value: shown(body.evidencePolicy),
    });
  if (typeof body.justification !== 'string' || !body.justification.trim())
    throw new DeclaredError(causes.JUSTIFICATION, {
      value: shown(body.justification),
    });
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
    throw new DeclaredError(causes.CANCELLATION_SCHEMA, {
      expected: CANCELLATION_SCHEMA,
      schema: isObject(body) ? shown(body.schema) : `a ${shown(body)} body`,
    });
  }
  assertBoundedJson(body, 'cancellation');
  assertDeclaredFields(
    body,
    CANCELLATION_FIELDS,
    'cancellation',
    causes.CANCELLATION_FIELDS,
    CANCELLATION_SCHEMA,
  );
  if (body.organizationId !== config.organizationId)
    throw new DeclaredError(causes.ORGANIZATION, {
      organization: shown(body.organizationId),
    });
  if (typeof body.reason !== 'string' || !body.reason.trim())
    throw new DeclaredError(causes.REASON, { value: shown(body.reason) });
  return { organizationId: config.organizationId, reason: body.reason };
}

/** The request's Idempotency-Key, or the declared cause it is refused with. */
export function idempotencyKey(request, path) {
  const value = request.headers['idempotency-key'];
  const where = { method: request.method, path };
  if (typeof value !== 'string')
    throw new DeclaredError(causes.IDEMPOTENCY_MISSING, where);
  if (!IDEMPOTENCY_RE.test(value))
    throw new DeclaredError(causes.IDEMPOTENCY_INVALID, {
      ...where,
      key: JSON.stringify(value),
    });
  return value;
}

/**
 * Nothing when the request carries `expected` as its bearer; otherwise the
 * declared cause: no bearer at all, or one this worker does not admit. The
 * presented bearer is never shown, only its length.
 */
export function assertBearer(request, expected, path) {
  const authorization = request.headers.authorization;
  const where = { method: request.method, path };
  if (typeof authorization !== 'string')
    throw new DeclaredError(causes.BEARER_MISSING, {
      ...where,
      authorization: 'none',
    });
  const match = /^Bearer\s+(?<token>.+)$/i.exec(authorization);
  if (!match)
    throw new DeclaredError(causes.BEARER_MISSING, {
      ...where,
      authorization: `a ${authorization.split(/\s/)[0]} credential, not Bearer`,
    });
  if (!constantTimeTextEqual(match.groups.token, expected))
    throw new DeclaredError(causes.BEARER_WRONG, {
      ...where,
      length: match.groups.token.length,
    });
}
