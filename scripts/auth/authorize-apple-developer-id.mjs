#!/usr/bin/env node

// Apple Developer ID Application certificate: one authorization, one run.
//
// The sibling of authorize-apple-login.mjs, for the one certificate Apple will
// not issue over its API. Measured: POST /v1/certificates answers 403 "This
// operation can only be performed by the Account Holder" for every App Store
// Connect key, and an ASC key carries a team role, never that one. So the
// portal is unavoidable, and Weles owns the portal.
//
// This mints the same three one-use capabilities the login authorizer mints,
// then enqueues the tracked create_developer_id trajectory pinned to the host
// that will run the browser.
//
// The private key never leaves this machine. The CSR is generated here, travels
// to the worker as base64 inside the job command — a CSR is public — and the
// issued certificate comes back in the job's own output, which is public too.
// Nothing secret is written to the queue, to a log, or to argv.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeSkarbiecBinary } from '../_shared/skarbiec-runtime.mjs';

const CONFIRMATION_PHRASE = 'AUTHORIZE ONE APPLE DEVELOPER ID';
const ACTION = 'create_developer_id';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
  return pairs;
}, []));

const accountItem = String(args['--account-item'] ?? '');
const confirmation = String(args['--confirm'] ?? '');
const executionHost = String(args['--execution-host'] ?? '');
const executionAgent = String(args['--execution-agent'] ?? 'weles-worker');
const expiryMinutes = Number(args['--expires-in-minutes'] ?? '15');
const keyOut = String(args['--private-key-out'] ?? '');
const certOut = String(args['--certificate-out'] ?? '');
const subject = String(args['--subject'] ?? '/CN=Wisent-AI Developer ID Application/O=Wisent-AI, Inc/C=US');

if (!/^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/.test(accountItem)) {
  throw new Error('--account-item must name an Apple Skarbiec login item');
}
if (confirmation !== CONFIRMATION_PHRASE) {
  throw new Error(`--confirm must exactly equal "${CONFIRMATION_PHRASE}"`);
}
if (!executionHost || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(executionHost)) {
  throw new Error('--execution-host is invalid');
}
if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 60) {
  throw new Error('--expires-in-minutes must be a whole number between 1 and 60');
}
// The private key is the half that matters. Demand a destination for it up front
// rather than discovering after a successful portal run that there is nowhere to
// put it — the certificate without its key signs nothing.
if (!keyOut.startsWith('/') || !certOut.startsWith('/')) {
  throw new Error('--private-key-out and --certificate-out must be absolute paths on this machine');
}

const guardId = randomUUID();
const skarbiec = activeSkarbiecBinary();
const stado = process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
// Left unexpanded on purpose. The command runs on the worker under the worker's
// own account, so embedding this machine's home directory would point the job at
// a path that does not exist there. `enqueueWelesAction` interpolates the
// submitter's home; that only works when the submitter is the worker.
const runner = '"$HOME"/weles/scripts/worker/stado-action-runner.mjs';
const remoteBase = '"$HOME"/weles/var/developer-id-' + guardId;
const issued = [];

function openssl(argv, input) {
  const result = spawnSync('openssl', argv, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`openssl ${argv[0]}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout;
}

function capability(purpose, resource) {
  const result = spawnSync(skarbiec, [
    'capability-issue', '--agent', executionAgent, '--purpose', purpose,
    '--resource', resource, '--target', 'weles', '--ttl', String(expiryMinutes * 60),
    '--max-uses', '1', '--authorization-id', guardId,
  ], { encoding: 'utf8', env: process.env });
  if (result.error || result.status !== 0) {
    throw new Error(`Skarbiec refused Apple capability: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const payload = JSON.parse(result.stdout);
  if (!/^[0-9a-f]{64}$/.test(String(payload.capability_id ?? ''))) {
    throw new Error('Skarbiec returned an invalid capability id');
  }
  issued.push(payload.capability_id);
  return { capability_id: payload.capability_id, purpose, resource, target: 'weles', authorization_id: guardId };
}

const scratch = mkdtempSync(join(tmpdir(), 'developer-id-csr-'));
let queued = null;
try {
  // Keypair and request here; only the request travels.
  const keyPath = join(scratch, 'key.pem');
  openssl(['genrsa', '-out', keyPath, '2048']);
  const csr = openssl(['req', '-new', '-key', keyPath, '-subj', subject]);
  writeFileSync(keyOut, readFileSync(keyPath), { mode: 0o600 });

  const email = capability('weles.browser.fill', 'origin:https://idmsa.apple.com/email');
  const password = capability('weles.browser.fill', 'origin:https://idmsa.apple.com/password');
  const twoFactor = capability('weles.apple.2fa', `challenge:apple/${guardId}`);

  const payload = Buffer.from(JSON.stringify({
    action: ACTION,
    accountItem,
    params: {
      apple_auth_guard_id: guardId,
      apple_execution_host: executionHost,
      apple_execution_agent: executionAgent,
      apple_login_capabilities: { email, password, two_factor: { mode: 'capability', capability: twoFactor } },
      apple_csr_path: `${remoteBase}/request.csr`,
      apple_certificate_path: `${remoteBase}/certificate.cer`,
    },
  }), 'utf8').toString('base64url');

  // One job: place the request, run the tracked trajectory, print the issued
  // certificate. It prints rather than leaving the file behind so the result
  // travels through Stado's own job output and the worker keeps no copy.
  const command = [
    'set -eu',
    `umask 077`,
    `mkdir -p ${remoteBase}`,
    `printf %s ${Buffer.from(csr, 'utf8').toString('base64')} | base64 -d > ${remoteBase}/request.csr`,
    `node ${runner} ${payload}`,
    `printf 'CERTIFICATE_BASE64='; base64 < ${remoteBase}/certificate.cer | tr -d '\\n'; printf '\\n'`,
    `rm -rf ${remoteBase}`,
  ].join('; ');

  const submit = spawnSync(stado, [
    'submit', `sh -lc ${JSON.stringify(command)}`,
    '--priority', '0', '--pinned-host', executionHost,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, HOME: homedir() } });
  if (submit.error || submit.status !== 0) {
    throw new Error(`Stado refused ${ACTION}: ${(submit.stderr || submit.error?.message || '').trim()}`);
  }
  const match = String(submit.stdout).match(/\b[0-9a-f]{8}\b/i);
  if (!match) throw new Error(`Stado accepted ${ACTION} but returned no job id`);
  queued = match[0];

  console.log(JSON.stringify({
    status: 'queued',
    action: ACTION,
    job_id: queued,
    guard_id: guardId,
    account_item: accountItem,
    execution_host: executionHost,
    private_key: keyOut,
    certificate_out: certOut,
    next: `stado status ${queued}; then write the CERTIFICATE_BASE64 line from the job output to ${certOut}`,
  }, null, 2));
} catch (error) {
  // Not `capability-cancel`: no such command exists. The sibling login
  // authorizer calls it and ignores the failure, so its rollback has never
  // undone anything — which matters less than it sounds, because the only real
  // bound on an issued capability is the one it was issued with. Say what is
  // outstanding instead of pretending to withdraw it.
  if (issued.length) {
    console.error(JSON.stringify({
      status: 'failed',
      guard_id: guardId,
      outstanding_capabilities: issued.length,
      bound_by: `ttl ${expiryMinutes * 60}s, max-uses 1 each`,
      note: 'each capability expires on its own and can be redeemed once; nothing was enqueued',
    }));
  }
  throw error;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
