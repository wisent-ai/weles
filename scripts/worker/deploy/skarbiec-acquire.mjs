#!/usr/bin/env node

import { randomBytes, sign } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const [endpointText, scopeFile, consumer, item, field] =
  process.argv.slice(Number('2'));
if ([endpointText, scopeFile, consumer, item, field].some((value) => !value)) {
  throw new Error('usage: skarbiec-acquire.mjs <endpoint> <scope-file> <consumer> <item> <field>');
}

const exactName = /^[A-Za-z\d._-]+$/;
if (![consumer, item, field].every((value) => exactName.test(value))) {
  throw new Error('consumer, item, and field must be exact names without wildcards or separators');
}

const scopeRows = readFileSync(scopeFile, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
const parsedScopes = scopeRows.map((line) => {
  const columns = line.split('|');
  if (columns.length !== Number('3') || !columns.every((value) => exactName.test(value))) {
    throw new Error('invalid Skarbiec bootstrap scope; expected consumer|item|field exact-name grammar');
  }
  return columns;
});
const scopeKeys = parsedScopes.map((columns) => columns.join('|'));
if (!scopeKeys.length || new Set(scopeKeys).size !== scopeKeys.length) {
  throw new Error('Skarbiec bootstrap scope catalog must be nonempty and duplicate-free');
}
if (!scopeKeys.includes([consumer, item, field].join('|'))) {
  throw new Error(`undeclared Skarbiec acquisition scope for ${consumer}`);
}

const endpoint = new URL(endpointText);
const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(endpoint.hostname);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))) {
  throw new Error('Skarbiec endpoint must be an HTTPS origin or loopback HTTP origin');
}


const unsafeBits = Number.parseInt('077', Number('8'));
const workloadId = process.env.SKARBIEC_WORKLOAD_ID;
const signingKeyFile = process.env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE;
if (!workloadId || workloadId.trim() !== workloadId
    || [...workloadId].some((character) => character < ' ' || character === '\u007f')
    || workloadId.length > Number('128')) {
  throw new Error('invalid SKARBIEC_WORKLOAD_ID');
}
if (!signingKeyFile || !isAbsolute(signingKeyFile)) {
  throw new Error('SKARBIEC_WORKLOAD_SIGNING_KEY_FILE must be an absolute path');
}
const signingMetadata = lstatSync(signingKeyFile);
if (!signingMetadata.isFile() || signingMetadata.isSymbolicLink()
    || signingMetadata.uid !== process.getuid()
    || (signingMetadata.mode & unsafeBits) !== Number('0')) {
  throw new Error('unsafe Skarbiec workload signing key file');
}
const workloadTimestamp = Math.floor(Date.now() / Number('1000'));
const workloadNonce = randomBytes(Number('32')).toString('base64url');
const separator = Buffer.alloc(Number('1'));
const proofPayload = Buffer.concat([
  Buffer.from('SKARBIEC-WORKLOAD-ACQUISITION\0v1\0', 'utf8'),
  Buffer.from(consumer, 'utf8'), separator,
  Buffer.from(item, 'utf8'), separator,
  Buffer.from(field, 'utf8'), separator,
  Buffer.from(workloadId, 'utf8'), separator,
  Buffer.from(String(workloadTimestamp), 'ascii'), separator,
  Buffer.from(workloadNonce, 'ascii'),
]);
const signingKey = readFileSync(signingKeyFile);
let workloadSignature;
try {
  workloadSignature = sign(null, proofPayload, signingKey).toString('hex');
} finally {
  signingKey.fill(Number('0'));
  proofPayload.fill(Number('0'));
}
const validHex = [...workloadSignature].every((character) =>
  (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));
if (workloadSignature.length !== Number('128') || !validHex) {
  throw new Error('invalid Skarbiec workload proof signature');
}

// The authority's refusal is the diagnosis: a bare "HTTP 403" cannot tell an
// unregistered consumer from a grant whose action, audience or window does not
// cover this read, and the caller collapsed even that into one sentence. The body
// of a refusal carries the authority's reason and never carries a field value —
// a successful read is the only response that does, and it is not routed here —
// but any `value` key is dropped anyway before the text is repeated.
async function refusal(stage, response, consumer, item, field) {
  let detail = '';
  try {
    const text = (await response.text()).slice(Number('0'), Number('2048'));
    detail = text.replace(/"value"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"value":"<redacted>"')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    detail = '<body unreadable>';
  }
  return new Error(
    `Skarbiec ${stage} refused ${consumer} for ${item}#${field}: HTTP ${response.status}`
    + `${detail ? ` ${detail}` : ''}`,
  );
}

const body = JSON.stringify({ id: item, field });
const issueBody = JSON.stringify({
  id: item,
  field,
  workload_id: workloadId,
  workload_timestamp: workloadTimestamp,
  workload_nonce: workloadNonce,
  workload_signature: workloadSignature,
});
const commonHeaders = {
  'Content-Type': 'application/json',
  'X-Consumer': consumer,
};
const issueResponse = await fetch(new URL('/v1/acquisitions', endpoint), {
  method: 'POST',
  headers: commonHeaders,
  body: issueBody,
});
if (!issueResponse.ok) {
  throw await refusal('acquisition issue', issueResponse, consumer, item, field);
}
const issued = await issueResponse.json();
const issuedKeys = ['consumer', 'expires_at', 'field', 'item', 'token'];
if (!issued || issued.consumer !== consumer || issued.item !== item || issued.field !== field
    || Object.keys(issued).sort().join('|') !== issuedKeys.join('|')
    || typeof issued.token !== 'string' || !issued.token || /\s/.test(issued.token)
    || !Number.isSafeInteger(issued.expires_at)) {
  throw new Error('Skarbiec returned an invalid field-bound acquisition bearer');
}

const readResponse = await fetch(new URL('/v1/acquisitions/read', endpoint), {
  method: 'POST',
  headers: { ...commonHeaders, Authorization: `Bearer ${issued.token}` },
  body,
});
if (!readResponse.ok) {
  throw await refusal('one-time read', readResponse, consumer, item, field);
}
const result = await readResponse.json();
const expectedKeys = ['consumer', 'field', 'item', 'value'];
if (!result || result.consumer !== consumer || result.item !== item || result.field !== field
    || Object.keys(result).sort().join('|') !== expectedKeys.join('|')
    || typeof result.value !== 'string' || !result.value) {
  throw new Error('Skarbiec returned an invalid single-field response');
}
process.stdout.write(result.value);
