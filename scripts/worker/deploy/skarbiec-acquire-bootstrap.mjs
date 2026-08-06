#!/usr/bin/env node

import { readFileSync, lstatSync } from 'node:fs';

const [endpointText, scopeFile, consumer, tokenFile, item, field] =
  process.argv.slice(Number('2'));
if ([endpointText, scopeFile, consumer, tokenFile, item, field].some((value) => !value)) {
  throw new Error('usage: skarbiec-acquire-bootstrap.mjs <endpoint> <scope-file> <consumer> <bootstrap-token-file> <item> <field>');
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

const metadata = lstatSync(tokenFile);
const unsafeBits = Number.parseInt('077', Number('8'));
if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
    || (metadata.mode & unsafeBits) !== Number('0')) {
  throw new Error(`unsafe Skarbiec bootstrap token file for ${consumer}`);
}
const bootstrap = readFileSync(tokenFile, 'utf8').trim();
if (!bootstrap || /\s/.test(bootstrap)) {
  throw new Error(`invalid Skarbiec bootstrap token for ${consumer}`);
}

const body = JSON.stringify({ id: item, field });
const commonHeaders = {
  'Content-Type': 'application/json',
  'X-Consumer': consumer,
};
const issueResponse = await fetch(new URL('/v1/acquisitions', endpoint), {
  method: 'POST',
  headers: { ...commonHeaders, Authorization: `Bearer ${bootstrap}` },
  body,
});
if (!issueResponse.ok) {
  throw new Error(`Skarbiec acquisition request rejected for ${consumer}/${item}/${field}: HTTP ${issueResponse.status}`);
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
  throw new Error(`Skarbiec one-time read rejected for ${consumer}/${item}/${field}: HTTP ${readResponse.status}`);
}
const result = await readResponse.json();
const expectedKeys = ['consumer', 'field', 'item', 'value'];
if (!result || result.consumer !== consumer || result.item !== item || result.field !== field
    || Object.keys(result).sort().join('|') !== expectedKeys.join('|')
    || typeof result.value !== 'string' || !result.value) {
  throw new Error('Skarbiec returned an invalid single-field response');
}
process.stdout.write(result.value);
