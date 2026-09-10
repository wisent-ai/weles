// The queued Entra password job: which exact Skarbiec contract this run may
// execute, which Skarbiec account row it is bound to, and which Entra-owned
// surfaces the operation lives on.
//
// Moved out of entra_password_lifecycle.mjs, which keeps the three trajectory
// entry points.

import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { updateAccount } from '../../../../dist/state/skarbiec-records.js';
import { WSession } from '../../../../dist/session/wsession.js';

const ENTRA_PASSWORD_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;
const ENTRA_PROVIDER = 'microsoft_entra';
export const PASSWORD_FIELD = 'password';
export const SIGN_IN_ORIGIN = 'https://login.microsoftonline.com';
export const AUTHORIZED_CONTEXT_URL = 'https://myaccount.microsoft.com/';
export const AUTHORIZED_CONTEXT_HOST = /(^|\.)myaccount\.microsoft\.com$/;
export const AUTHORIZED_CONTEXT_URL_PATTERN = /^https:\/\/myaccount\.microsoft\.com\//;
export const CHANGE_PASSWORD_URL = 'https://account.activedirectory.windowsazure.com/ChangePassword.aspx';
export const SELF_SERVICE_RESET_URL = 'https://passwordreset.microsoftonline.com/';
const SIGN_IN_HOSTS = Object.freeze(['login.microsoftonline.com', 'login.microsoft.com']);
const OPERATIONS = Object.freeze(['adopt', 'rotate', 'reset', 'verify']);
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const LOWER_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const ACTION_LOG_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

// The queued row carries two unrelated tenants. The directory block is the
// item's own write-once identity contract (the Entra directory the principal
// lives in, asserted against token claims), while constraints.weles_tenant_id is
// the Weles/Skarbiec binding tenant used to resolve the scoped reader and
// writer. Never cross them, and never take the identity from anywhere but the
// directory block: a missing or partial block is a refusal, not a default.
export function constraints(allowedOperations) {
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

export function updateAccountReference(account, contract) {
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

export async function openSession(account, label) {
  const { proxyUrl, persona } = await resolveAccountSession(account);
  const session = await WSession.start({ label, proxy: proxyUrl, persona });
  return { session, proxyUrl };
}

export async function queuedAccount(contract) {
  const account = await getSocialAccount('microsoft');
  if (!account || !accountMatchesContract(account, contract)) {
    return null;
  }
  return account;
}
