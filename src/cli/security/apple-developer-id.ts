// weles certificate --provider apple: one Apple Developer ID
// Application certificate, one authorization, one run. The command is named
// for what it issues; the provider is an argument, and apple is the one
// implemented. The certificate's subject is the caller's organization, so it
// is always named: no organization is built in.
//
// Apple issues this certificate only in the developer portal (its API answers
// "only the Account Holder" for every App Store Connect key), and the portal
// is Weles' to drive. Start mode generates the RSA key and certificate
// request here — the key never leaves this machine, the request is public —
// mints the three one-use Apple capabilities on the execution host through
// Stado, and starts apple_create_developer_id there detached. Read mode takes
// the run's result, checks it holds exactly one DER X.509 certificate and a
// well-formed Apple 2FA receipt when one was needed, and writes the certificate.

import { chmodSync, constants, existsSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ParsedCli } from '../../cli.js';
import { FAILURE_STATUS, printAnswer, UsageError } from '../usage.js';
import {
  issueAppleAuthorization,
  readAppleRun,
  startAppleRun,
} from '../../runtime/api/apple-runs.js';
import { HOST, openssl, storeSigningIdentity } from './apple/identity.js';

const CONFIRMATION_PHRASE = 'AUTHORIZE ONE APPLE DEVELOPER ID';
// The Skarbiec role the Apple Account Holder plays (tag stado:role:<role>);
// the worker selects the item, so no command names one.
const STANDARD_ACCOUNT_ROLE = 'apple-account-holder';
const ROLE = /^[a-z\d][a-z\d-]*$/;
const STANDARD_AGENT = 'weles-worker';
const PROVIDER = 'apple';
// The private key is the owner's alone; the certificate is public.
const OWNER_ONLY_FILE = constants.S_IRUSR | constants.S_IWUSR;
const PUBLIC_FILE = OWNER_ONLY_FILE | constants.S_IRGRP | constants.S_IROTH;
const START_OPTIONS = [
  'provider',
  'account-role',
  'confirm',
  'execution-host',
  'execution-agent',
  'private-key-out',
  'expires-in-minutes',
  'subject',
];
const READ_OPTIONS = ['run', 'certificate-out', 'private-key', 'store-host'];

function text(parsed: ParsedCli, key: string): string | undefined {
  const value = parsed.options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    throw new UsageError(`--${key} needs a value`);
  return value;
}

// An option the command cannot run without, refused by name when missing.
function required(parsed: ParsedCli, key: string): string {
  const value = text(parsed, key);
  if (value === undefined) throw new UsageError(`--${key} is required`);
  return value;
}

// An option whose documented standard stands when it is not given.
function chosen(parsed: ParsedCli, key: string, standard: string): string {
  const value = text(parsed, key);
  return value === undefined ? standard : value;
}

// A receipt field the provider filled in: a string holding any character.
function filled(value: unknown): boolean {
  return typeof value === 'string' && Boolean(value);
}

async function start(parsed: ParsedCli): Promise<Record<string, unknown>> {
  const accountRole = chosen(parsed, 'account-role', STANDARD_ACCOUNT_ROLE);
  const executionHost = required(parsed, 'execution-host');
  const executionAgent = chosen(parsed, 'execution-agent', STANDARD_AGENT);
  const keyOut = required(parsed, 'private-key-out');
  const subject = required(parsed, 'subject');
  // How long the one-use capabilities live is the operator's to say for each
  // run; no lifetime is chosen here.
  const expiryMinutes = Number(required(parsed, 'expires-in-minutes'));
  if (!ROLE.test(accountRole))
    throw new UsageError(
      '--account-role must be a Skarbiec role (lowercase letters, digits and hyphens)',
    );
  if (text(parsed, 'confirm') !== CONFIRMATION_PHRASE)
    throw new UsageError(
      `--confirm must exactly equal "${CONFIRMATION_PHRASE}"`,
    );
  if (!HOST.test(executionHost))
    throw new UsageError(
      '--execution-host must name the Stado host that runs the browser',
    );
  if (!Number.isInteger(expiryMinutes) || expiryMinutes <= 0) {
    throw new UsageError(
      '--expires-in-minutes must be a positive whole number of minutes',
    );
  }
  // The key is the half that matters: a certificate without it signs nothing,
  // so its destination is demanded before anything is issued.
  if (!isAbsolute(keyOut))
    throw new UsageError(
      '--private-key-out must be an absolute path on this machine',
    );
  if (!subject.startsWith('/CN='))
    throw new UsageError(
      '--subject is required: the certificate request\'s distinguished name, for example "/CN=<organization> Developer ID Application/O=<organization>/C=<country>"',
    );
  if (existsSync(keyOut))
    throw new Error(`refusing to replace an existing private key at ${keyOut}`);

  // OpenSSL's own RSA modulus is the size Apple's Developer ID request takes.
  openssl(['genrsa', '-out', keyOut]);
  chmodSync(keyOut, OWNER_ONLY_FILE);
  const csr = openssl(['req', '-new', '-key', keyOut, '-subj', subject]);
  const authorization = await issueAppleAuthorization(
    accountRole,
    executionHost,
    executionAgent,
    expiryMinutes,
  );
  const runId = await startAppleRun(
    'apple_create_developer_id',
    authorization,
    {
      apple_csr_base64: Buffer.from(csr, 'utf8').toString('base64'),
    },
  );
  const guardId = authorization.guardId;
  return {
    status: 'running',
    run: runId,
    guard_id: guardId,
    account_role: accountRole,
    execution_host: executionHost,
    private_key: keyOut,
    capabilities_expire_in_minutes: expiryMinutes,
    next: `weles certificate --run ${runId} --certificate-out <absolute path> --private-key ${keyOut} --store-host <vault owner>`,
  };
}

function receiptOf(stdout: string): unknown {
  const [first, ...more] = stdout.matchAll(
    /^APPLE_TWO_FACTOR_RECEIPT=(?<receipt>.+)$/gm,
  );
  if (more.length)
    throw new Error('the run returned more than one Apple 2FA receipt');
  const written = first?.groups?.receipt;
  if (written === undefined) return null;
  const receipt = JSON.parse(written);
  const complete =
    receipt.source === 'capability' &&
    receipt.provider_accepted === true &&
    filled(receipt.holder) &&
    filled(receipt.user) &&
    filled(receipt.destination);
  if (!complete)
    throw new Error('the run returned an invalid Apple 2FA receipt');
  return receipt;
}

async function read(parsed: ParsedCli): Promise<Record<string, unknown>> {
  const runId = required(parsed, 'run');
  const certificateOut = required(parsed, 'certificate-out');
  const privateKey = text(parsed, 'private-key');
  const storeHost = text(parsed, 'store-host');
  if ((privateKey === undefined) !== (storeHost === undefined)) {
    throw new UsageError(
      '--private-key and --store-host go together: both store the identity in the vault, neither leaves it in files',
    );
  }
  if (!isAbsolute(certificateOut))
    throw new UsageError(
      '--certificate-out must be an absolute path on this machine',
    );
  if (existsSync(certificateOut))
    throw new Error(
      `refusing to replace an existing certificate at ${certificateOut}`,
    );
  const run = await readAppleRun(runId);
  if (run.status === 'running') return { status: 'running', run: run.id };
  if (run.ok !== true || !run.stdout) {
    return { status: run.status, run: run.id, ok: false, error: run.error };
  }
  const [first, ...more] = run.stdout.matchAll(
    /^CERTIFICATE_BASE64=(?<der>[A-Za-z\d+/]+=*)$/gm,
  );
  const der = first?.groups?.der;
  if (der === undefined || more.length)
    throw new Error(`run ${run.id} did not return exactly one certificate`);
  const certificate = Buffer.from(der, 'base64');
  openssl(['x509', '-inform', 'DER', '-noout'], certificate);
  const receipt = receiptOf(run.stdout);
  writeFileSync(certificateOut, certificate, { mode: PUBLIC_FILE, flag: 'wx' });
  const stored =
    privateKey && storeHost
      ? storeSigningIdentity(certificate, privateKey, storeHost)
      : null;
  return {
    status: 'issued',
    run: run.id,
    certificate: certificateOut,
    two_factor: receipt,
    stored,
  };
}

export async function runAppleDeveloperId(parsed: ParsedCli): Promise<void> {
  const keys = Object.keys(parsed.options).filter((key) => key !== 'json');
  const reading = keys.includes('run');
  const allowed = reading ? READ_OPTIONS : START_OPTIONS;
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (parsed.positional.length || unknown.length) {
    throw new UsageError(
      `certificate takes either ${START_OPTIONS.map((key) => `--${key}`).join(' ')} or ${READ_OPTIONS.map((key) => `--${key}`).join(' ')}; got ${[...parsed.positional, ...unknown.map((key) => `--${key}`)].join(' ')}`,
    );
  }
  if (!reading && parsed.options.provider !== PROVIDER) {
    throw new UsageError(
      `certificate needs --provider naming the certificate authority; Weles issues through ${PROVIDER}`,
    );
  }
  const row = reading ? await read(parsed) : await start(parsed);
  printAnswer(row, parsed.options.json === true);
  if (row.ok === false) process.exitCode = FAILURE_STATUS;
}
