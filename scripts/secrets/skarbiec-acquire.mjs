#!/usr/bin/env node
import { acquireSecret } from '../../dist/secrets/acquire.js';
import { returnCredentialToSkarbiec } from '../../dist/secrets/skarbiec-return.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const chunks = [];
let received = 0;
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > MAX_REQUEST_BYTES) throw new Error('credential request exceeded size limit');
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const allowedFields = new Set([
  'version',
  'request_id',
  'credential_id',
  'provider',
  'consumer',
  'purpose',
  'status',
  'created_at',
]);
if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('credential request must be an object');
if (Object.keys(request).some((key) => !allowedFields.has(key))) throw new Error('credential request contains unknown fields');
if (request.version !== 'skarbiec.credential-request.v1') throw new Error('unsupported credential request version');
if (!/^[a-fA-F0-9]{64}$/.test(request.request_id ?? '')) throw new Error('invalid credential request id');
if (!/^[A-Z0-9_]{3,128}$/.test(request.credential_id ?? '')) throw new Error('invalid credential id');
if (!/^[A-Za-z0-9._-]{1,128}$/.test(request.provider ?? '')) throw new Error('invalid credential provider');
if (typeof request.purpose !== 'string' || request.purpose.length < 1 || request.purpose.length > 512) throw new Error('invalid credential purpose');

const secret = request.provider === 'brave' || request.credential_id === 'BRAVE_SEARCH_API_KEY'
  ? 'brave.search_api_key'
  : `${request.provider}.api_key`;
const result = await acquireSecret({
  secret,
  purpose: request.purpose,
  skarbiecRequestId: request.request_id,
  skarbiecCredentialId: request.credential_id,
});

if (result.status === 'existing_secret_found') {
  const value = result.envVar ? process.env[result.envVar]?.trim() : '';
  if (!value || result.validated !== true) {
    console.log(JSON.stringify({
      status: 'needs_configuration',
      message: 'Existing credential is unavailable or failed provider validation',
    }));
  } else {
    await returnCredentialToSkarbiec({
      credentialId: request.credential_id,
      requestId: request.request_id,
      provider: request.provider,
      value,
    });
    console.log(JSON.stringify({
      status: 'credential_returned',
      message: 'Existing credential returned to Skarbiec',
    }));
  }
} else {
  console.log(JSON.stringify(result));
}
