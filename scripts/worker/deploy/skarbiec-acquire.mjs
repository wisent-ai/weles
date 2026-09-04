#!/usr/bin/env node

import { randomBytes, sign } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveSkarbiecEndpoint, formatEndpointErrorMessage } from './endpoint-resolution.mjs';

// Parse arguments: support both legacy 5-arg and new 4-arg forms
// Legacy: <endpoint> <scope-file> <consumer> <item> <field>
// New:    <scope-file> <consumer> <item> <field>
// Detection: if first arg is http(s) URL, treat as legacy endpoint
const allArgs = process.argv.slice(Number('2'));
let scopeFile, consumer, item, field, legacyEndpoint;

const isHttpUrl = (s) => {
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

if (allArgs.length === 5 && isHttpUrl(allArgs[0])) {
  // Legacy 5-argument form with explicit endpoint
  [legacyEndpoint, scopeFile, consumer, item, field] = allArgs;
} else if (allArgs.length === 4) {
  // New 4-argument form, resolve endpoint internally
  [scopeFile, consumer, item, field] = allArgs;
  legacyEndpoint = null;
} else {
  throw new Error('usage: skarbiec-acquire.mjs [<endpoint>] <scope-file> <consumer> <item> <field>');
}

if ([scopeFile, consumer, item, field].some((value) => !value)) {
  throw new Error('usage: skarbiec-acquire.mjs [<endpoint>] <scope-file> <consumer> <item> <field>');
}

// Resolve endpoint: legacy explicit takes priority, then env vars, then markers, then default
let endpointInfo;
if (legacyEndpoint) {
  // Legacy endpoint passed as 5th arg - treat as explicit authoritative override
  const { isEndpointListening } = await import('./endpoint-resolution.mjs');
  const listening = await isEndpointListening(legacyEndpoint);
  endpointInfo = {
    url: legacyEndpoint,
    source: 'legacy-argument',
    sourceDetail: 'positional endpoint argument (legacy 5-arg form)',
    isListening: listening,
  };
  // Explicit legacy endpoint must work or fail loudly
  if (!listening) {
    throw new Error(formatEndpointErrorMessage(endpointInfo));
  }
} else {
  // New form: resolve endpoint through standard order (env, markers, default)
  const { resolved } = await resolveSkarbiecEndpoint();
  if (!resolved) {
    throw new Error('Failed to resolve Skarbiec endpoint: no candidates evaluated');
  }
  endpointInfo = resolved;
}
const endpointText = endpointInfo.url;

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
  // Name the table that was read and how big it is: this refusal is produced
  // before the authority is contacted, so when it fires the interesting fact is
  // WHICH copy of the catalogue is in force, not the grant.
  throw new Error(
    `undeclared Skarbiec acquisition scope for ${consumer} on ${item}#${field}`
    + ` in ${scopeFile} (${scopeKeys.length} declared scopes)`,
  );
}

const endpoint = new URL(endpointText);
const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(endpoint.hostname);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))) {
  throw new Error('Skarbiec endpoint must be an HTTPS origin or loopback HTTP origin');
}

// Verify endpoint is listening; fail with detailed error if not
if (!endpointInfo.isListening) {
  throw new Error(formatEndpointErrorMessage(endpointInfo));
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
    `Skarbiec ${stage} at ${endpoint.origin} refused ${consumer} for ${item}#${field}: HTTP ${response.status}`
    + `${detail ? ` ${detail}` : ''}`
    // The issue call carries no bearer: the authority authorizes the tuple
    // (X-Consumer, item, field, workload_id, timestamp, nonce, Ed25519 signature).
    // A 401 therefore means the authority holds no token whose consumer, capability
    // and workload binding cover that tuple, so the workload identity this client
    // asserted has to be visible next to the refusal — it is a name, not a secret,
    // and without it the only unchecked half of the comparison stays invisible.
    + ` [asserted workload_id=${workloadId}, proof over ${consumer}\0${item}\0${field}]`,
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
// A dead endpoint and a refusing endpoint are different faults and were reported
// the same way: the launcher can export an authority nobody serves, and the caller
// then read "unauthorized" from whichever other authority answered, or an opaque
// fetch error. Name the endpoint and the reason it could not be reached.
async function post(path, headers, payload) {
  const target = new URL(path, endpoint);
  try {
    return await fetch(target, { method: 'POST', headers, body: payload });
  } catch (cause) {
    throw new Error(
      `Skarbiec at ${endpoint.origin} is unreachable for ${consumer} on ${item}#${field}`
      + ` (${path}): ${cause?.cause?.code ?? cause?.code ?? cause?.message ?? 'connection failed'}`,
    );
  }
}

const issueResponse = await post('/v1/acquisitions', commonHeaders, issueBody);
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

const readResponse = await post(
  '/v1/acquisitions/read',
  { ...commonHeaders, Authorization: `Bearer ${issued.token}` },
  body,
);
if (!readResponse.ok) {
  throw await refusal('one-time read', readResponse, consumer, item, field);
}
const result = await readResponse.json();
// The bound field, plus the one statement the item makes about itself that a
// caller needs to know which flow a credential belongs to: `provider`, present
// only when the item declares one (skarbiec 5864a54, 2026-08-31). Anything
// else is not a single-field response. Demanding the exact four keys here is
// what made every acquisition of a provider-declaring item fail as "invalid
// single-field response" once that release reached the fleet.
const requiredKeys = ['consumer', 'field', 'item', 'value'];
const optionalKeys = ['provider'];
const keys = Object.keys(result || {});
if (!result || result.consumer !== consumer || result.item !== item || result.field !== field
    || requiredKeys.some((key) => !keys.includes(key))
    || keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))
    || typeof result.value !== 'string' || !result.value
    || (result.provider !== undefined && (typeof result.provider !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(result.provider)))) {
  throw new Error('Skarbiec returned an invalid single-field response');
}
process.stdout.write(result.value);
