#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const [endpointText, consumer, item, field, tokenFile, operation, operationId] =
  process.argv.slice(Number('2'));
const exactName = /^[A-Za-z\d._-]+$/;
if (!endpointText || !consumer || !item || !field || !tokenFile || !operation || !operationId
    || !exactName.test(consumer) || !exactName.test(item) || !exactName.test(field)
    || !['acquire', 'adopt', 'rotate', 'reset', 'verify', 'rollback'].includes(operation)
    || !/^[a-f\d]{64}$/i.test(operationId) || !isAbsolute(tokenFile)) {
  throw new Error(
    'usage: skarbiec-write.mjs <endpoint> <consumer> <item> <field> <absolute-token-file> <operation> <operation-id>'
  );
}

const endpoint = new URL(endpointText);
const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(endpoint.hostname);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))) {
  throw new Error('Skarbiec endpoint must be an HTTPS origin or loopback HTTP origin');
}

const unsafeBits = Number.parseInt('077', Number('8'));
const metadata = lstatSync(tokenFile);
if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & unsafeBits) !== Number('0')) {
  throw new Error('unsafe Skarbiec writer token file');
}

const chunks = [];
let received = Number('0');
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > Number('65536')) throw new Error('credential write exceeded size limit');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const token = readFileSync(tokenFile);
try {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.schema !== 'skarbiec.item.v2'
      || typeof payload.kind !== 'string'
      || !payload.fields || typeof payload.fields !== 'object'
      || Array.isArray(payload.fields)
      || !Object.prototype.hasOwnProperty.call(payload.fields, field)) {
    throw new Error('credential write must contain one canonical payload with the exact field');
  }
  // A generic acquire declared its signup origin to Skarbiec, and Skarbiec
  // refuses the write unless the body echoes exactly that origin. It equally
  // refuses an origin presented for an operation that declared none, so the key
  // is forwarded only when the payload carries one and only as an exact origin.
  const captureOrigin = payload.capture_origin ?? null;
  if (captureOrigin !== null
      && (typeof captureOrigin !== 'string'
        || captureOrigin.length > Number('512')
        || !URL.canParse(captureOrigin)
        || new URL(captureOrigin).protocol !== 'https:'
        || new URL(captureOrigin).origin !== captureOrigin)) {
    throw new Error('credential write capture origin must be one absolute https origin');
  }
  const bearer = token.toString('utf8');
  if (!bearer || /\s/.test(bearer)) throw new Error('invalid Skarbiec writer token');
  const mode = operation === 'acquire' ? 'acquire' : 'stage';
  const value = mode === 'acquire' ? payload : payload.fields[field];
  const response = await fetch(new URL('/v1/items', endpoint), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      'X-Consumer': consumer,
    },
    body: JSON.stringify({
      id: item,
      field,
      value,
      mode,
      operation_id: operationId,
      provider_verified: true,
      ...(captureOrigin ? { capture_origin: captureOrigin } : {}),
    }),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Skarbiec write rejected: HTTP ${response.status}`);
  const result = JSON.parse(responseText);
  if (!result || result.ok !== true || result.id !== item) {
    throw new Error('Skarbiec returned an invalid write response');
  }
} finally {
  token.fill(Number('0'));
  bytes.fill(Number('0'));
  for (const chunk of chunks) chunk.fill(Number('0'));
}
