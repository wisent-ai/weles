#!/usr/bin/env node

const encoded = process.argv[2] ?? '';
if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
  throw new Error('one base64url Weles request is required');
}

const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
if (!request || Array.isArray(request) || typeof request !== 'object') {
  throw new Error('the Weles request must be an object');
}
if (!/^[a-z][a-z0-9_]{0,127}$/.test(String(request.action ?? ''))) {
  throw new Error('the Weles request action is invalid');
}
if (!request.params || Array.isArray(request.params) || typeof request.params !== 'object') {
  throw new Error('the Weles request params must be an object');
}

const token = process.env.WELES_API_TOKEN ?? '';
if (Buffer.byteLength(token) < 32 || token.trim() !== token) {
  throw new Error('WELES_API_TOKEN must be a nonblank token of at least 32 bytes');
}

const timeoutMs = Number(request.timeout_ms ?? 900_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
  throw new Error('timeout_ms must be an integer from 1000 through 1800000');
}

const response = await fetch('http://127.0.0.1:8788/run', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    action: request.action,
    params: request.params,
    timeout_ms: timeoutMs,
    creds: 'redact',
  }),
  signal: AbortSignal.timeout(timeoutMs + 5_000),
});
const text = await response.text();
let result;
try {
  result = JSON.parse(text);
} catch {
  throw new Error(`Weles returned HTTP ${response.status} with a non-JSON body`);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!response.ok || result.ok !== true) process.exitCode = 1;
