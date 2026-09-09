// What one HTTP exchange with this server consists of: who is allowed to speak,
// how much of what they send is read, and what may appear in the answer.
//
// The three are one subject because they are the same boundary seen from both
// directions. A caller is admitted by a bearer token or an api-key header and
// by nothing else; a body is accepted only up to the configured limit, so a
// stream that never ends cannot exhaust the process; and every answer leaves
// through one writer that runs the secret-shape redactor unless the route
// deliberately turns it off. A route that wrote its own response would be a
// second answer path with a second redaction policy, which is exactly the way
// a token gets out.

import { BODY_LIMIT, TOKEN, BRAMA_REAUTH_TOKEN, ALLOW_UNAUTH } from './configuration.mjs';

function tokenAuthorized(req) {
  if (!TOKEN) return false;
  if (String(req.headers.authorization || '') === `Bearer ${TOKEN}`) return true;
  return String(req.headers['x-api-key'] || '') === TOKEN;
}

export function reauthAuthorized(req) {
  return Boolean(
    BRAMA_REAUTH_TOKEN
      && String(req.headers.authorization || '') === `Bearer ${BRAMA_REAUTH_TOKEN}`,
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

// Secret-shape redactor (same shapes as the secret-boundary hook): never let a
// token leave over HTTP. Operates on the serialized form so nested fields count.
export function redactSecrets(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { return obj; }
  if (!s) return obj;
  s = s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-pem]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, '[redacted-slack]')
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted-aws]')
    .replace(/\b[a-z]{1,12}_(secret|key|token|pat|api|db)_[A-Za-z0-9]{12,}/gi, '[redacted-secret]');
  try { return JSON.parse(s); } catch { return obj; }
}

export function requireTokenAuthorization(req, res) {
  if (tokenAuthorized(req)) return true;
  json(res, TOKEN ? 401 : 500, { ok: false, error: TOKEN ? 'unauthorized' : 'missing_WELES_API_TOKEN' });
  return false;
}

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(text)); } catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

// Raw body reader for /weles-builder: the body IS the instructions string
// (text/plain). No JSON envelope required.
export function readText(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
