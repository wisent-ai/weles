#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSkarbiecBinary } from '../../_shared/skarbiec-runtime.mjs';

const WIRE_VERSION = 'skarbiec.credential-operation.v3';
const ENTRA_PROVIDER = 'microsoft_entra';
const ENTRA_ORIGIN = 'https://login.microsoftonline.com';
const FLOW_NAME = 'microsoft-entra-password-lifecycle';
const MICROSOFT_PROVIDER = 'microsoft';
const MICROSOFT_ORIGIN = 'https://account.live.com';
const MICROSOFT_FLOW_NAME = 'microsoft-password-lifecycle';
const CREDENTIAL_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;
const LOWER_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const CODEX_LOGIN_ITEM = /^codex-[a-z0-9](?:[a-z0-9-]{0,100}[a-z0-9])?-google-sso$/;
const PHASES = Object.freeze([
  'admission',
  'placement',
  'credential_read',
  'entra_sign_in',
  'identity_verification',
  'password_change',
  'fresh_login_verification',
  'skarbiec_stage',
  'skarbiec_commit',
  'rollback',
]);
const ROLLBACK_STATUSES = Object.freeze(['none', 'completed', 'failed', 'unknown']);
const OPERATIONS = Object.freeze(['adopt', 'rotate', 'reset', 'verify']);
// The consumer Microsoft lifecycle has no reset: a consumer surface cannot take
// over an unknown current password without interactive recovery, which is what
// the directory-owned reset exists for.
const MICROSOFT_OPERATIONS = Object.freeze(['adopt', 'rotate', 'verify']);
const PROVIDER_EFFECTS = Object.freeze(['none', 'changed', 'unknown']);
const APPROVAL_ID = /^[A-Za-z\d._-]{1,64}$/;
const RESUME_TOKEN = /^[A-Za-z\d._-]{1,128}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const HEX_64 = /^[a-f\d]{64}$/i;
const ACTION_LOG_ID = /^[\da-f]{8}$/i;

const chunks = [];
let received = Number('0');
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > Number('65536')) throw new Error('credential request exceeded size limit');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
let request;
try {
  request = JSON.parse(bytes.toString('utf8'));
} finally {
  bytes.fill(Number('0'));
  for (const chunk of chunks) chunk.fill(Number('0'));
}
if (!request || typeof request !== 'object' || Array.isArray(request)) {
  throw new Error('invalid Entra credential lifecycle request');
}

const isCodexReauth = request.provider === 'codex' && request.operation === 'reauth';
if (isCodexReauth) {
  if (request.version !== WIRE_VERSION
      || !/^[a-f\d]{64}$/i.test(request.request_id ?? '')
      || !CODEX_LOGIN_ITEM.test(request.credential_id ?? '')
      || request.field !== 'password'
      || request.account_email !== null
      || request.directory !== null
      || request.mode !== 'submit') {
    throw new Error('invalid Codex subscription reauth request');
  }
  if (request.dry_run === true) {
    process.stdout.write(`${JSON.stringify({
      status: 'operation_plan',
      operation: 'reauth',
      provider: 'codex',
      provider_effect: 'none',
      message: `Weles would reauthenticate ${request.credential_id}`,
    })}\n`);
    process.exit(Number('0'));
  }
  // The worker's own launcher environment already holds this token. Reading it
  // there keeps one source of truth; a copy in a second file would be a second
  // credential to rotate and to get wrong.
  const apiToken = welesApiToken();
  // A real browser sign-in answers in minutes, and fetch's undici default kills
  // a request whose headers have not arrived in 300 seconds. This waits on the
  // socket instead, so a slow but healthy run is not reported as a failure.
  const answer = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      provider: 'codex',
      login_item: request.credential_id,
      timeout_ms: Number('900000'),
    });
    const call = httpRequest(
      {
        host: '127.0.0.1',
        port: Number('8788'),
        path: '/reauth',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const parts = [];
        response.on('data', (part) => parts.push(part));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
          } catch (error) {
            reject(new Error(`Weles answered unparseable JSON: ${error.message}`));
          }
        });
      },
    );
    call.setTimeout(Number('1200000'), () => {
      call.destroy(new Error('Weles Codex reauth exceeded 1200s'));
    });
    call.on('error', reject);
    call.end(payload);
  });
  if (answer.status !== Number('200') || answer.body?.ok !== true
      || answer.body?.login_item !== request.credential_id) {
    throw new Error(
      `Weles Codex reauth failed: HTTP ${answer.status} `
      + sanitizedText(
        [answer.body?.error, answer.body?.stderr_tail, answer.body?.stdout_tail]
          .filter(Boolean)
          .join(' | ') || 'unknown failure',
        Number('1200'),
      ),
    );
  }
  process.stdout.write(`${JSON.stringify({
    status: 'operation_completed',
    operation: 'reauth',
    provider: 'codex',
    provider_effect: 'none',
    rollback_status: 'none',
    execution_host: homedir(),
    message: `Weles reauthenticated ${request.credential_id}; Skarbiec verified the named subscription on status`,
  })}\n`);
  process.exit(Number('0'));
}

const isFigmaAcquire = request.provider === 'figma' && request.operation === 'acquire';
if (isFigmaAcquire) {
  if (request.version !== WIRE_VERSION
      || !/^[a-f\d]{64}$/i.test(request.request_id ?? '')
      || request.credential_id !== 'weles-figma-personal-access-token'
      || request.field !== 'api_key'
      || !EMAIL.test(request.account_email ?? '')
      || request.signup_origin !== 'https://www.figma.com'
      || request.mode !== 'submit'
      || request.dry_run !== false) {
    throw new Error('invalid Figma credential acquisition request');
  }
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const finalizer = join(
    runtimeRoot,
    'scripts',
    'operations',
    'finalize-figma-token-host.mjs',
  );
  const writer = join(
    runtimeRoot,
    'scripts',
    'worker',
    'deploy',
    'skarbiec-write.mjs',
  );
  const skarbiecUrl = process.env.WC_SKARBIEC_URL?.trim();
  if (!skarbiecUrl) {
    throw new Error('WC_SKARBIEC_URL must come from the Stado service directory');
  }
  const completed = spawnSync(process.execPath, [finalizer], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FIGMA_ACCOUNT_EMAIL: request.account_email.trim().toLowerCase(),
      WELES_CREDENTIAL_REQUEST_ID: request.request_id.toLowerCase(),
      WELES_USER_DATA_DIR: process.env.WELES_USER_DATA_DIR
        || join(homedir(), '.local/state/weles/browser-profiles/figma-token'),
      WC_SKARBIEC_URL: skarbiecUrl,
      SKARBIEC_WELES_WRITER_COMMAND: process.env.SKARBIEC_WELES_WRITER_COMMAND || writer,
    },
    maxBuffer: Number('1048576'),
    timeout: Number('900000'),
  });
  if (completed.error || completed.status !== Number('0')) {
    const reason = sanitizedText(completed.stderr, Number('240')) || 'unknown failure';
    throw new Error(`Weles Figma credential acquisition failed: ${reason}`);
  }
  const stored = String(completed.stdout).trim().split(/\r?\n/).at(-1);
  let receipt;
  try {
    receipt = JSON.parse(stored);
  } catch {
    throw new Error('Weles Figma credential acquisition returned no storage receipt');
  }
  if (receipt?.status !== 'stored') {
    throw new Error('Weles Figma credential acquisition did not store the credential');
  }
  process.stdout.write(`${JSON.stringify({
    status: 'operation_completed',
    operation: 'acquire',
    provider: 'figma',
    provider_effect: 'changed',
    rollback_status: 'none',
    execution_host: homedir(),
    vaultItemId: request.credential_id,
    message: `Weles acquired ${request.credential_id} and stored it in Skarbiec`,
  })}\n`);
  process.exit(Number('0'));
}
// The directory identity is the item's own contract, so the request carries the
// whole canonical block or none of it, and nothing outside it names the identity.
const directory = objectOrEmpty(request.directory);
const isEntra = request.provider === ENTRA_PROVIDER;
const isMicrosoft = request.provider === MICROSOFT_PROVIDER;
if (request.version !== WIRE_VERSION
    || !/^[a-f\d]{64}$/i.test(request.request_id ?? '')
    || !CREDENTIAL_ID.test(request.credential_id ?? '')
    || !OPERATIONS.includes(request.operation)
    || (!isEntra && !isMicrosoft)
    || request.field !== 'password'
    || (request.account_email !== null && request.account_email !== undefined
      && !EMAIL.test(request.account_email))
    || !['submit', 'status', 'resume'].includes(request.mode)) {
  throw new Error('invalid Microsoft credential lifecycle request');
}
if (isEntra
    && (directory.provider !== ENTRA_PROVIDER
      || !EMAIL.test(directory.account_upn ?? '')
      || !LOWER_UUID.test(directory.tenant_id ?? '')
      || !LOWER_UUID.test(directory.principal_object_id ?? ''))) {
  throw new Error('invalid Entra credential lifecycle request');
}
// A consumer Microsoft account is bound by its exact account email alone: it
// carries no directory block, because no directory holds its password.
if (isMicrosoft
    && (!MICROSOFT_OPERATIONS.includes(request.operation)
      || !EMAIL.test(request.account_email ?? '')
      || (request.directory !== null && request.directory !== undefined))) {
  throw new Error('invalid Microsoft credential lifecycle request');
}

const requestId = request.request_id.toLowerCase();
const accountUpn = typeof directory.account_upn === 'string'
  ? directory.account_upn.trim().toLowerCase()
  : '';
const tenantId = typeof directory.tenant_id === 'string'
  ? directory.tenant_id.trim().toLowerCase()
  : '';
const principalObjectId = typeof directory.principal_object_id === 'string'
  ? directory.principal_object_id.trim().toLowerCase()
  : '';
const accountEmail = typeof request.account_email === 'string'
  ? request.account_email.trim().toLowerCase()
  : '';


function safeOwnedFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (metadata.mode & Number.parseInt('077', Number('8'))) !== Number('0')) {
    throw new Error(`unsafe ${label}`);
  }
}

// The worker API bearer, read from the launcher's own owner-only environment
// files in the order the launcher sources them: the later file wins, exactly as
// the shell wrapper resolves it. Nothing is copied to a second location.
function welesApiToken() {
  const candidates = process.env.WELES_WORKER_ENV_FILES
    ? process.env.WELES_WORKER_ENV_FILES.split(':').filter(Boolean)
    : [
      `${homedir()}/weles/var/worker-content.env`,
      `${homedir()}/.config/weles/worker.env`,
      `${homedir()}/.weles/secrets.env`,
      `${homedir()}/.stado/weles-model.env`,
    ];
  let token = process.env.WELES_API_TOKEN?.trim() ?? '';
  for (const path of candidates) {
    let body;
    try {
      safeOwnedFile(path, 'Weles worker environment file');
      body = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('WELES_API_TOKEN=')) continue;
      token = line.slice('WELES_API_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  if (!token || /[\r\n]/.test(token)) {
    throw new Error('the Weles worker environment holds no usable WELES_API_TOKEN');
  }
  return token;
}

function sanitizedText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARACTERS, ' ').trim().slice(Number('0'), limit);
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// An approval is a lease, so it is all six fields or nothing: a partial object
// has no resumable identity and is dropped instead of forwarded.
function approvalResource(source) {
  const approval = objectOrEmpty(source.approval);
  const approvalId = sanitizedText(approval.approval_id, Number('64'));
  const providerEffect = sanitizedText(approval.provider_effect, Number('16'));
  const expiresAt = sanitizedText(approval.expires_at, Number('64'));
  const resumeToken = sanitizedText(approval.resume_token, Number('128'));
  const instruction = sanitizedText(approval.instruction, Number('512'));
  if (!APPROVAL_ID.test(approvalId)
      || !PHASES.includes(approval.phase)
      || !PROVIDER_EFFECTS.includes(providerEffect)
      || !ISO_TIMESTAMP.test(expiresAt)
      || !RESUME_TOKEN.test(resumeToken)
      || !instruction) {
    return null;
  }
  return {
    approval_id: approvalId,
    phase: approval.phase,
    provider_effect: providerEffect,
    expires_at: expiresAt,
    resume_token: resumeToken,
    instruction,
  };
}

// The receipt answers 'was exactly this principal rotated', so one naming
// another identity, request, or operation is a protocol violation rather than a
// droppable field. It never carries the password or anything derived from it.
function receiptResource(source) {
  const receipt = objectOrEmpty(source.receipt);
  if (!Object.keys(receipt).length) return null;
  const reportedTenant = sanitizedText(receipt.tenant_id, Number('64')).toLowerCase();
  const reportedPrincipal = sanitizedText(receipt.principal_object_id, Number('64')).toLowerCase();
  const reportedUpn = sanitizedText(receipt.account_upn, Number('320')).toLowerCase();
  const reportedRequest = sanitizedText(receipt.request_id, Number('64')).toLowerCase();
  if (reportedTenant !== tenantId
      || reportedPrincipal !== principalObjectId
      || reportedUpn !== accountUpn
      || reportedRequest !== requestId
      || receipt.operation !== request.operation) {
    throw new Error('Weles reported a credential receipt for a different Entra identity, request, or operation');
  }
  const digest = sanitizedText(receipt.evidence_digest, Number('64')).toLowerCase();
  const executionHost = sanitizedText(receipt.execution_host, Number('128'));
  const verifiedAt = sanitizedText(receipt.verified_at, Number('64'));
  const changedAt = receipt.changed_at === null ? null : sanitizedText(receipt.changed_at, Number('64'));
  const actionLogId = sanitizedText(receipt.action_log_id, Number('64'));
  if (!HEX_64.test(digest)
      || !executionHost
      || !ISO_TIMESTAMP.test(verifiedAt)
      || (changedAt !== null && !ISO_TIMESTAMP.test(changedAt))
      || !ACTION_LOG_ID.test(actionLogId)) {
    return null;
  }
  return {
    tenant_id: reportedTenant,
    principal_object_id: reportedPrincipal,
    account_upn: reportedUpn,
    operation: request.operation,
    request_id: reportedRequest,
    evidence_digest: digest,
    execution_host: executionHost,
    changed_at: changedAt,
    verified_at: verifiedAt,
    action_log_id: actionLogId,
  };
}

// The worker lifts the trajectory evidence file into result.service_action and
// the human-approval file into result.pending_review, so the typed diagnostics
// live in exactly those two places. Anything outside the contract vocabulary is
// dropped rather than forwarded.
function diagnostics(result) {
  const root = objectOrEmpty(result);
  const operationResult = objectOrEmpty(objectOrEmpty(root.service_action).credential_operation);
  const source = Object.keys(operationResult).length ? operationResult : objectOrEmpty(root.pending_review);
  const code = sanitizedText(source.code, Number('64'));
  const executionHost = sanitizedText(source.executionHost, Number('128'));
  const message = sanitizedText(source.message ?? source.reason, Number('512'));
  const providerEffect = sanitizedText(source.providerEffect, Number('16'));
  const reportedTenant = sanitizedText(source.tenantId, Number('64')).toLowerCase();
  const reportedPrincipal = sanitizedText(source.principalObjectId, Number('64')).toLowerCase();
  if ((reportedTenant && reportedTenant !== tenantId)
      || (reportedPrincipal && reportedPrincipal !== principalObjectId)) {
    throw new Error('Weles reported a different Entra identity than the credential request');
  }
  const approval = approvalResource(source);
  const receipt = receiptResource(source);
  return {
    ...(DIAGNOSTIC_CODE.test(code) ? { code } : {}),
    ...(PHASES.includes(source.phase) ? { phase: source.phase } : {}),
    ...(typeof source.retryable === 'boolean' ? { retryable: source.retryable } : {}),
    ...(PROVIDER_EFFECTS.includes(providerEffect) ? { providerEffect } : {}),
    ...(ROLLBACK_STATUSES.includes(source.rollbackStatus)
      ? { rollbackStatus: source.rollbackStatus }
      : {}),
    ...(approval ? { approval } : {}),
    ...(receipt ? { receipt } : {}),
    ...(executionHost ? { executionHost } : {}),
    ...(message ? { message } : {}),
  };
}

let output;
// A resume queues the operation afresh: the human finished the interactive
// step out of band, so the trajectory reruns against the staged candidate and
// settles the same request it started.
if (request.mode === 'submit' || request.mode === 'resume') {
  const writerTokenFile = process.env.WELES_MICROSOFT_WRITER_TOKEN_FILE ?? '';
  const scopeFile = process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE ?? '';
  safeOwnedFile(writerTokenFile, 'Microsoft writer token file');
  safeOwnedFile(scopeFile, 'Microsoft acquisition scope catalog');
  const expectedScope = `${request.credential_id}-reader-password|${request.credential_id}|password`;
  const scopes = readFileSync(scopeFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!scopes.includes(expectedScope)) {
    throw new Error(`missing exact ${isEntra ? 'Entra' : 'Microsoft'} credential reader scope`);
  }

  const skarbiec = activeSkarbiecBinary();
  const accountRead = spawnSync(skarbiec, ['get', request.credential_id], {
    encoding: 'utf8',
    env: process.env,
  });
  if (accountRead.error || accountRead.status !== 0) throw new Error('managed Microsoft credential is absent from Skarbiec');
  const accountDocument = JSON.parse(accountRead.stdout);
  const storedEmail = String(accountDocument.fields?.username ?? '').trim().toLowerCase();
  if ((isMicrosoft && storedEmail !== accountEmail)
      || (isEntra && storedEmail !== accountUpn && storedEmail !== accountEmail)) {
    throw new Error(`Skarbiec credential is not bound to the requested ${isEntra ? 'Entra' : 'Microsoft'} identity`);
  }
  // No account item id is derived from the stored email any more. This line used
  // to build `weles-microsoft-<slugged email>-account` and send it as the
  // payload's accountItem; a Skarbiec item id is a mutable, human-chosen name,
  // so a rename of the real account item silently produced an id belonging to
  // nothing -- or, worse, to some other item that happened to take the name.
  // Nothing needed it: `stado-action-runner.mjs` forwards accountItem only as
  // `params.login_item`, and `paramsToEnv` honours `login_item` for the
  // claude/codex/kimi login and reauth trajectories alone, so the Microsoft and
  // Entra password-lifecycle flows never saw it. What they do read is
  // `constraints.secret` -- `request.credential_id`, the exact literal id the
  // caller named, already verified above against the identity the item itself
  // declares in `fields.username`. A rename of that item fails loudly on the
  // `skarbiec get` above.
  const constraints = isEntra
    ? {
        secret: request.credential_id,
        operation: request.operation,
        request_id: request.request_id,
        purpose: request.purpose,
        account_email: accountEmail || undefined,
        // The directory identity is the item's own write-once contract and the only
        // source the trajectory reads it from. The Entra directory id is not a Weles
        // Skarbiec binding tenant, so the scoped reader and writer stay untenanted.
        directory: {
          provider: ENTRA_PROVIDER,
          tenant_id: tenantId,
          principal_object_id: principalObjectId,
          account_upn: accountUpn,
        },
        weles_tenant_id: null,
        store_secret_target: 'skarbiec',
        vault_item_id: request.credential_id,
        vault_field: 'password',
        secret_source_origin: ENTRA_ORIGIN,
        display_name: 'Microsoft Entra account password',
        provider: ENTRA_PROVIDER,
        capabilities: ['password_adoption', 'password_rotation', 'password_reset', 'fresh_login_verification'],
      }
    : {
        secret: request.credential_id,
        operation: request.operation,
        request_id: request.request_id,
        purpose: request.purpose,
        // The consumer account email is the whole account binding; there is no
        // directory block because no directory holds this password.
        account_email: accountEmail,
        tenant_id: null,
        store_secret_target: 'skarbiec',
        vault_item_id: request.credential_id,
        vault_field: 'password',
        secret_source_origin: MICROSOFT_ORIGIN,
        display_name: 'Microsoft account password',
        provider: MICROSOFT_PROVIDER,
        capabilities: ['password_adoption', 'password_rotation', 'fresh_login_verification'],
      };
  const action = isMicrosoft
    ? request.operation === 'adopt'
      ? 'microsoft_adopt_password'
      : request.operation === 'verify'
        ? 'microsoft_verify_password'
        : 'microsoft_reset_password'
    : request.operation === 'verify'
      ? 'microsoft_entra_verify_password'
      : request.operation === 'adopt'
        ? 'microsoft_entra_adopt_password'
        : 'microsoft_entra_reset_password';
  const payload = Buffer.from(JSON.stringify({ action, params: {
    url: isEntra ? ENTRA_ORIGIN : MICROSOFT_ORIGIN,
    objective: request.operation === 'adopt'
      ? isEntra
        ? 'adopt the exact Microsoft Entra directory password already staged in Skarbiec: prove it with a fresh sign-in and the full tenant, principal object id, and UPN assertion, and never change it in the directory.'
        : 'adopt the exact Microsoft account password already staged in Skarbiec: prove it with a fresh sign-in and never change it at the provider.'
      : isEntra
        ? `${request.operation} the exact Microsoft Entra directory password and commit it only after the signed-in tenant, principal object id, and UPN are confirmed by a fresh login.`
        : `${request.operation} the exact Microsoft account password and commit it only after a fresh login with the resulting password succeeds.`,
    flow_name: isEntra ? FLOW_NAME : MICROSOFT_FLOW_NAME,
    execution_mode: 'keeper_first',
    proxy: 'none',
    headless: false,
    auto_promote_trajectory: true,
    constraints,
  } }), 'utf8').toString('base64url');
  const runner = join(homedir(), 'weles', 'scripts', 'worker', 'stado-action-runner.mjs');
  const stado = process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
  const queued = spawnSync(stado, ['submit', `${process.execPath} ${runner} ${payload}`, '--priority', '1000'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (queued.error || queued.status !== 0) throw new Error(`Stado refused Microsoft credential operation: ${(queued.stderr || '').trim()}`);
  const actionLogId = String(queued.stdout).match(/\b[0-9a-f]{8}\b/i)?.[0];
  if (!actionLogId) throw new Error('Stado returned an invalid action id');
  output = {
    status: 'operation_queued',
    operation: request.operation,
    provider: request.provider,
    actionLogId,
    vaultItemId: request.credential_id,
    flowName: isEntra ? FLOW_NAME : MICROSOFT_FLOW_NAME,
    ...(isEntra ? { tenantId, principalObjectId } : {}),
    message: `${isEntra ? 'Entra' : 'Microsoft'} password ${request.operation} queued`,
  };
} else {
  if (!ACTION_LOG_ID.test(request.action_log_id ?? '')) {
    throw new Error('status mode requires one exact Stado job id');
  }
  const stado = process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
  const statusResult = spawnSync(stado, ['status', request.action_log_id], {
    encoding: 'utf8',
    env: process.env,
  });
  if (statusResult.error || statusResult.status !== 0) throw new Error('Stado job status is unavailable');
  const text = String(statusResult.stdout);
  const status = /\b(completed|uploaded)\b/i.test(text)
    ? 'operation_completed'
    : /\b(failed|cancelled)\b/i.test(text)
      ? 'operation_failed'
      : 'operation_queued';
  output = {
    status,
    operation: request.operation,
    provider: request.provider,
    actionLogId: request.action_log_id,
    vaultItemId: request.credential_id,
    flowName: isEntra ? FLOW_NAME : MICROSOFT_FLOW_NAME,
    ...(isEntra ? { tenantId, principalObjectId } : {}),
    message: `Weles credential operation is ${status.replace('operation_', '')}`,
  };
}
process.stdout.write(`${JSON.stringify(output)}\n`);
