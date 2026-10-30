import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';

import { DeclaredError } from '../../../errors/index.cjs';
import { causes } from '../../../errors/operations/admission.cjs';
import {
  UUID_RE,
  canonicalJson,
  constantTimeTextEqual,
  containsLoneSurrogate,
  digest,
  isObject,
} from '../wire/canonical-json.mjs';

export const PUBLIC_ACTION = 'generic_browser_task';
// The signature algorithm receipts are signed with (node:crypto's name).
const RECEIPT_KEY_TYPE = 'ed25519';

function requiredEnvironment(name, environment) {
  const value = environment[name];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`missing required ${name}`);
  return value.trim();
}

function parseAllowedOrigins(raw) {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length)
    throw new Error('WELES_PUBLIC_API_ALLOWED_ORIGINS must not be empty');
  if (entries.includes('*')) {
    if (entries.some((entry) => entry !== '*'))
      throw new Error(
        'WELES_PUBLIC_API_ALLOWED_ORIGINS wildcard must stand alone',
      );
    return new Set(['*']);
  }
  const origins = entries.map((entry) => {
    const parsed = new URL(entry);
    if (parsed.protocol !== 'https:' || parsed.origin !== entry) {
      throw new Error(
        'WELES_PUBLIC_API_ALLOWED_ORIGINS entries must be exact HTTPS origins',
      );
    }
    return entry;
  });
  return new Set(origins);
}

// `createPublicKey` takes key material or a PRIVATE `KeyObject`; handed a
// public one it throws `ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE`. The comparison
// below calls this with both a PEM string from the key set and the KeyObject
// derived from the private key, so the second call always threw and this
// service could never start once its credential existed. Nothing caught it
// because the credential did not exist: the launcher failed earlier, on an
// empty Skarbiec field, and the first host to be provisioned found this
// instead of a working public API.
function normalizePublicKey(value) {
  const key =
    value instanceof KeyObject && value.type === 'public'
      ? value
      : createPublicKey(value);
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function loadConfig(environment, policy) {
  const bearer = requiredEnvironment('WELES_PUBLIC_API_BEARER', environment);
  const organizationId = requiredEnvironment(
    'WELES_PUBLIC_API_ORGANIZATION_ID',
    environment,
  );
  if (!UUID_RE.test(organizationId))
    throw new Error('WELES_PUBLIC_API_ORGANIZATION_ID must be a UUID');
  const keyId = requiredEnvironment('WELES_RECEIPT_KEY_ID', environment);
  const keySetVersion = requiredEnvironment(
    'WELES_RECEIPT_KEY_SET_VERSION',
    environment,
  );
  const privateKey = createPrivateKey(
    requiredEnvironment('WELES_RECEIPT_PRIVATE_KEY', environment),
  );
  if (privateKey.asymmetricKeyType !== RECEIPT_KEY_TYPE)
    throw new Error(
      `WELES_RECEIPT_PRIVATE_KEY is a ${privateKey.asymmetricKeyType} key, not ${RECEIPT_KEY_TYPE}`,
    );
  const keySetValue = JSON.parse(
    requiredEnvironment('WELES_RECEIPT_PUBLIC_KEYS_JSON', environment),
  );
  if (!isObject(keySetValue) || !Object.keys(keySetValue).length) {
    throw new Error(
      'WELES_RECEIPT_PUBLIC_KEYS_JSON must be a non-empty object',
    );
  }
  const publicKey = keySetValue[keyId];
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error(
      'WELES_RECEIPT_PUBLIC_KEYS_JSON does not carry WELES_RECEIPT_KEY_ID',
    );
  }
  const derivedPublicKey = createPublicKey(privateKey);
  if (
    !constantTimeTextEqual(
      normalizePublicKey(publicKey),
      normalizePublicKey(derivedPublicKey),
    )
  ) {
    throw new Error(
      'receipt private key does not match its out-of-band public key set',
    );
  }
  if (!isObject(policy) || typeof policy.version !== 'string')
    throw new Error('browser-evidence policy is invalid');
  return Object.freeze({
    bearer,
    organizationId,
    keyId,
    keySetVersion,
    privateKey,
    allowedOrigins: parseAllowedOrigins(
      requiredEnvironment('WELES_PUBLIC_API_ALLOWED_ORIGINS', environment),
    ),
    policy,
    policyDigest: digest(canonicalJson(policy)),
  });
}

// The task's JSON shape: safe integers and no lone surrogates. No length,
// count or depth is chosen here; which fields exist is assertDeclaredFields'.
export function assertBoundedJson(value, path = 'input') {
  if (typeof value === 'string' && containsLoneSurrogate(value))
    throw new DeclaredError(causes.LONE_SURROGATE, { path });
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new DeclaredError(causes.UNSAFE_NUMBER, { path, value });
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertBoundedJson(entry, `${path}[${index}]`);
    return;
  }
  if (!isObject(value)) return;
  const entries = Object.entries(value);
  for (const [key, entry] of entries) {
    if (containsLoneSurrogate(key))
      throw new DeclaredError(causes.LONE_SURROGATE, {
        path: `a key of ${path}`,
      });
    assertBoundedJson(entry, `${path}.${key}`);
  }
}

// Refuses an object whose fields are not exactly the declared ones, naming
// every undeclared and every missing field by its path, as the declared
// `cause` of that object. A credential has no field of its own here: it
// enters a task only as a reference in credentialRefs, so whatever a key is
// called, an undeclared one is refused.
export function assertDeclaredFields(value, declared, path, cause, schema) {
  const named = (keys) => keys.map((key) => `${path}.${key}`).join(', ');
  const undeclared = Object.keys(value).filter(
    (key) => !declared.includes(key),
  );
  const missing = declared.filter((key) => !Object.hasOwn(value, key));
  const reasons = [];
  if (undeclared.length) reasons.push(`undeclared fields ${named(undeclared)}`);
  if (missing.length) reasons.push(`missing fields ${named(missing)}`);
  if (!reasons.length) return;
  throw new DeclaredError(cause, {
    reasons: `${path} has ${reasons.join(' and ')}`,
    declared: named(declared),
    schema,
  });
}

export function exactHttpsOrigin(value) {
  const refused = (answer) =>
    new DeclaredError(causes.ORIGIN_INVALID, {
      origin: JSON.stringify(value),
      answer,
    });
  if (typeof value !== 'string') throw refused(`it is a ${typeof value}`);
  if (!URL.canParse(value)) throw refused('it does not parse as a URL');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:')
    throw refused(`its scheme is ${parsed.protocol}`);
  if (parsed.origin !== value)
    throw refused(`its origin reads as ${parsed.origin}`);
  return value;
}

export function exactPublicHttpsUrl(value) {
  const refused = (answer) =>
    new DeclaredError(causes.PRODUCT_URL, {
      url: JSON.stringify(value),
      answer,
    });
  if (typeof value !== 'string') throw refused(`it is a ${typeof value}`);
  if (!URL.canParse(value)) throw refused('it does not parse as a URL');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:')
    throw refused(`its scheme is ${parsed.protocol}`);
  if (parsed.username || parsed.password)
    throw refused('it carries a user or password');
  if (parsed.toString() !== value)
    throw refused(`written canonically it reads ${parsed.toString()}`);
  return parsed.toString();
}
