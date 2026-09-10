import { createHash, timingSafeEqual } from 'node:crypto';

import { PublicTaskError } from '../wire.mjs';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function containsLoneSurrogate(value) {
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
export function canonicalJson(value) {
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

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
export function digest(value) {
  return `sha256:${sha256(value)}`;
}
export function sha256Text(value) {
  return sha256(Buffer.from(value, 'utf8'));
}

export function constantTimeTextEqual(actual, expected) {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
