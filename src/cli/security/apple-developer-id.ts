// weles apple-developer-id: one Apple Developer ID Application certificate,
// one authorization, one run.
//
// Apple issues this certificate only in the developer portal (its API answers
// 403 "only the Account Holder" for every App Store Connect key), and the
// portal is Weles' to drive. Start mode generates the RSA key and certificate
// request here — the key never leaves this machine, the request is public —
// mints the three one-use Apple capabilities on the execution host through
// Stado, and starts apple_create_developer_id there detached. Read mode takes
// the run's result, checks it holds exactly one DER X.509 certificate and a
// well-formed Apple 2FA receipt when one was needed, and writes the certificate.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ParsedCli } from '../../cli.js';
import { issueAppleAuthorization, readAppleRun, startAppleRun } from '../../runtime/api/apple-runs.js';

const CONFIRMATION_PHRASE = 'AUTHORIZE ONE APPLE DEVELOPER ID';
const APPLE_ACCOUNT = /^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const STANDARD_AGENT = 'weles-worker';
const STANDARD_SUBJECT = '/CN=Wisent-AI Developer ID Application/O=Wisent-AI, Inc/C=US';
const STANDARD_EXPIRY_MINUTES = 15;
const MIN_EXPIRY_MINUTES = 1;
const MAX_EXPIRY_MINUTES = 60;
const RSA_BITS = '2048';
const OWNER_ONLY_FILE = 0o600;
const PUBLIC_FILE = 0o644;
const START_OPTIONS = ['account-item', 'confirm', 'execution-host', 'execution-agent', 'private-key-out', 'expires-in-minutes', 'subject'];
const READ_OPTIONS = ['run', 'certificate-out', 'private-key', 'store-host'];
// The role every darwin release recipe reads its signing identity through
// (MACOS_CERT_P12, MACOS_CERT_PASSWORD, MACOS_SIGN_IDENTITY): Stado selects
// the vault item tagged stado:role:<role>, so no item is named here.
const SIGNING_ROLE = 'macos-developer-id';
const SIGNING_ITEM_KIND = 'bundle';
const P12_PASSWORD_BYTES = 24;

// The certificate's common name, which is the identity codesign selects.
function commonName(certificate: Buffer): string {
  const subject = openssl(['x509', '-inform', 'DER', '-noout', '-subject', '-nameopt', 'multiline'], certificate);
  const name = subject.match(/^\s*commonName\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!name) throw new Error('the issued certificate names no common name to sign with');
  return name;
}

// Package key and certificate as one PKCS#12 and store it, with its password
// and signing identity, in the vault the release recipes read. The password
// reaches openssl through its environment, never its argument list.
function storeSigningIdentity(certificate: Buffer, privateKey: string, storeHost: string): Record<string, unknown> {
  if (!isAbsolute(privateKey) || !existsSync(privateKey)) throw new Error('--private-key must be the absolute path start mode wrote the key to');
  if (!HOST.test(storeHost)) throw new Error('--store-host must name the Stado host whose vault owns release secrets');
  const pem = openssl(['x509', '-inform', 'DER', '-outform', 'PEM'], certificate);
  const password = randomBytes(P12_PASSWORD_BYTES).toString('base64');
  const packed = spawnSync('openssl', ['pkcs12', '-export', '-inkey', privateKey, '-in', '/dev/stdin', '-passout', 'env:WELES_P12_PASSWORD'], {
    input: pem,
    env: { ...process.env, WELES_P12_PASSWORD: password },
  });
  if (packed.error || packed.status !== 0 || !packed.stdout?.length) {
    throw new Error(`openssl pkcs12: ${(packed.stderr?.toString() || packed.error?.message || `exit ${packed.status}`).trim()}`);
  }
  const identity = commonName(certificate);
  const payload = JSON.stringify({
    schema: 'skarbiec.item.v2',
    kind: SIGNING_ITEM_KIND,
    fields: {
      certificate_p12_base64: packed.stdout.toString('base64'),
      certificate_password: password,
      sign_identity: identity,
    },
    context: { provider: 'apple', certificate: 'developer-id-application' },
  });
  const stored = spawnSync('stado', ['credentials', 'item', 'put', '--host', storeHost, '--role', SIGNING_ROLE, '--type', SIGNING_ITEM_KIND, '--json'], {
    input: payload,
    encoding: 'utf8',
  });
  if (stored.error || stored.status !== 0) {
    throw new Error(`stado credentials item put --role ${SIGNING_ROLE} on ${storeHost}: ${(stored.stderr || stored.error?.message || `exit ${stored.status}`).trim()}`);
  }
  return { role: SIGNING_ROLE, host: storeHost, sign_identity: identity };
}

function text(parsed: ParsedCli, key: string): string | undefined {
  const value = parsed.options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new Error(`--${key} needs a value`);
  return value;
}

function openssl(argv: string[], input?: Buffer): string {
  const result = spawnSync('openssl', argv, { input, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`openssl ${argv[0]}: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  }
  return result.stdout;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

async function start(parsed: ParsedCli): Promise<Record<string, unknown>> {
  const accountItem = text(parsed, 'account-item') ?? '';
  const executionHost = text(parsed, 'execution-host') ?? '';
  const executionAgent = text(parsed, 'execution-agent') ?? STANDARD_AGENT;
  const keyOut = text(parsed, 'private-key-out') ?? '';
  const subject = text(parsed, 'subject') ?? STANDARD_SUBJECT;
  const expiryMinutes = Number(text(parsed, 'expires-in-minutes') ?? STANDARD_EXPIRY_MINUTES);
  if (!APPLE_ACCOUNT.test(accountItem)) throw new Error('--account-item must name an Apple Skarbiec login item (weles-apple-<name>-account)');
  if (text(parsed, 'confirm') !== CONFIRMATION_PHRASE) throw new Error(`--confirm must exactly equal "${CONFIRMATION_PHRASE}"`);
  if (!HOST.test(executionHost)) throw new Error('--execution-host must name the Stado host that runs the browser');
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < MIN_EXPIRY_MINUTES || expiryMinutes > MAX_EXPIRY_MINUTES) {
    throw new Error(`--expires-in-minutes must be a whole number between ${MIN_EXPIRY_MINUTES} and ${MAX_EXPIRY_MINUTES}`);
  }
  // The key is the half that matters: a certificate without it signs nothing,
  // so its destination is demanded before anything is issued.
  if (!isAbsolute(keyOut)) throw new Error('--private-key-out must be an absolute path on this machine');
  if (existsSync(keyOut)) throw new Error(`refusing to replace an existing private key at ${keyOut}`);

  openssl(['genrsa', '-out', keyOut, RSA_BITS]);
  chmodSync(keyOut, OWNER_ONLY_FILE);
  const csr = openssl(['req', '-new', '-key', keyOut, '-subj', subject]);
  const authorization = await issueAppleAuthorization(accountItem, executionHost, executionAgent, expiryMinutes);
  const runId = await startAppleRun('apple_create_developer_id', authorization, {
    apple_csr_base64: Buffer.from(csr, 'utf8').toString('base64'),
  });
  const guardId = authorization.guardId;
  return {
    status: 'running',
    run: runId,
    guard_id: guardId,
    account_item: accountItem,
    execution_host: executionHost,
    private_key: keyOut,
    capabilities_expire_in_minutes: expiryMinutes,
    next: `weles apple-developer-id --run ${runId} --certificate-out <absolute path> --private-key ${keyOut} --store-host <vault owner>`,
  };
}

function receiptOf(stdout: string): unknown {
  const receipts = [...stdout.matchAll(/^APPLE_TWO_FACTOR_RECEIPT=(.+)$/gm)];
  if (receipts.length > 1) throw new Error('the run returned more than one Apple 2FA receipt');
  if (!receipts.length) return null;
  const receipt = JSON.parse(receipts[0][1]);
  const complete = receipt.source === 'capability' && receipt.provider_accepted === true
    && nonEmpty(receipt.holder) && nonEmpty(receipt.user) && nonEmpty(receipt.destination);
  if (!complete) throw new Error('the run returned an invalid Apple 2FA receipt');
  return receipt;
}

async function read(parsed: ParsedCli): Promise<Record<string, unknown>> {
  const runId = text(parsed, 'run') ?? '';
  const certificateOut = text(parsed, 'certificate-out') ?? '';
  const privateKey = text(parsed, 'private-key');
  const storeHost = text(parsed, 'store-host');
  if ((privateKey === undefined) !== (storeHost === undefined)) {
    throw new Error('--private-key and --store-host go together: both store the identity in the vault, neither leaves it in files');
  }
  if (!isAbsolute(certificateOut)) throw new Error('--certificate-out must be an absolute path on this machine');
  if (existsSync(certificateOut)) throw new Error(`refusing to replace an existing certificate at ${certificateOut}`);
  const run = await readAppleRun(runId);
  if (run.status === 'running') return { status: 'running', run: run.id };
  if (run.ok !== true || !run.stdout) {
    return { status: run.status, run: run.id, ok: false, error: run.error };
  }
  const matches = [...run.stdout.matchAll(/^CERTIFICATE_BASE64=([A-Za-z0-9+/]+={0,2})$/gm)];
  if (matches.length !== 1) throw new Error(`run ${run.id} did not return exactly one certificate`);
  const certificate = Buffer.from(matches[0][1], 'base64');
  openssl(['x509', '-inform', 'DER', '-noout'], certificate);
  const receipt = receiptOf(run.stdout);
  writeFileSync(certificateOut, certificate, { mode: PUBLIC_FILE, flag: 'wx' });
  const stored = privateKey && storeHost ? storeSigningIdentity(certificate, privateKey, storeHost) : null;
  return { status: 'issued', run: run.id, certificate: certificateOut, two_factor: receipt, stored };
}

export async function runAppleDeveloperId(parsed: ParsedCli): Promise<void> {
  const keys = Object.keys(parsed.options);
  const reading = keys.includes('run');
  const allowed = reading ? READ_OPTIONS : START_OPTIONS;
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (parsed.positional.length || unknown.length) {
    throw new Error(`apple-developer-id takes either ${START_OPTIONS.map((key) => `--${key}`).join(' ')} or ${READ_OPTIONS.map((key) => `--${key}`).join(' ')}; got ${[...parsed.positional, ...unknown.map((key) => `--${key}`)].join(' ')}`);
  }
  const row = reading ? await read(parsed) : await start(parsed);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (row.ok === false) process.exitCode = 1;
}
