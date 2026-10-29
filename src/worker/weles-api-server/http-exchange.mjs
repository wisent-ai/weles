// What one HTTP exchange with this server consists of: who is allowed to speak,
// what of what they send is read, and what may appear in the answer.
//
// The three are one subject because they are the same boundary seen from both
// directions. A caller is admitted by a bearer token or an api-key header and
// by nothing else; a body is read whole, and what a route accepts is that
// route's own shape check, not a byte count chosen here; and every answer
// leaves through one writer that runs the secret-shape redactor unless the
// route deliberately turns it off. A route that wrote its own response would
// be a second answer path with a second redaction policy, which is exactly the
// way a token gets out.

import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as http } from 'node:http2';
import { TOKEN, BRAMA_REAUTH_TOKEN, ALLOW_UNAUTH } from './configuration.mjs';
import { withoutSecretShapes } from '../../capture/secret-shapes/index.cjs';

// Whether the header a caller sent is `expected`, compared over equal-length
// digests so the time taken does not tell a caller how much of a token it
// guessed. A header that was not sent is no match.
function headerIs(header, expected) {
  if (typeof header !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(expected));
}

// Whether the request carries `token` as its bearer or its x-api-key.
function carriesToken(req, token) {
  return (
    headerIs(req.headers.authorization, `Bearer ${token}`) ||
    headerIs(req.headers['x-api-key'], token)
  );
}

function tokenAuthorized(req) {
  if (!TOKEN) return false;
  return carriesToken(req, TOKEN);
}

export function reauthAuthorized(req) {
  return Boolean(
    BRAMA_REAUTH_TOKEN &&
      headerIs(req.headers.authorization, `Bearer ${BRAMA_REAUTH_TOKEN}`),
  );
}

export function authorized(req) {
  return ALLOW_UNAUTH || tokenAuthorized(req);
}

export function json(res, code, obj, { redact = true } = {}) {
  const body = JSON.stringify(redact ? redactSecrets(obj) : obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Secret-shape redactor: never let a token leave over HTTP. Operates on the
// serialized form so nested fields count, through the one list of credential
// shapes (capture/secret-shapes). A value that cannot be serialized cannot be
// redacted, so it is the error; it is never answered as it was.
export function redactSecrets(obj) {
  let serialized;
  try {
    serialized = JSON.stringify(obj);
  } catch (error) {
    throw new Error(
      `the answer could not be serialized, so it cannot be redacted: ${error.message}`,
    );
  }
  if (serialized === undefined) return obj;
  const redacted = withoutSecretShapes(serialized);
  return JSON.parse(redacted);
}

export function requireTokenAuthorization(req, res) {
  if (tokenAuthorized(req)) return true;
  if (TOKEN)
    json(res, http.HTTP_STATUS_UNAUTHORIZED, { ok: false, error: 'unauthorized' });
  else
    json(res, http.HTTP_STATUS_INTERNAL_SERVER_ERROR, {
      ok: false,
      error: 'missing_WELES_API_TOKEN',
    });
  return false;
}

// The whole request body as JSON. No size is chosen here: every route behind
// this reader takes a Weles bearer, and what a route accepts is decided by
// that route's own shape checks. A body that is not JSON is refused with the
// parser's reason.
export function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      if (!text.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch (error) {
        reject(new Error(`invalid_json: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

// Raw body reader for /weles-builder: the body IS the instructions string
// (text/plain). No JSON envelope required.
export function readText(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
