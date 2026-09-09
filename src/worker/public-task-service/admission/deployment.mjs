import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';

import { PublicTaskError } from '../wire.mjs';
import {
  UUID_RE,
  canonicalJson,
  constantTimeTextEqual,
  containsLoneSurrogate,
  digest,
  isObject,
} from '../wire/canonical-json.mjs';

export const PUBLIC_ACTION = 'generic_browser_task';
export const MAX_TEXT = 4_000;
const MAX_OBJECT_KEYS = 128;
const MAX_ARRAY_ITEMS = 1_000;
const SENSITIVE_KEY_RE = /password|secret|token|cookie|authorization|proxy.?auth/i;

function requiredEnvironment(name, environment) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`missing required ${name}`);
  return value;
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

// `createPublicKey` takes key material or a PRIVATE `KeyObject`; handed a
// public one it throws `ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE`. The comparison
// below calls this with both a PEM string from the key set and the KeyObject
// derived from the private key, so the second call always threw and this
// service could never start once its credential existed. Nothing caught it
// because the credential did not exist: the launcher failed earlier, on an
// empty Skarbiec field, and the first host to be provisioned found this
// instead of a working public API.
function normalizePublicKey(value) {
  const key = value instanceof KeyObject && value.type === 'public' ? value : createPublicKey(value);
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function loadConfig(environment, policy) {
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

export function assertBoundedJson(value, path = 'input', depth = 0) {
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

export function exactHttpsOrigin(value) {
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

export function exactPublicHttpsUrl(value) {
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
