// Microsoft Entra ID (work/school directory) password lifecycle.
//
// Entra sibling of password_lifecycle.mjs. Consumer Microsoft-account surfaces do
// not administer directory identities, so every surface used here is Entra-owned:
//   sign-in              https://login.microsoftonline.com
//   authorized context   https://myaccount.microsoft.com
//   password change      https://account.activedirectory.windowsazure.com/ChangePassword.aspx
//   self-service reset   https://passwordreset.microsoftonline.com
//
// Identity is never inferred from the credential id, the queued account row, or
// page copy. The trajectory reads the tokens that the first-party My Account SPA
// mints for the signed-in session (MSAL cache plus the Authorization headers the
// SPA sends) and requires the documented Entra claims tid, oid and
// preferred_username/upn to equal the queued contract before any password write
// and again after the fresh login that precedes the Skarbiec commit. Absent,
// conflicting or unreadable claims fail closed; no password is ever written to a
// log, a result payload, or a recording.
//
// adopt, rotate and reset are deliberately separate: adopt proves a password the
// operator already knows and never writes to the directory, rotate demands the
// known managed password (so a compensating rollback exists), and reset accepts
// an unknown current password but hands every interactive identity verification
// to a human instead of pretending to satisfy it.
//
// Every terminal answer states one three-valued provider effect: 'none' when the
// directory password was left untouched, 'changed' when the directory accepted a
// new value, and 'unknown' when this run cannot prove which value the directory
// now holds. Only 'none' may be retried automatically; 'unknown' quarantines the
// item. A successful run also carries a receipt naming the exact principal that
// was proven, digesting the session evidence without any password material.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { updateAccount } from '../../../dist/state/skarbiec-records.js';
import {
  readWelesManagedCredential,
  writeWelesAcquiredSecret,
} from '../../../dist/secrets/scoped-service.js';
import { WSession } from '../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';

const ENTRA_PASSWORD_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;
const ENTRA_PROVIDER = 'microsoft_entra';
const PASSWORD_FIELD = 'password';
const SIGN_IN_ORIGIN = 'https://login.microsoftonline.com';
const AUTHORIZED_CONTEXT_URL = 'https://myaccount.microsoft.com/';
const AUTHORIZED_CONTEXT_HOST = /(^|\.)myaccount\.microsoft\.com$/;
const AUTHORIZED_CONTEXT_URL_PATTERN = /^https:\/\/myaccount\.microsoft\.com\//;
const CHANGE_PASSWORD_URL = 'https://account.activedirectory.windowsazure.com/ChangePassword.aspx';
const SELF_SERVICE_RESET_URL = 'https://passwordreset.microsoftonline.com/';
const SIGN_IN_HOSTS = Object.freeze(['login.microsoftonline.com', 'login.microsoft.com']);
const OPERATIONS = Object.freeze(['adopt', 'rotate', 'reset', 'verify']);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOWER_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const ANY_UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;
const JWT_SCAN = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g;
const IDENTITY_CHALLENGE = /verify your identity|get a code|approve (?:a )?sign.?in|enter.{0,20}code|passkey|security key|authenticator app|text my mobile|call my (?:mobile|office)|verification (?:step|method)/i;
const PASSWORD_REJECTED = /your account or password is incorrect|password is incorrect|wrong password|password is invalid/i;
const USERNAME_UNKNOWN = /isn.t in our system|couldn.t find your account|try entering your details again/i;
const CHANGE_CONFIRMED = /password (?:has been |was )?(?:changed|updated)|password change (?:was )?successful|you (?:have )?(?:successfully )?changed your password/i;
const CHANGE_REJECTED = /(?:current|old) password (?:is )?(?:incorrect|wrong)|(?:doesn.t|does not) meet|couldn.t (?:be )?chang|password (?:is )?(?:incorrect|invalid)|try again/i;
const RESET_VERIFICATION = /verification step|email my alternate email|text my mobile phone|call my (?:mobile|office) phone|approve a notification|enter a code from my authenticator|enter the characters (?:in|you see)|security check/i;
const RESET_NOT_ELIGIBLE = /we couldn.t verify (?:the |your )?account|account (?:was )?not found|contact your administrator|self-service password reset (?:is )?(?:not|isn.t) (?:enabled|available)/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const MESSAGE_LIMIT = Number('512');
const HOST_LIMIT = Number('128');
const PROVIDER_EFFECTS = Object.freeze(['none', 'changed', 'unknown']);
const ACTION_LOG_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
// A human approval holds the lease. Four hours is long enough for a person to
// answer and short enough that an unanswered approval releases on its own.
const APPROVAL_TTL_MS = Number('14400000');
const RESUME_TOKEN_BYTES = Number('48');

// The queued row carries two unrelated tenants. The directory block is the
// item's own write-once identity contract (the Entra directory the principal
// lives in, asserted against token claims), while constraints.weles_tenant_id is
// the Weles/Skarbiec binding tenant used to resolve the scoped reader and
// writer. Never cross them, and never take the identity from anywhere but the
// directory block: a missing or partial block is a refusal, not a default.
function constraints(allowedOperations) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  } catch {
    throw new Error('invalid Weles credential constraints');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid Weles credential constraints');
  }
  const directory = parsed.directory;
  if (!directory || typeof directory !== 'object' || Array.isArray(directory)) {
    throw new Error('Entra password operation carries no directory identity contract');
  }
  const credentialId = typeof parsed.secret === 'string' ? parsed.secret : '';
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : '';
  const operation = typeof parsed.operation === 'string' ? parsed.operation : '';
  const accountEmail = typeof parsed.account_email === 'string' ? parsed.account_email.trim().toLowerCase() : '';
  const accountUpn = typeof directory.account_upn === 'string' ? directory.account_upn.trim().toLowerCase() : '';
  const tenantId = typeof directory.tenant_id === 'string' ? directory.tenant_id.trim().toLowerCase() : '';
  const principalObjectId = typeof directory.principal_object_id === 'string'
    ? directory.principal_object_id.trim().toLowerCase()
    : '';
  const skarbiecTenantId = typeof parsed.weles_tenant_id === 'string' ? parsed.weles_tenant_id : null;
  const actionLogId = process.env.ACTION_LOG_ID ?? '';
  const expectedOperation = process.env.WELES_CREDENTIAL_EXPECTED_OPERATION ?? '';
  if (!ENTRA_PASSWORD_ID.test(credentialId)
      || parsed.provider !== ENTRA_PROVIDER
      || directory.provider !== ENTRA_PROVIDER
      || parsed.vault_item_id !== credentialId
      || parsed.vault_field !== PASSWORD_FIELD
      || !/^[\da-f]{64}$/i.test(requestId)
      || !ACTION_LOG_ID.test(actionLogId)
      || !OPERATIONS.includes(operation)
      || !allowedOperations.includes(operation)
      || (expectedOperation && expectedOperation !== operation)
      || !EMAIL.test(accountUpn)
      || (accountEmail && !EMAIL.test(accountEmail))
      || !LOWER_UUID.test(tenantId)
      || parsed.secret_source_origin !== SIGN_IN_ORIGIN
      || !LOWER_UUID.test(principalObjectId)) {
    throw new Error('Entra password operation is outside its exact Skarbiec contract');
  }
  return {
    credentialId,
    operation,
    accountUpn,
    accountEmail,
    tenantId,
    principalObjectId,
    skarbiecTenantId,
    requestId,
    actionLogId,
  };
}

function accountMatchesContract(account, contract) {
  const metadata = account?.metadata ?? {};
  const upn = String(metadata.entra_upn ?? '').trim().toLowerCase();
  const email = String(metadata.email ?? account?.username ?? '').trim().toLowerCase();
  const emailMatches = email === contract.accountUpn
    || (Boolean(contract.accountEmail) && email === contract.accountEmail);
  return upn === contract.accountUpn
    && emailMatches
    && String(metadata.entra_tenant_id ?? '').trim().toLowerCase() === contract.tenantId
    && String(metadata.entra_principal_object_id ?? '').trim().toLowerCase() === contract.principalObjectId
    && metadata.skarbiec_credential_id === contract.credentialId
    && (metadata.skarbiec_tenant_id ?? null) === (contract.skarbiecTenantId ?? null);
}

function generatedPassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!#$%&()*+,-.:;<=>?@[]^_{|}~',
  ];
  const all = groups.join('');
  const chars = groups.map((group) => group[randomInt(group.length)]);
  while (chars.length < Number('32')) chars.push(all[randomInt(all.length)]);
  for (let index = chars.length - Number('1'); index > Number('0'); index -= Number('1')) {
    const target = randomInt(index + Number('1'));
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join('');
}

function sanitizedMessage(reason) {
  return String(reason).replace(CONTROL_CHARACTERS, ' ').trim().slice(''.length, MESSAGE_LIMIT);
}

// The digest covers the ordered phase verdicts of this run together with the
// identity the run was bound to. No password and no value derived from one is
// ever part of it, so the digest is safe to publish in the receipt.
function evidenceDigest(contract, evidence) {
  const canonical = JSON.stringify({
    account_upn: contract.accountUpn,
    action_log_id: contract.actionLogId,
    evidence,
    operation: contract.operation,
    principal_object_id: contract.principalObjectId,
    request_id: contract.requestId,
    tenant_id: contract.tenantId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function executionHost() {
  return hostname().slice(''.length, HOST_LIMIT);
}

// An approval is a resource, not a hint: the id is stable for the exact run and
// phase that asked for it, the lease expires on its own, and the resume token is
// the only way back into this operation.
function approvalResource(contract, phase, providerEffect, instruction) {
  return {
    approval_id: createHash('sha256').update(`${contract.actionLogId}|${phase}`, 'utf8').digest('hex'),
    phase,
    provider_effect: providerEffect,
    expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    resume_token: randomBytes(RESUME_TOKEN_BYTES).toString('base64url'),
    instruction,
  };
}

// The receipt answers 'was exactly this principal rotated' without reading a
// mailbox or a log, so it names the directory coordinates and digests the
// evidence instead of carrying anything derived from the password.
function receiptResource(contract, fields) {
  if (!Array.isArray(fields.evidence) || !fields.evidence.length) {
    throw new Error('a credential receipt requires the session evidence of this run');
  }
  return {
    tenant_id: contract.tenantId,
    principal_object_id: contract.principalObjectId,
    account_upn: contract.accountUpn,
    operation: contract.operation,
    request_id: contract.requestId,
    evidence_digest: evidenceDigest(contract, fields.evidence),
    execution_host: executionHost(),
    changed_at: fields.changedAt ?? null,
    verified_at: new Date().toISOString(),
    action_log_id: contract.actionLogId,
  };
}

// One shape for every terminal answer. The worker lifts service_action_result.json
// into result.service_action and pending_review.json into result.pending_review,
// which is where weles-skarbiec-local.mjs reads the typed diagnostics from. The
// envelope stays camelCase; the nested approval and receipt blocks are canonical
// snake_case.
function outcome(contract, fields) {
  const message = sanitizedMessage(fields.reason);
  if (!PROVIDER_EFFECTS.includes(fields.providerEffect)) {
    throw new Error('an Entra credential outcome requires one exact provider effect');
  }
  const phase = fields.phase ?? '';
  if (fields.status === 'needs_human_approval' && (!phase || !message)) {
    throw new Error('an approval resource requires the exact phase and instruction that asked for it');
  }
  const answer = {
    status: fields.status,
    ...(fields.code ? { code: fields.code } : {}),
    ...(phase ? { phase } : {}),
    // Only an untouched provider may be retried automatically: 'changed' needs an
    // explicit verify or a confirmed rollback first, and 'unknown' quarantines the
    // item until a human resolves it.
    retryable: fields.providerEffect === 'none' && fields.retryable === true,
    providerEffect: fields.providerEffect,
    ...(fields.rollbackStatus ? { rollbackStatus: fields.rollbackStatus } : {}),
    executionHost: executionHost(),
    tenantId: contract.tenantId,
    principalObjectId: contract.principalObjectId,
    ...(fields.status === 'needs_human_approval'
      ? { approval: approvalResource(contract, phase, fields.providerEffect, message) }
      : {}),
    ...(fields.status === 'operation_completed'
      ? { receipt: receiptResource(contract, fields) }
      : {}),
    message,
  };
  const directory = runRecordingsDir();
  writeFileSync(
    join(directory, 'service_action_result.json'),
    JSON.stringify({ credential_operation: answer }, null, Number('2')),
  );
  if (answer.status === 'needs_human_approval') {
    writeFileSync(
      join(directory, 'pending_review.json'),
      JSON.stringify({ ...answer, reason: message }, null, Number('2')),
    );
  }
  return answer;
}

async function visible(locator) {
  const count = await locator.count().catch(() => Number('0'));
  return count > Number('0') && locator.first().isVisible().catch(() => false);
}

async function fill(page, locator, value) {
  await locator.waitFor({ state: 'visible', timeout: Number('30000') });
  await humanClickLocator(page, locator);
  await locator.fill('');
  await humanType(page, value);
}

// The converged control re-renders during hydration and can silently drop
// keystrokes of a human-typed value — sometimes after an immediate readback
// already looked right — so every fill settles, reads back, and retries
// before the form moves on.
async function fillVerified(page, locator, value) {
  for (let attempt = Number('0'); attempt < Number('3'); attempt += Number('1')) {
    await fill(page, locator, value);
    await page.waitForTimeout(Number('800'));
    const typed = await locator.inputValue().catch(() => '');
    if (typed === value) return;
  }
}

async function hasIdentityChallenge(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return IDENTITY_CHALLENGE.test(body);
}

// Walks the converged sign-in surfaces until the password credential is
// chosen. The passkey-first page cancels into an error surface whose
// "Other ways to sign in" carries the password tile; the bare "Sign-in
// options" chooser (passkey + organization) does not, so it is backed out of
// and the email is resubmitted for another pass at the error surface.
async function choosePasswordSignIn(page) {
  for (let attempt = Number('0'); attempt < Number('4'); attempt += Number('1')) {
    const passwordInput = page.locator('input[name="passwd"], input#i0118, input[type="password"]').first();
    if (await visible(passwordInput)) return;
    const passwordChoice = page.getByText(/^Use (?:your )?password$/i).first();
    if (await visible(passwordChoice)) {
      await passwordChoice.click();
      await page.waitForTimeout(Number('1000'));
      return;
    }
    const passkeyFailed = page.getByText(/couldn.t sign you in with your passkey|something went wrong/i).first();
    const passkeyPage = page.getByText(/Face, fingerprint, PIN or security key|device will open a security window/i).first();
    const bareChooser = page.getByText(/Sign in to an organization/i).first();
    const emailInput = page.locator('input[name="loginfmt"], input#i0116, input[type="email"]').first();
    if (await visible(passkeyFailed)) {
      const otherWays = page.getByText(/Other ways to sign in|Use another way/i).first();
      if (await visible(otherWays)) {
        await otherWays.click();
        await page.waitForTimeout(Number('1000'));
        continue;
      }
    }
    if (await visible(passkeyPage)) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(Number('2500'));
      continue;
    }
    if (await visible(bareChooser)) {
      const back = page.locator('#idBtn_Back, button[aria-label="Back"]').first();
      if (!await visible(back)) return;
      await back.click();
      await page.waitForTimeout(Number('1000'));
      continue;
    }
    if (await visible(emailInput)) {
      const next = page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first();
      if (!await visible(next)) return;
      await next.click();
      await page.waitForTimeout(Number('2500'));
      continue;
    }
    const otherWays = page.getByText(/Other ways to sign in|Use another way/i).first();
    if (!await visible(otherWays)) return;
    await otherWays.click();
    await page.waitForTimeout(Number('1000'));
  }
}

async function dismissStaySignedIn(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  if (!/stay signed in/i.test(body)) return;
  const decline = page.getByRole('button', { name: /^No$/i }).first();
  if (await visible(decline)) {
    await humanClickLocator(page, decline);
    await humanIdlePause('long');
  }
}

function decodedTokenClaims(token) {
  const segments = token.split('.');
  if (segments.length !== Number('3')) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[Number('1')], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function claimedIdentities(values) {
  const identities = [];
  for (const value of values) {
    for (const [token] of String(value).matchAll(JWT_SCAN)) {
      const claims = decodedTokenClaims(token);
      if (!claims) continue;
      const tid = typeof claims.tid === 'string' ? claims.tid.trim().toLowerCase() : '';
      const oid = typeof claims.oid === 'string' ? claims.oid.trim().toLowerCase() : '';
      if (!LOWER_UUID.test(tid) || !LOWER_UUID.test(oid)) continue;
      const named = [claims.preferred_username, claims.upn, claims.unique_name]
        .find((candidate) => typeof candidate === 'string' && EMAIL.test(candidate.trim()));
      // idp is present only when the signing identity provider differs from the
      // resource tenant, which is exactly the guest case this trajectory must
      // refuse: a federated principal carries the resource tenant in tid and its
      // guest object id in oid, so tid and oid alone cannot tell it apart from a
      // directory-managed member.
      const idp = typeof claims.idp === 'string' ? claims.idp.trim().toLowerCase() : '';
      identities.push({ tid, oid, upn: named ? named.trim().toLowerCase() : '', idp });
    }
  }
  return identities;
}

// Second claim source: the bearer tokens the authorized first-party SPA attaches
// to its own API calls. Tokens stay in memory, are only ever base64-decoded for
// their claim set, and are dropped by clearBearerTokens once asserted.
function trackBearerTokens(page, sink) {
  page.on('request', (request) => {
    const header = request.headers().authorization ?? '';
    if (!/^Bearer\s+eyJ/i.test(header)) return;
    if (sink.length >= Number('64')) return;
    sink.push(header.replace(/^Bearer\s+/i, ''));
  });
}

function clearBearerTokens(sink) {
  sink.splice(''.length, sink.length);
}

async function authorizedClaims(page, sink) {
  const stored = await page.evaluate(() => {
    const values = [];
    for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
      if (!store) continue;
      for (let index = ''.length; index < store.length; index += 'x'.length) {
        const key = store.key(index);
        const value = key === null ? null : store.getItem(key);
        if (typeof value === 'string') values.push(value);
      }
    }
    return values;
  }).catch(() => []);
  return claimedIdentities([...stored, ...sink]);
}

// Hard gate. Every password write and every Skarbiec commit sits behind this.
async function assertEntraIdentity(session, contract, sink) {
  const page = session.page;
  if (!AUTHORIZED_CONTEXT_HOST.test(new URL(page.url()).hostname)) {
    await page.goto(AUTHORIZED_CONTEXT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await humanIdlePause('deliberate');
  }
  let identities = [];
  const deadline = Date.now() + Number('60000');
  while (Date.now() < deadline) {
    identities = await authorizedClaims(page, sink);
    if (identities.length) break;
    await page.waitForTimeout(Number('2000'));
  }
  clearBearerTokens(sink);
  if (!identities.length) {
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_UNVERIFIED',
      retryable: true,
      reason: 'the authorized Entra session exposed no readable tid and oid claims',
    };
  }
  const directoryMatches = identities.every((identity) => identity.tid === contract.tenantId
    && identity.oid === contract.principalObjectId);
  const conflictingUpn = identities.some((identity) => identity.upn && identity.upn !== contract.accountUpn);
  const confirmedUpn = identities.some((identity) => identity.upn === contract.accountUpn);
  if (!directoryMatches || conflictingUpn || !confirmedUpn) {
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_MISMATCH',
      retryable: false,
      reason: 'the signed-in Entra identity does not match the queued tenant, principal object id, and UPN',
    };
  }
  // A guest federated from another identity provider -- in practice a personal
  // Microsoft account homed in the consumer tenant 9188040d-6c67-4c5b-b112-36a304b66dad
  // -- satisfies tid, oid and UPN while its password lives outside this
  // directory. Entra's ChangePassword surface does not administer it, so the run
  // would reach the write, fail to prove what the directory holds, and quarantine
  // a credential. Refuse before any write, and name the surface that does own it.
  const federated = identities.find((identity) => identity.idp);
  if (federated) {
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_NOT_DIRECTORY_MANAGED',
      retryable: false,
      reason: `the signed-in principal is a guest federated from ${federated.idp}, whose password this directory does not hold; a consumer Microsoft account is rotated through the microsoft_reset_password lifecycle, not the Entra one`,
    };
  }
  return { ok: true };
}

// 'authenticated' | 'rejected' | 'identity_challenge' | 'unavailable'
async function signIn(session, contract, password) {
  const page = session.page;
  // Drop the token cache of a previous authorized context so the claims asserted
  // after this login are evidence of this login, never of the earlier one.
  if (AUTHORIZED_CONTEXT_HOST.test(new URL(page.url()).hostname)) {
    await page.evaluate(() => {
      globalThis.localStorage?.clear();
      globalThis.sessionStorage?.clear();
    }).catch(() => {});
  }
  await session.ctx.clearCookies();
  await page.goto(AUTHORIZED_CONTEXT_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const emailInput = page.locator('input[name="loginfmt"], input#i0116, input[type="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: Number('45000') }).catch(() => {});
  if (!await visible(emailInput)) return 'unavailable';
  // A truncated username submit lands on the "isn't in our system" surface,
  // which still renders a (hidden) password input; detect it and resubmit the
  // full UPN instead of letting the password stage type into that page.
  for (let attempt = Number('0'); attempt < Number('3'); attempt += Number('1')) {
    await fillVerified(page, emailInput, contract.accountUpn);
    await humanClickLocator(page, page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first());
    await humanIdlePause('deliberate');
    const body = await page.locator('body').innerText().catch(() => '');
    if (!USERNAME_UNKNOWN.test(body)) break;
  }
  await choosePasswordSignIn(page);
  const passwordInput = page.locator('input[name="passwd"], input#i0118, input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: Number('45000') }).catch(() => {});
  if (!await visible(passwordInput)) {
    return await hasIdentityChallenge(page) ? 'identity_challenge' : 'unavailable';
  }
  await fillVerified(page, passwordInput, password);
  await humanClickLocator(page, page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first());
  await humanIdlePause('long');
  const body = await page.locator('body').innerText().catch(() => '');
  if (PASSWORD_REJECTED.test(body)) return 'rejected';
  if (await visible(page.locator('input[name="passwd"], input#i0118'))) return 'rejected';
  await dismissStaySignedIn(page);
  if (await hasIdentityChallenge(page)) return 'identity_challenge';
  await page.waitForURL(AUTHORIZED_CONTEXT_URL_PATTERN, { timeout: Number('60000') }).catch(() => {});
  if (!AUTHORIZED_CONTEXT_HOST.test(new URL(page.url()).hostname)) {
    return await hasIdentityChallenge(page) ? 'identity_challenge' : 'unavailable';
  }
  return 'authenticated';
}

// 'changed' | 'rejected' | 'ambiguous' | 'challenged' | 'unavailable'
async function changeEntraPassword(session, currentPassword, nextPassword) {
  const page = session.page;
  await page.goto(CHANGE_PASSWORD_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (await hasIdentityChallenge(page)) return 'challenged';
  const passwordInputs = page.locator('input[type="password"]');
  await passwordInputs.first().waitFor({ state: 'visible', timeout: Number('60000') }).catch(() => {});
  const count = await passwordInputs.count().catch(() => Number('0'));
  if (count < Number('3')) return 'unavailable';
  await fill(page, passwordInputs.nth(''.length), currentPassword);
  await fill(page, passwordInputs.nth(count - Number('2')), nextPassword);
  await fill(page, passwordInputs.nth(count - 'x'.length), nextPassword);
  await humanClickLocator(page, page.locator('input[type="submit"], button[type="submit"]').first());
  await humanIdlePause('long');
  const body = await page.locator('body').innerText().catch(() => '');
  if (CHANGE_CONFIRMED.test(body)) return 'changed';
  if (CHANGE_REJECTED.test(body)) return 'rejected';
  return await visible(page.locator('input[type="password"]')) ? 'rejected' : 'ambiguous';
}

// 'none' | 'completed' | 'failed' | 'unknown'
//
// 'failed' is the known-state refusal: the restore never reached the directory,
// so it still holds the value this run wrote. Everything the restore leaves
// unproven is 'unknown'.
async function rollbackEntraPassword(session, contract, changedPassword, previousPassword, sink) {
  const signedIn = await signIn(session, contract, changedPassword);
  if (signedIn !== 'authenticated') return 'unknown';
  const identity = await assertEntraIdentity(session, contract, sink);
  if (!identity.ok) return 'unknown';
  const restored = await changeEntraPassword(session, changedPassword, previousPassword);
  if (restored === 'rejected' || restored === 'unavailable') return 'failed';
  if (restored !== 'changed') return 'unknown';
  const reauthenticated = await signIn(session, contract, previousPassword);
  if (reauthenticated !== 'authenticated') return 'unknown';
  const restoredIdentity = await assertEntraIdentity(session, contract, sink);
  return restoredIdentity.ok ? 'completed' : 'unknown';
}

// A rollback that restored the previous value leaves the provider untouched, a
// refused rollback leaves the value this run wrote, and anything else leaves the
// directory password unknown.
function providerEffectAfterRollback(rollbackStatus) {
  if (rollbackStatus === 'completed') return 'none';
  if (rollbackStatus === 'failed') return 'changed';
  return 'unknown';
}

// Directory binding proof that needs no password: the issuer of the UPN domain's
// OpenID configuration is the tenant that owns the domain.
async function tenantOfUpnDomain(accountUpn) {
  const domain = accountUpn.slice(accountUpn.lastIndexOf('@') + 'x'.length);
  const response = await fetch(
    `${SIGN_IN_ORIGIN}/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(Number('30000')) },
  ).catch(() => null);
  if (!response?.ok) return '';
  const document = await response.json().catch(() => null);
  const issuer = typeof document?.issuer === 'string' ? document.issuer : '';
  const found = issuer.match(ANY_UUID);
  return found ? found[''.length].toLowerCase() : '';
}

// 'password_form' | 'identity_verification_required' | 'not_eligible' | 'unavailable'
async function openSelfServiceReset(session, contract) {
  const page = session.page;
  await session.ctx.clearCookies();
  await page.goto(SELF_SERVICE_RESET_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const userInput = page.locator(
    'input#userNameInput, input[name="UserName"], input[type="email"], input[type="text"]',
  ).first();
  await userInput.waitFor({ state: 'visible', timeout: Number('60000') }).catch(() => {});
  if (await visible(userInput)) {
    await fill(page, userInput, contract.accountUpn);
    const proceed = page.getByRole('button', { name: /Next|Continue|Submit/i }).first();
    if (await visible(proceed)) {
      await humanClickLocator(page, proceed);
    } else {
      await humanClickLocator(page, page.locator('input[type="submit"], button[type="submit"]').first());
    }
    await humanIdlePause('long');
  }
  const body = await page.locator('body').innerText().catch(() => '');
  if (RESET_NOT_ELIGIBLE.test(body)) return 'not_eligible';
  if (RESET_VERIFICATION.test(body) || IDENTITY_CHALLENGE.test(body)) return 'identity_verification_required';
  const captcha = page.locator('iframe[src*="recaptcha"], iframe[title*="captcha" i], #wCaptchaDiv').first();
  if (await visible(captcha)) return 'identity_verification_required';
  const newPasswords = page.locator('input[type="password"]');
  const count = await newPasswords.count().catch(() => Number('0'));
  return count >= Number('2') ? 'password_form' : 'unavailable';
}

async function submitResetPasswordForm(session, nextPassword) {
  const page = session.page;
  const passwordInputs = page.locator('input[type="password"]');
  const count = await passwordInputs.count().catch(() => Number('0'));
  if (count < Number('2')) return 'unavailable';
  await fill(page, passwordInputs.nth(count - Number('2')), nextPassword);
  await fill(page, passwordInputs.nth(count - 'x'.length), nextPassword);
  await humanClickLocator(page, page.locator('input[type="submit"], button[type="submit"]').first());
  await humanIdlePause('long');
  const body = await page.locator('body').innerText().catch(() => '');
  if (CHANGE_CONFIRMED.test(body) || /your password has been reset/i.test(body)) return 'changed';
  if (CHANGE_REJECTED.test(body)) return 'rejected';
  return await visible(page.locator('input[type="password"]')) ? 'rejected' : 'ambiguous';
}

function updateAccountReference(account, contract) {
  if (!account.id) throw new Error('Entra account has no stable Skarbiec id');
  const metadata = {
    ...(account.metadata ?? {}),
    skarbiec_credential_id: contract.credentialId,
    entra_upn: contract.accountUpn,
    entra_tenant_id: contract.tenantId,
    entra_principal_object_id: contract.principalObjectId,
  };
  delete metadata.password;
  if (contract.skarbiecTenantId) metadata.skarbiec_tenant_id = contract.skarbiecTenantId;
  else delete metadata.skarbiec_tenant_id;
  if (!updateAccount(account.id, { metadata })) {
    throw new Error('Entra account credential-reference update failed');
  }
}

// Skarbiec write provenance keeps the exact operation: 'rotate' for a rotation,
// 'reset' for a directory reset, 'verify' for a rewrite of the same value, and
// 'rollback' only for compensating restores.
function commitPassword(contract, password, writeOperation) {
  const secret = Buffer.from(password, 'utf8');
  try {
    writeWelesAcquiredSecret(
      contract.credentialId,
      PASSWORD_FIELD,
      secret,
      contract.skarbiecTenantId,
      {
        accountEmail: contract.accountUpn,
        requestId: contract.requestId,
        operation: writeOperation,
      },
    );
  } finally {
    secret.fill(Number('0'));
  }
}

async function openSession(account, label) {
  const { proxyUrl, persona } = await resolveAccountSession(account);
  const session = await WSession.start({ label, proxy: proxyUrl, persona });
  return { session, proxyUrl };
}

async function queuedAccount(contract) {
  const account = await getSocialAccount('microsoft');
  if (!account || !accountMatchesContract(account, contract)) {
    return null;
  }
  return account;
}

function managedPassword(contract) {
  try {
    return readWelesManagedCredential(contract.credentialId, PASSWORD_FIELD, contract.skarbiecTenantId);
  } catch {
    return undefined;
  }
}

// Shared tail: fresh login with the value the provider now holds, full identity
// assertion, then the Skarbiec commit. Never commits an unasserted identity.
async function commitAfterFreshLogin(session, account, contract, plan) {
  const { password, writeOperation, sink, proxyUrl, providerEffect, evidence } = plan;
  const signedIn = await signIn(session, contract, password);
  evidence.push(`fresh_login_verification:${signedIn}`);
  if (signedIn !== 'authenticated') {
    return {
      committed: false,
      answer: outcome(contract, {
        status: signedIn === 'identity_challenge' ? 'needs_human_approval' : 'operation_failed',
        code: signedIn === 'identity_challenge'
          ? 'ENTRA_FRESH_LOGIN_REQUIRES_HUMAN_APPROVAL'
          : 'ENTRA_FRESH_LOGIN_FAILED',
        phase: signedIn === 'identity_challenge' ? 'identity_verification' : 'fresh_login_verification',
        retryable: signedIn !== 'rejected',
        providerEffect,
        reason: signedIn === 'identity_challenge'
          ? 'the fresh Entra login after the password write needs interactive identity approval'
          : 'the fresh Entra login with the newly written password did not authenticate',
      }),
    };
  }
  const identity = await assertEntraIdentity(session, contract, sink);
  if (!identity.ok) {
    return {
      committed: false,
      answer: outcome(contract, {
        status: 'operation_failed',
        code: identity.code,
        phase: 'identity_verification',
        retryable: identity.retryable,
        providerEffect,
        reason: identity.reason,
      }),
    };
  }
  evidence.push('identity_verification:confirmed');
  try {
    commitPassword(contract, password, writeOperation);
    await updateAccountReference(account, contract);
  } catch {
    return { committed: false, answer: null };
  }
  evidence.push(`skarbiec_commit:${writeOperation}`);
  const cookies = await session.ctx.cookies();
  await persistFreshCookieJar(account, cookies, { currentProxyUrl: proxyUrl });
  return { committed: true, answer: null };
}

export async function resetEntraPassword() {
  const contract = constraints(['rotate', 'reset']);
  const evidence = [];
  const account = await queuedAccount(contract);
  if (!account) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_ACCOUNT_BINDING_MISMATCH',
      phase: 'admission',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the queued account row is not bound to the requested Entra identity and managed credential',
    });
  }
  evidence.push('admission:account_bound');
  const currentPassword = managedPassword(contract);
  if (contract.operation === 'rotate' && !currentPassword) {
    return outcome(contract, {
      status: 'needs_human_approval',
      code: 'ROTATE_REQUIRES_KNOWN_PASSWORD',
      phase: 'credential_read',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'rotation requires the known managed Entra password so a compensating rollback stays possible',
    });
  }
  const nextPassword = generatedPassword();
  const { session, proxyUrl } = await openSession(account, 'microsoft_entra_reset_password');
  const bearerTokens = [];
  trackBearerTokens(session.page, bearerTokens);
  try {
    if (contract.operation === 'reset') {
      // Reset never holds the current password, so the pre-write proof is the
      // directory binding of the UPN domain; the full tid + oid + UPN assertion
      // runs on the fresh login before anything reaches Skarbiec, and every
      // interactive verification step is handed to a human.
      const domainTenant = await tenantOfUpnDomain(contract.accountUpn);
      if (domainTenant !== contract.tenantId) {
        return outcome(contract, {
          status: 'operation_failed',
          code: 'ENTRA_IDENTITY_MISMATCH',
          phase: 'identity_verification',
          retryable: false,
          providerEffect: 'none',
          rollbackStatus: 'none',
          reason: 'the UPN domain does not resolve to the requested Entra tenant',
        });
      }
      evidence.push('identity_verification:upn_domain_tenant_confirmed');
      const surface = await openSelfServiceReset(session, contract);
      if (surface === 'identity_verification_required') {
        return outcome(contract, {
          status: 'needs_human_approval',
          code: 'ENTRA_RESET_REQUIRES_HUMAN_VERIFICATION',
          phase: 'identity_verification',
          retryable: false,
          providerEffect: 'none',
          rollbackStatus: 'none',
          reason: 'the Entra self-service reset requires interactive identity verification',
        });
      }
      if (surface === 'not_eligible') {
        return outcome(contract, {
          status: 'operation_failed',
          code: 'ENTRA_RESET_NOT_ELIGIBLE',
          phase: 'password_change',
          retryable: false,
          providerEffect: 'none',
          rollbackStatus: 'none',
          reason: 'the Entra directory refused a self-service reset for this account',
        });
      }
      if (surface !== 'password_form') {
        return outcome(contract, {
          status: 'operation_failed',
          code: 'ENTRA_RESET_SURFACE_UNAVAILABLE',
          phase: 'password_change',
          retryable: true,
          providerEffect: 'none',
          rollbackStatus: 'none',
          reason: 'the Entra self-service reset did not present a new-password form',
        });
      }
      const submitted = await submitResetPasswordForm(session, nextPassword);
      evidence.push(`password_change:${submitted}`);
      if (submitted !== 'changed') {
        // A rejected reset never reached the directory; anything else leaves the
        // reset password unproven, and reset has no known value to roll back to.
        return outcome(contract, {
          status: 'operation_failed',
          code: submitted === 'rejected' ? 'ENTRA_RESET_REJECTED' : 'ENTRA_RESET_AMBIGUOUS',
          phase: 'password_change',
          retryable: submitted === 'rejected',
          providerEffect: submitted === 'rejected' ? 'none' : 'unknown',
          rollbackStatus: 'none',
          reason: submitted === 'rejected'
            ? 'the Entra directory rejected the reset password'
            : 'the Entra reset outcome is ambiguous and the previous password is unknown',
        });
      }
      const resetAt = new Date().toISOString();
      const reset = await commitAfterFreshLogin(
        session,
        account,
        contract,
        {
          password: nextPassword,
          writeOperation: 'reset',
          sink: bearerTokens,
          proxyUrl,
          providerEffect: 'changed',
          evidence,
        },
      );
      if (reset.answer) return reset.answer;
      if (!reset.committed) {
        // No known previous password means no compensating provider rollback.
        return outcome(contract, {
          status: 'operation_failed',
          code: 'SKARBIEC_COMMIT_FAILED',
          phase: 'skarbiec_commit',
          retryable: false,
          providerEffect: 'changed',
          rollbackStatus: 'none',
          reason: 'the Entra reset succeeded but the Skarbiec commit failed and no rollback value exists',
        });
      }
      return outcome(contract, {
        status: 'operation_completed',
        providerEffect: 'changed',
        rollbackStatus: 'none',
        changedAt: resetAt,
        evidence,
        reason: 'the Entra password was reset, re-authenticated, and committed to Skarbiec',
      });
    }

    const signedIn = await signIn(session, contract, currentPassword);
    evidence.push(`entra_sign_in:${signedIn}`);
    if (signedIn !== 'authenticated') {
      return outcome(contract, {
        status: signedIn === 'identity_challenge' ? 'needs_human_approval' : 'operation_failed',
        code: signedIn === 'identity_challenge'
          ? 'ENTRA_SIGN_IN_REQUIRES_HUMAN_APPROVAL'
          : signedIn === 'rejected' ? 'ENTRA_CURRENT_PASSWORD_REJECTED' : 'ENTRA_SIGN_IN_SURFACE_UNAVAILABLE',
        phase: signedIn === 'identity_challenge' ? 'identity_verification' : 'entra_sign_in',
        retryable: signedIn !== 'rejected',
        providerEffect: 'none',
        rollbackStatus: 'none',
        reason: signedIn === 'identity_challenge'
          ? 'Entra requires interactive identity approval before the password rotation'
          : signedIn === 'rejected'
            ? 'the managed Entra password was rejected at sign-in'
            : 'the Entra password sign-in surface was unavailable',
      });
    }
    const identity = await assertEntraIdentity(session, contract, bearerTokens);
    if (!identity.ok) {
      return outcome(contract, {
        status: 'operation_failed',
        code: identity.code,
        phase: 'identity_verification',
        retryable: identity.retryable,
        providerEffect: 'none',
        rollbackStatus: 'none',
        reason: identity.reason,
      });
    }
    evidence.push('identity_verification:confirmed');
    const changed = await changeEntraPassword(session, currentPassword, nextPassword);
    evidence.push(`password_change:${changed}`);
    if (changed === 'challenged' || changed === 'unavailable') {
      return outcome(contract, {
        status: 'needs_human_approval',
        code: changed === 'challenged'
          ? 'ENTRA_PASSWORD_CHANGE_REQUIRES_HUMAN_VERIFICATION'
          : 'ENTRA_PASSWORD_CHANGE_SURFACE_UNAVAILABLE',
        phase: changed === 'challenged' ? 'identity_verification' : 'password_change',
        retryable: changed === 'unavailable',
        providerEffect: 'none',
        rollbackStatus: 'none',
        reason: changed === 'challenged'
          ? 'the Entra password change surface asked for interactive identity verification'
          : 'the Entra password change surface did not present the current and new password fields',
      });
    }
    if (changed === 'rejected') {
      return outcome(contract, {
        status: 'operation_failed',
        code: 'ENTRA_PASSWORD_CHANGE_REJECTED',
        phase: 'password_change',
        retryable: true,
        providerEffect: 'none',
        rollbackStatus: 'none',
        reason: 'the Entra directory rejected the password change',
      });
    }
    if (changed === 'ambiguous') {
      const rollbackStatus = await rollbackEntraPassword(
        session,
        contract,
        nextPassword,
        currentPassword,
        bearerTokens,
      );
      evidence.push(`rollback:${rollbackStatus}`);
      return outcome(contract, {
        status: 'operation_failed',
        code: 'ENTRA_PASSWORD_CHANGE_AMBIGUOUS',
        phase: 'password_change',
        retryable: rollbackStatus === 'completed',
        providerEffect: providerEffectAfterRollback(rollbackStatus),
        rollbackStatus,
        reason: 'the Entra password change outcome could not be confirmed',
      });
    }
    const changedAt = new Date().toISOString();
    const rotation = await commitAfterFreshLogin(
      session,
      account,
      contract,
      {
        password: nextPassword,
        writeOperation: 'rotate',
        sink: bearerTokens,
        proxyUrl,
        providerEffect: 'changed',
        evidence,
      },
    );
    if (rotation.answer) {
      const rollbackStatus = await rollbackEntraPassword(
        session,
        contract,
        nextPassword,
        currentPassword,
        bearerTokens,
      );
      evidence.push(`rollback:${rollbackStatus}`);
      return outcome(contract, {
        ...rotation.answer,
        reason: rotation.answer.message,
        providerEffect: providerEffectAfterRollback(rollbackStatus),
        rollbackStatus,
      });
    }
    if (!rotation.committed) {
      const rollbackStatus = await rollbackEntraPassword(
        session,
        contract,
        nextPassword,
        currentPassword,
        bearerTokens,
      );
      evidence.push(`rollback:${rollbackStatus}`);
      if (rollbackStatus === 'completed') {
        let skarbiecRestored = false;
        try {
          commitPassword(contract, currentPassword, 'rollback');
          skarbiecRestored = true;
        } catch {
          skarbiecRestored = false;
        }
        return outcome(contract, {
          status: 'operation_failed',
          code: 'SKARBIEC_COMMIT_FAILED',
          phase: skarbiecRestored ? 'skarbiec_commit' : 'rollback',
          retryable: skarbiecRestored,
          providerEffect: 'none',
          rollbackStatus: skarbiecRestored ? 'completed' : 'failed',
          reason: skarbiecRestored
            ? 'the Skarbiec commit failed and both Entra and Skarbiec were restored to the previous password'
            : 'the Skarbiec commit failed, Entra was restored, and the Skarbiec restore did not confirm',
        });
      }
      if (rollbackStatus === 'unknown') {
        // Nothing proves which value the directory now holds, so the item is
        // quarantined instead of being written to or retried.
        return outcome(contract, {
          status: 'operation_failed',
          code: 'SKARBIEC_COMMIT_FAILED',
          phase: 'rollback',
          retryable: false,
          providerEffect: 'unknown',
          rollbackStatus,
          reason: 'the Skarbiec commit failed and the compensating Entra rollback left the directory password unproven',
        });
      }
      // The directory refused the rollback and still holds the value this run
      // proved by a fresh login, so the only consistent recovery is to land that
      // value in Skarbiec.
      try {
        commitPassword(contract, nextPassword, 'rotate');
        await updateAccountReference(account, contract);
      } catch {
        return outcome(contract, {
          status: 'operation_failed',
          code: 'SKARBIEC_COMMIT_FAILED',
          phase: 'skarbiec_commit',
          retryable: false,
          providerEffect: 'changed',
          rollbackStatus,
          reason: 'the Skarbiec commit and the compensating Entra rollback both failed',
        });
      }
      evidence.push('skarbiec_commit:rotate');
      return outcome(contract, {
        status: 'operation_completed',
        providerEffect: 'changed',
        rollbackStatus,
        changedAt,
        evidence,
        reason: 'the Entra password was rotated and committed to Skarbiec on the second commit attempt',
      });
    }
    return outcome(contract, {
      status: 'operation_completed',
      providerEffect: 'changed',
      rollbackStatus: 'none',
      changedAt,
      evidence,
      reason: 'the Entra password was rotated, re-authenticated, and committed to Skarbiec',
    });
  } finally {
    clearBearerTokens(bearerTokens);
    await session.close().catch(() => {});
  }
}

export async function verifyEntraPassword() {
  const contract = constraints(['verify']);
  const evidence = [];
  const account = await queuedAccount(contract);
  if (!account) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_ACCOUNT_BINDING_MISMATCH',
      phase: 'admission',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the queued account row is not bound to the requested Entra identity and managed credential',
    });
  }
  evidence.push('admission:account_bound');
  const password = managedPassword(contract);
  if (!password) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'MANAGED_PASSWORD_UNAVAILABLE',
      phase: 'credential_read',
      retryable: true,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the managed Entra password is unavailable from Skarbiec',
    });
  }
  evidence.push('credential_read:managed_password');
  const { session, proxyUrl } = await openSession(account, 'microsoft_entra_verify_password');
  const bearerTokens = [];
  trackBearerTokens(session.page, bearerTokens);
  try {
    const verified = await commitAfterFreshLogin(
      session,
      account,
      contract,
      {
        password,
        writeOperation: 'verify',
        sink: bearerTokens,
        proxyUrl,
        providerEffect: 'none',
        evidence,
      },
    );
    if (verified.answer) {
      return outcome(contract, {
        ...verified.answer,
        reason: verified.answer.message,
        providerEffect: 'none',
        rollbackStatus: 'none',
      });
    }
    if (!verified.committed) {
      return outcome(contract, {
        status: 'operation_failed',
        code: 'SKARBIEC_COMMIT_FAILED',
        phase: 'skarbiec_commit',
        retryable: true,
        providerEffect: 'none',
        rollbackStatus: 'none',
        reason: 'the verified Entra password could not be rewritten to Skarbiec',
      });
    }
    return outcome(contract, {
      status: 'operation_completed',
      providerEffect: 'none',
      rollbackStatus: 'none',
      changedAt: null,
      evidence,
      reason: 'the managed Entra password authenticated freshly and was rewritten unchanged',
    });
  } finally {
    clearBearerTokens(bearerTokens);
    await session.close().catch(() => {});
  }
}

// adopt takes over a password the operator already knows. Skarbiec stages that
// candidate under the item, bound to this request id; this run reads the staged
// value through the scoped managed-credential reader, proves it against the
// directory with a fresh login and the full tid + oid + UPN assertion, and
// reports a verdict. Skarbiec activates the staged revision itself on
// operation_completed, so Weles writes nothing here and never touches the value
// the directory holds: the provider effect is always 'none'.
export async function adoptEntraPassword() {
  const contract = constraints(['adopt']);
  const evidence = [];
  const account = await queuedAccount(contract);
  if (!account) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_ACCOUNT_BINDING_MISMATCH',
      phase: 'admission',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the queued account row is not bound to the requested Entra identity and managed credential',
    });
  }
  evidence.push('admission:account_bound');
  const candidate = managedPassword(contract);
  if (!candidate) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ADOPT_CANDIDATE_UNAVAILABLE',
      phase: 'credential_read',
      retryable: true,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the staged Entra password candidate for this request is unavailable from Skarbiec',
    });
  }
  evidence.push('credential_read:staged_candidate');
  const { session, proxyUrl } = await openSession(account, 'microsoft_entra_adopt_password');
  const bearerTokens = [];
  trackBearerTokens(session.page, bearerTokens);
  try {
    const signedIn = await signIn(session, contract, candidate);
    evidence.push(`fresh_login_verification:${signedIn}`);
    if (signedIn !== 'authenticated') {
      return outcome(contract, {
        status: signedIn === 'identity_challenge' ? 'needs_human_approval' : 'operation_failed',
        code: signedIn === 'identity_challenge'
          ? 'ADOPT_REQUIRES_HUMAN_APPROVAL'
          : signedIn === 'rejected' ? 'ADOPT_PASSWORD_REJECTED' : 'ENTRA_SIGN_IN_SURFACE_UNAVAILABLE',
        phase: signedIn === 'identity_challenge' ? 'identity_verification' : 'fresh_login_verification',
        retryable: signedIn === 'unavailable',
        providerEffect: 'none',
        rollbackStatus: 'none',
        reason: signedIn === 'identity_challenge'
          ? 'the adoption login needs interactive Entra identity approval before the staged candidate can be trusted'
          : signedIn === 'rejected'
            ? 'the Entra directory rejected the staged password candidate at sign-in'
            : 'the Entra password sign-in surface was unavailable',
      });
    }
    const identity = await assertEntraIdentity(session, contract, bearerTokens);
    if (!identity.ok) {
      return outcome(contract, {
        status: 'operation_failed',
        code: identity.code,
        phase: 'identity_verification',
        retryable: identity.retryable,
        providerEffect: 'none',
        rollbackStatus: 'none',
        reason: identity.reason,
      });
    }
    evidence.push('identity_verification:confirmed');
    const cookies = await session.ctx.cookies();
    await persistFreshCookieJar(account, cookies, { currentProxyUrl: proxyUrl });
    return outcome(contract, {
      status: 'operation_completed',
      providerEffect: 'none',
      rollbackStatus: 'none',
      changedAt: null,
      evidence,
      reason: 'the staged Entra password authenticated freshly against the asserted directory identity and can be adopted as managed',
    });
  } finally {
    clearBearerTokens(bearerTokens);
    await session.close().catch(() => {});
  }
}
