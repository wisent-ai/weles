#!/usr/bin/env node
import { acquireSecret } from '../../dist/secrets/acquire.js';

const MAX_REQUEST_BYTES = Number('65536');
const REQUESTS = Object.freeze({
  'weles-semantic-scholar-api': Object.freeze({ provider: 'semantic_scholar', secret: 'semantic_scholar.api_key' }),
  'weles-github-admin-org-token': Object.freeze({ provider: 'github', secret: 'github.admin_org_token' }),
  'weles-supabase-personal-access-token': Object.freeze({ provider: 'supabase', secret: 'supabase.personal_access_token' }),
  'weles-snapchat-snap-kit-api': Object.freeze({ provider: 'snapchat', secret: 'snapchat.snap_kit_api_token' }),
});

const chunks = [];
let received = Number('0');
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > MAX_REQUEST_BYTES) throw new Error('credential request exceeded size limit');
  chunks.push(chunk);
}
const requestBytes = Buffer.concat(chunks);
let request;
try {
  request = JSON.parse(requestBytes.toString('utf8'));
} finally {
  requestBytes.fill(Number('0'));
  for (const chunk of chunks) chunk.fill(Number('0'));
}

const allowedFields = new Set([
  'version',
  'request_id',
  'credential_id',
  'provider',
  'consumer',
  'purpose',
  'status',
  'created_at',
  'dry_run',
]);
if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('credential request must be an object');
if (Object.keys(request).some((key) => !allowedFields.has(key))) throw new Error('credential request contains unknown fields');
if (request.version !== 'skarbiec.credential-request.v1') throw new Error('unsupported credential request version');
if (typeof request.request_id !== 'string' || request.request_id.length !== '0000000000000000000000000000000000000000000000000000000000000000'.length || /[^a-fA-F\d]/.test(request.request_id)) {
  throw new Error('invalid credential request id');
}
const validExactName = (value, max) => typeof value === 'string' && value.length >= Number('1') && value.length <= max && !/[^A-Za-z\d._-]/.test(value);
if (!validExactName(request.credential_id, Number('200'))) throw new Error('invalid credential item id');
if (!validExactName(request.provider, Number('128'))) throw new Error('invalid credential provider');
if (!validExactName(request.consumer, Number('128'))) throw new Error('invalid credential consumer');
const hasControlCharacter = typeof request.purpose === 'string' && Array.from(request.purpose).some((character) => {
  const code = character.charCodeAt(Number('0'));
  return code < Number('32') || code === Number('127');
});
if (typeof request.purpose !== 'string' || request.purpose.length < Number('1') || request.purpose.length > Number('512') || hasControlCharacter) {
  throw new Error('invalid credential purpose');
}
if (request.status !== 'pending' || (request.dry_run !== true && request.dry_run !== false)) {
  throw new Error('invalid credential request state');
}

const contract = REQUESTS[request.credential_id];
if (!contract || contract.provider !== request.provider) {
  console.log(JSON.stringify({
    status: 'unsupported_secret',
    provider: request.provider,
    vaultItemId: request.credential_id,
    message: `No exact Weles acquisition contract for ${request.credential_id}/${request.provider}`,
  }));
} else {
  const result = await acquireSecret({
    secret: contract.secret,
    purpose: request.purpose,
    dryRun: request.dry_run,
  });
  console.log(JSON.stringify({ ...result, vaultItemId: request.credential_id }));
}
