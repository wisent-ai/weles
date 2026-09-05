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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stadoBinary } from '../_shared/skarbiec-runtime.mjs';
import { issueAppleLoginCapabilities } from './apple-account-placement.mjs';

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
const executionRunner = String(args['--execution-runner'] ?? '');
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
if (executionRunner && !executionRunner.startsWith('/')) {
  throw new Error('--execution-runner must be an absolute path on the execution host');
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
if (existsSync(keyOut) || existsSync(certOut)) {
  throw new Error('refusing to replace an existing private key or certificate');
}

const guardId = randomUUID();
const stado = stadoBinary();
// The shell expands this path on the pinned worker. The trajectory receives
// the equivalent `~/...` form and resolves it against that worker's home.
const runner = executionRunner
  ? shellQuote(executionRunner)
  : '"$HOME"/weles/scripts/worker/stado-action-runner.mjs';
const remoteRelative = `weles/var/developer-id-${guardId}`;
const remoteBase = `"$HOME"/${remoteRelative}`;
const remoteTrajectoryBase = `~/${remoteRelative}`;
let capabilities = null;

function openssl(argv, input) {
  const result = spawnSync('openssl', argv, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`openssl ${argv[0]}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function stadoMachine(argv) {
  const result = spawnSync(stado, ['machine', ...argv], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, HOME: homedir() },
  });
  let envelope = null;
  try {
    envelope = JSON.parse(String(result.stdout || ''));
  } catch {
    // The transport error below is more useful than a second JSON error.
  }
  if (result.error || result.status !== 0 || envelope?.ok !== true) {
    const detail = envelope?.error?.message
      || String(result.stderr || result.error?.message || '').trim()
      || `exit ${result.status}`;
    throw new Error(`Stado machine ${argv[0]} failed: ${detail}`);
  }
  return envelope.result;
}

class TerminalJobError extends Error {}

async function waitForStadoJob(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const report = stadoMachine(['status', jobId]);
      const state = report?.job?.state;
      if (state === 'completed' || state === 'uploaded') return state;
      if (state === 'failed' || state === 'cancelled') {
        throw new TerminalJobError(
          `Stado job ${jobId} ${state}: ${report?.job?.error || 'no reason recorded'}`,
        );
      }
      lastError = null;
    } catch (error) {
      if (error instanceof TerminalJobError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  try {
    stadoMachine(['cancel', jobId]);
  } catch {
    // The timeout remains the useful failure when cancellation cannot be confirmed.
  }
  const suffix = lastError instanceof Error ? `; last status error: ${lastError.message}` : '';
  throw new Error(`Stado job ${jobId} did not finish before its authorization expired${suffix}`);
}

function readStadoJobLog(jobId) {
  const pageSize = 1024 * 1024;
  const maxBytes = 8 * pageSize;
  let cursor = 0;
  let text = '';
  while (true) {
    const page = stadoMachine([
      'logs',
      jobId,
      '--cursor',
      String(cursor),
      '--limit',
      String(pageSize),
    ]);
    if (page?.cursor !== cursor || !Number.isSafeInteger(page?.next_cursor)
        || page.next_cursor < cursor || typeof page?.text !== 'string') {
      throw new Error(`Stado returned an invalid log page for ${jobId}`);
    }
    text += page.text;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Stado job ${jobId} output exceeded ${maxBytes} bytes`);
    }
    if (page.eof === true) return text;
    if (page.next_cursor === cursor) {
      throw new Error(`Stado job ${jobId} log cursor did not advance`);
    }
    cursor = page.next_cursor;
  }
}

function resultFromJobLog(jobId, authorizationId) {
  const log = readStadoJobLog(jobId);
  const matches = [...log.matchAll(/^CERTIFICATE_BASE64=([A-Za-z0-9+/]+={0,2})$/gm)];
  if (matches.length !== 1 || matches[0][1].length % 4 !== 0) {
    throw new Error(`Stado job ${jobId} did not return exactly one certificate`);
  }
  const encoded = matches[0][1];
  const certificate = Buffer.from(encoded, 'base64');
  if (certificate.length === 0 || certificate.toString('base64') !== encoded) {
    throw new Error(`Stado job ${jobId} returned invalid certificate encoding`);
  }
  const validation = spawnSync('openssl', ['x509', '-inform', 'DER', '-noout'], {
    input: certificate,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (validation.error || validation.status !== 0) {
    throw new Error(`Stado job ${jobId} returned a file that is not a DER X.509 certificate`);
  }
  const receipts = [...log.matchAll(/^APPLE_TWO_FACTOR_RECEIPT=(.+)$/gm)];
  if (receipts.length > 1) throw new Error(`Stado job ${jobId} returned multiple Apple 2FA receipts`);
  const twoFactor = receipts.length === 1 ? JSON.parse(receipts[0][1]) : null;
  if (twoFactor && (
    twoFactor.authorization_id !== authorizationId
    || twoFactor.source !== 'capability'
    || twoFactor.provider_accepted !== true
    || !['holder', 'user', 'destination'].every((field) =>
      typeof twoFactor[field] === 'string' && twoFactor[field].length > 0)
  )) {
    throw new Error(`Stado job ${jobId} returned an invalid Apple 2FA receipt`);
  }
  return { certificate, twoFactor };
}

const workRoot = join(homedir(), '.stado', 'work');
mkdirSync(workRoot, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(workRoot, 'developer-id-csr-'));
let queued = null;
let keyWritten = false;
let submissionStarted = false;
try {
  // Keypair and request here; only the request travels.
  const keyPath = join(scratch, 'key.pem');
  openssl(['genrsa', '-out', keyPath, '2048']);
  const csr = openssl(['req', '-new', '-key', keyPath, '-subj', subject]);
  writeFileSync(keyOut, readFileSync(keyPath), { mode: 0o600, flag: 'wx' });
  keyWritten = true;

  capabilities = issueAppleLoginCapabilities({
    executionHost,
    executionAgent,
    authorizationId: guardId,
    ttlSeconds: expiryMinutes * 60,
  });

  const payload = Buffer.from(JSON.stringify({
    action: ACTION,
    accountItem,
    params: {
      apple_auth_guard_id: guardId,
      apple_execution_host: executionHost,
      apple_execution_agent: executionAgent,
      apple_login_capabilities: capabilities,
      apple_csr_path: `${remoteTrajectoryBase}/request.csr`,
      apple_certificate_path: `${remoteTrajectoryBase}/certificate.cer`,
    },
  }), 'utf8').toString('base64url');

  // One job: place the request, run the tracked trajectory, print the issued
  // certificate. It prints rather than leaving the file behind so the result
  // travels through Stado's own job output and the worker keeps no copy.
  const command = [
    'set -eu',
    'umask 077',
    `cleanup_dir=${remoteBase}`,
    'trap \'rm -rf "$cleanup_dir"\' EXIT',
    'mkdir -p "$cleanup_dir"',
    `printf %s ${Buffer.from(csr, 'utf8').toString('base64')} | base64 -d > ${remoteBase}/request.csr`,
    `node ${runner} ${payload}`,
    `printf 'CERTIFICATE_BASE64='; base64 < ${remoteBase}/certificate.cer | tr -d '\\n'; printf '\\n'`,
  ].join('; ');

  submissionStarted = true;
  const submit = spawnSync(stado, [
    'submit', `sh -lc ${shellQuote(command)}`,
    '--priority', '0', '--pinned-host', executionHost,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, HOME: homedir() } });
  if (submit.error || submit.status !== 0) {
    throw new Error(`Stado refused ${ACTION}: ${(submit.stderr || submit.error?.message || '').trim()}`);
  }
  const match = String(submit.stdout).match(/\b[0-9a-f]{8}\b/i);
  if (!match) throw new Error(`Stado accepted ${ACTION} but returned no job id`);
  queued = match[0];

  const terminalState = await waitForStadoJob(queued, expiryMinutes * 60_000);
  const { certificate, twoFactor } = resultFromJobLog(queued, guardId);
  writeFileSync(certOut, certificate, { mode: 0o644, flag: 'wx' });
  console.log(JSON.stringify({
    status: terminalState,
    action: ACTION,
    job_id: queued,
    guard_id: guardId,
    account_item: accountItem,
    execution_host: executionHost,
    two_factor: twoFactor,
    private_key: keyOut,
    certificate: certOut,
  }, null, 2));
} catch (error) {
  if (keyWritten && !submissionStarted) {
    rmSync(keyOut, { force: true });
  }
  if (capabilities) {
    console.error(JSON.stringify({
      status: 'failed',
      guard_id: guardId,
      execution_host: executionHost,
      issued_capabilities: 3,
      bound_by: `ttl ${expiryMinutes * 60}s, max-uses 1 each`,
      note: 'the execution host expires any capability that the trajectory did not consume',
    }));
  }
  throw error;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
