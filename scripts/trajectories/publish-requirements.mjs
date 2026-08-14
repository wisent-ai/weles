// Publish the trajectory capability declaration to the fleet, byte for byte.
//
// `scripts/trajectories/requirements.json` is read on the host that runs a
// trajectory, which only helps hosts that already carry the Weles tree. The
// layers that decide *where* a trajectory may run -- placement, and
// `stado registry doctor` resolving a declared service to its trajectory id --
// live outside this repository and need the same declaration. The registry must
// not carry a second copy of it, because two copies drift and the drift is what
// this whole capability model exists to end, so the file is published once as one
// fleet object and everybody reads that:
//
//   stado://probierz/job_requirements/weles-trajectories.json
//
// The bytes published are the bytes of the file, unreformatted: a consumer that
// checksums the object must get the same digest as a consumer that checksums the
// checkout. This script therefore parses the file only to refuse publishing
// something malformed, and uploads the original buffer either way.
//
// Transport is the object API every other Stado client already uses --
// `PUT /api/object?uri=<uri>` with a bearer -- reached through the loopback
// adapter named in `storage.stado.url`, with the bearer read from
// `storage.stado.token_file`. No second transport, no direct bucket write.
//
// Nothing prints the bearer: its length and digest are printed instead, which is
// enough to tell "wrong token" from "no token" without leaking one.
//
// Run: node scripts/trajectories/publish-requirements.mjs

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIREMENTS_FILE = process.env.WELES_TRAJECTORY_REQUIREMENTS_FILE
  ?? path.join(HERE, 'requirements.json');
const OBJECT_URI = process.env.WELES_TRAJECTORY_REQUIREMENTS_URI
  ?? 'stado://probierz/job_requirements/weles-trajectories.json';
const REQUIREMENTS_SCHEMA = 'wisent.trajectory-requirements.v1';
// The capability ids this first pass defines. A declaration naming anything else
// has no reader anywhere on the fleet, and publishing it would put a promise in
// front of every consumer that nothing can keep.
const KNOWN_CAPABILITIES = ['display', 'browser-render', 'os'];
const STADO_CONFIG = process.env.STADO_CONFIG
  ?? path.join(os.homedir(), '.config', 'stado', 'config.json');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 'a'.repeat(16).length);

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice('~/'.length)) : value;
}

// Where the object API is and what authorises this write. Both come from the
// same `storage.stado` block the rest of Stado reads, so a fleet that moves its
// object API moves this publisher with it and no address is duplicated here.
function objectApi() {
  const url = process.env.WELES_OBJECT_API_URL ?? '';
  const tokenFile = process.env.WELES_OBJECT_API_TOKEN_FILE ?? '';
  let caFile = process.env.WELES_OBJECT_API_CA_FILE ?? '';
  let resolved = { url, tokenFile, caFile, source: 'environment' };
  if (!url || !tokenFile) {
    if (!existsSync(STADO_CONFIG)) {
      throw new Error(`no object API configuration: ${STADO_CONFIG} is absent and WELES_OBJECT_API_URL / WELES_OBJECT_API_TOKEN_FILE are unset`);
    }
    const stado = JSON.parse(readFileSync(STADO_CONFIG, 'utf8'))?.storage?.stado;
    if (!stado?.url || !stado?.token_file) {
      throw new Error(`${STADO_CONFIG} has no storage.stado.url and storage.stado.token_file to publish through`);
    }
    resolved = {
      url: url || stado.url,
      tokenFile: tokenFile || stado.token_file,
      caFile: caFile || stado.ca_file || '',
      source: STADO_CONFIG,
    };
  }
  const endpoint = new URL(resolved.url);
  const tokenPath = expandHome(resolved.tokenFile);
  if (!existsSync(tokenPath)) throw new Error(`object API bearer file is absent: ${tokenPath}`);
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error(`object API bearer file is empty: ${tokenPath}`);
  caFile = resolved.caFile ? expandHome(resolved.caFile) : '';
  return { endpoint, token, tokenPath, caFile, source: resolved.source };
}

// One request, on core http/https so an endpoint behind the fleet's own CA works
// without asking the operator to set NODE_EXTRA_CA_CERTS before the process
// starts.
function request(method, api, body) {
  const target = new URL(`${api.endpoint.origin}/api/object`);
  target.searchParams.set('uri', OBJECT_URI);
  const transport = target.protocol === 'https:' ? https : http;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      Accept: 'application/json',
    },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = String(body.byteLength);
  }
  if (target.protocol === 'https:' && api.caFile && existsSync(api.caFile)) {
    options.ca = readFileSync(api.caFile);
  }
  return new Promise((resolve, reject) => {
    const req = transport.request(target, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(Number('60000'), () => req.destroy(new Error(`${method} ${OBJECT_URI} timed out`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const bytes = readFileSync(REQUIREMENTS_FILE);
const document = JSON.parse(bytes.toString('utf8'));
if (document?.schema !== REQUIREMENTS_SCHEMA) {
  throw new Error(`${REQUIREMENTS_FILE} declares schema '${document?.schema}', expected '${REQUIREMENTS_SCHEMA}'`);
}
const trajectories = Object.entries(document?.trajectories ?? {});
if (!trajectories.length) throw new Error(`${REQUIREMENTS_FILE} declares no trajectories`);
for (const [trajectory, required] of trajectories) {
  if (!Array.isArray(required)) throw new Error(`${trajectory} does not declare a list of capabilities`);
  for (const capability of required) {
    if (!KNOWN_CAPABILITIES.includes(capability)) {
      throw new Error(`${trajectory} declares capability '${capability}', which is not one of ${KNOWN_CAPABILITIES.join(', ')}`);
    }
  }
}

const api = objectApi();
process.stdout.write(`file      ${REQUIREMENTS_FILE} (${bytes.byteLength} bytes, sha256 ${digest(bytes)})\n`);
process.stdout.write(`declares  ${trajectories.map(([name, required]) => `${name}=[${required.join(',')}]`).join(' ')}\n`);
process.stdout.write(`endpoint  ${api.endpoint.origin} (from ${api.source})\n`);
process.stdout.write(`bearer    ${api.tokenPath} (${api.token.length} chars, sha256 ${digest(api.token)})\n`);
process.stdout.write(`uri       ${OBJECT_URI}\n`);

const put = await request('PUT', api, bytes);
process.stdout.write(`PUT       HTTP ${put.status} ${put.body.toString('utf8').trim().slice(0, Number('300'))}\n`);
if (put.status < Number('200') || put.status >= Number('300')) {
  process.stderr.write(`FAIL: the object API refused the write with HTTP ${put.status}. A 401 here means the '${new URL(OBJECT_URI).host}' namespace policy has no prefix rule covering '${OBJECT_URI.split('/').slice(3, -1).join('/')}/'.\n`);
  process.exit(1);
}

// Read it back through the same adapter: a write that reports success and a read
// that returns different bytes is the shape of failure worth catching, and the
// consumers all arrive through this door.
const got = await request('GET', api);
process.stdout.write(`GET       HTTP ${got.status} (${got.body.byteLength} bytes, sha256 ${digest(got.body)})\n`);
if (got.status !== Number('200') || !got.body.equals(bytes)) {
  process.stderr.write(`FAIL: published object does not read back byte-identical (local ${bytes.byteLength} bytes ${digest(bytes)}, remote ${got.body.byteLength} bytes ${digest(got.body)}).\n`);
  process.exit(1);
}
process.stdout.write(`published ${OBJECT_URI} reads back byte-identical\n`);
