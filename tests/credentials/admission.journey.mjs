import assert from 'node:assert/strict';
import { constants as http } from 'node:http2';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveWelesEndpoint, readCredentialAdmissionBearer } from '../../node_modules/@wisent-ai/weles-client/src/stado-admission.mjs';

const root = resolve(import.meta.dirname, '../..');
const identityPath = join(root, 'release/source-identity.json');
const packaged = existsSync(identityPath);
const source = packaged ? JSON.parse(readFileSync(identityPath, 'utf8')) : {
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
};
let endpoint;
let bearer;
const id = createHash('sha256').update(randomUUID()).digest('hex');
const evidence = join(root, '.wisent-output', 'credential-admission-tests', id);
mkdirSync(evidence, { recursive: true });
const report = { source, commands: [], verdict: 'running', command: [process.execPath, ...process.argv.slice(1)] };
if (!packaged) writeFileSync(join(evidence, 'source.patch'), execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root }));
const request = {
  version: 'skarbiec.credential-operation.v3', request_id: id,
  mode: 'submit', action_log_id: null, approval_id: null, resume_token: null,
  credential_id: 'winston', operation: 'verify', provider: 'winston',
  consumer: 'winston-writer', field: 'api_key',
  purpose: 'Verify admission refusals and persisted status without provider interaction',
  account_email: null, directory: null, signup_origin: 'https://dev.gowinston.ai',
  baseline_revision: Number('0'), status: 'pending', created_at: new Date().toISOString(), dry_run: false,
};

function retain() {
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, Number('2')));
}

async function call(body, authenticated = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (authenticated) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const payload = await response.json();
  report.commands.push({ method: 'POST', authenticated, request: body, http_status: response.status, response: payload });
  retain();
  return { status: response.status, payload };
}

try {
  endpoint = new URL('/api/v1/credential-operations', resolveWelesEndpoint());
  report.endpoint = endpoint.href;
  bearer = readCredentialAdmissionBearer();
  const health = await fetch(new URL('/healthz', endpoint));
  const identity = await health.json();
  report.deployed = identity;
  retain();
  assert.equal(identity.releaseVersion, source.version);
  assert.ok(identity.releaseSha256);

  const unauthorized = await call(request, false);
  assert.equal(unauthorized.status, http.HTTP_STATUS_UNAUTHORIZED);
  assert.equal(unauthorized.payload.code, 'WELES_CREDENTIAL_UNAUTHORIZED');

  const absent = await call({ ...request, mode: 'status', action_log_id: `credential-${id}` });
  assert.equal(absent.status, http.HTTP_STATUS_NOT_FOUND);
  assert.equal(absent.payload.code, 'WELES_CREDENTIAL_REQUEST_NOT_FOUND');

  const wrongWriter = await call({ ...request, consumer: 'another-writer' });
  assert.equal(wrongWriter.status, http.HTTP_STATUS_CONFLICT);
  assert.equal(wrongWriter.payload.code, 'WELES_CREDENTIAL_CONTRACT_MISMATCH');

  const unsupported = await call(request);
  assert.equal(unsupported.status, http.HTTP_STATUS_OK);
  assert.equal(unsupported.payload.status, 'unsupported_operation');
  const settled = await call({ ...request, mode: 'status', action_log_id: unsupported.payload.actionLogId });
  assert.equal(settled.status, http.HTTP_STATUS_OK);
  assert.equal(settled.payload.status, 'unsupported_operation');

  const changed = await call({ ...request, purpose: 'A different request cannot reuse the admitted identity' });
  assert.equal(changed.status, http.HTTP_STATUS_CONFLICT);
  assert.equal(changed.payload.code, 'WELES_CREDENTIAL_REQUEST_CONFLICT');
  report.verdict = 'passed';
  report.claim = 'Real authentication, refusal and persisted-status journey; no provider acquisition was attempted.';
} catch (error) {
  report.verdict = 'failed';
  report.error = error.message;
  process.exitCode = Number('1');
} finally {
  retain();
  console.log(`Credential admission evidence: ${evidence}`);
}
