// Everything that must already be true before a password operation is allowed
// onto the queue.
//
// Acquisition creates a credential that did not exist; these operations touch
// one that does, on an account someone is currently using. So the two functions
// below are mostly refusal: an operation the lifecycle does not offer, an
// identity that is not exactly one active bound account, a request id that is
// not one exact hash, a Skarbiec grant that is absent or lands on the wrong
// field, or — for a directory — a contract whose origin is not Entra's own.
//
// Every gate is evaluated before the first one is reported, and all of them are
// collected into `missing`, because an operator repairing a deployment should
// learn the whole list in one answer rather than one item per attempt.
//
// The two lifecycles sit together because they refuse for the same reasons in
// the same order, and drift between them would be a security difference nobody
// chose. They differ only where the identity differs: a consumer account is one
// email, while a directory identity is a UPN plus a tenant plus a principal
// object id, all three re-proved by the trajectory after the fresh login.

import {
  acquiredSecretContract,
  hasWelesAcquiredSecretWriter,
  hasWelesManagedCredentialReader,
  welesManagedCredentialReaderMismatch,
} from '../scoped-service.js';
import type { AcquireSecretRequest, AcquireSecretResult } from './request.js';
import { ENTRA_ORIGIN, ENTRA_PROVIDER, ENTRA_UPN, LOWER_UUID, type SecretDefinition } from './catalog.js';
import { paramsFor, queueAction } from './queued-job.js';
import { entraAccountBinding, microsoftAccountBinding } from './password-lifecycle/account-binding.js';

export async function queueMicrosoftPasswordOperation(
  def: SecretDefinition,
  request: AcquireSecretRequest,
): Promise<AcquireSecretResult> {
  const operation = request.operation ?? 'acquire';
  if (operation !== 'adopt' && operation !== 'rotate' && operation !== 'verify') {
    return {
      status: 'unsupported_operation',
      secret: def.secret,
      operation,
      provider: def.provider,
      message: `${operation} is not supported for a Microsoft account password`,
    };
  }
  const accountEmail = request.accountEmail?.trim().toLowerCase() ?? '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) {
    return {
      status: 'needs_configuration',
      secret: def.secret,
      vaultItemId: def.secret,
      operation,
      provider: def.provider,
      missing: ['one exact Microsoft account email'],
      message: 'Microsoft password operations require one exact account email',
    };
  }
  const binding = microsoftAccountBinding(accountEmail, def.secret, request.tenantId);
  const accountId = binding.accountId;
  const missing = [
    ...(!/^[a-f0-9]{64}$/i.test(request.requestId ?? '') ? ['one exact credential operation request id'] : []),
    ...(!accountId && !binding.error ? ['one uniquely matching active Microsoft account'] : []),
    ...(binding.error ? [binding.error] : []),
    ...(!hasWelesAcquiredSecretWriter(def.secret, request.tenantId)
      ? [`scoped Skarbiec writer for ${def.secret}`]
      : []),
    // A reader that is missing because the deployed catalog grants the item on
    // another field is a different fix from a reader nobody declared, so say
    // which one it is rather than reporting both as an absent grant.
    ...(!hasWelesManagedCredentialReader(def.secret, 'password', request.tenantId)
      ? [welesManagedCredentialReaderMismatch(def.secret, 'password', request.tenantId)
        ?? `tenant-scoped Skarbiec reader for ${def.secret}/password`]
      : []),
  ];
  if (missing.length) {
    return {
      status: 'needs_configuration',
      operation,
      secret: def.secret,
      vaultItemId: def.secret,
      provider: def.provider,
      missing,
      message: `Cannot enqueue Microsoft password ${operation} without ${missing.join(', ')}`,
    };
  }
  const params = paramsFor(def, { ...request, accountEmail });
  const action = operation === 'adopt'
    ? 'microsoft_adopt_password'
    : operation === 'verify'
      ? 'microsoft_verify_password'
      : 'microsoft_reset_password';
  const actionLogId = queueAction(action, accountId!, params, request.priority ?? 10);
  return {
    status: 'operation_queued',
    operation,
    secret: def.secret,
    provider: 'microsoft',
    actionLogId,
    action,
    flowName: 'microsoft-password-lifecycle',
    vaultItemId: def.secret,
    message: `Microsoft password ${operation} queued; Skarbiec remains pending until fresh-login verification ${operation === 'adopt' ? 'activates the staged candidate' : 'rewrites the managed item'}`,
  };
}

export async function queueEntraPasswordOperation(
  def: SecretDefinition,
  request: AcquireSecretRequest,
): Promise<AcquireSecretResult> {
  const operation = request.operation ?? 'acquire';
  if (operation !== 'adopt' && operation !== 'rotate' && operation !== 'reset' && operation !== 'verify') {
    return {
      status: 'unsupported_operation',
      secret: def.secret,
      operation,
      provider: def.provider,
      message: `${operation} is not supported for a Microsoft Entra directory password`,
    };
  }
  const accountUpn = request.accountUpn?.trim().toLowerCase() ?? '';
  const tenantId = request.tenantId?.trim().toLowerCase() ?? '';
  const principalObjectId = request.principalObjectId?.trim().toLowerCase() ?? '';
  const contract = acquiredSecretContract(def.secret);
  // The Entra directory id addresses the identity, not a Weles Skarbiec tenant.
  const skarbiecTenantId = null;
  const coordinatesReady = ENTRA_UPN.test(accountUpn)
    && LOWER_UUID.test(tenantId)
    && LOWER_UUID.test(principalObjectId);
  const binding = coordinatesReady
    ? entraAccountBinding(accountUpn, def.secret, tenantId, principalObjectId, skarbiecTenantId)
    : { accountId: null } as { accountId: string | null; error?: string };
  const missing = [
    ...(!/^[a-f0-9]{64}$/i.test(request.requestId ?? '') ? ['one exact credential operation request id'] : []),
    ...(!ENTRA_UPN.test(accountUpn) ? ['one exact Entra account UPN'] : []),
    ...(!LOWER_UUID.test(tenantId) ? ['one exact lowercase Entra tenant id'] : []),
    ...(!LOWER_UUID.test(principalObjectId) ? ['one exact lowercase Entra principal object id'] : []),
    ...(contract?.field !== 'password' || contract.item !== def.secret
      ? [`exact Skarbiec password contract for ${def.secret}`]
      : []),
    ...(contract?.sourceOrigin !== ENTRA_ORIGIN
      ? [`Entra credential source origin ${ENTRA_ORIGIN} for ${def.secret}`]
      : []),
    ...(coordinatesReady && !binding.accountId && !binding.error
      ? ['one uniquely matching active account bound to the requested Entra identity']
      : []),
    ...(binding.error ? [binding.error] : []),
    ...(!hasWelesAcquiredSecretWriter(def.secret, skarbiecTenantId)
      ? [`scoped Skarbiec writer for ${def.secret}`]
      : []),
    ...(operation !== 'reset' && !hasWelesManagedCredentialReader(def.secret, 'password', skarbiecTenantId)
      ? [welesManagedCredentialReaderMismatch(def.secret, 'password', skarbiecTenantId)
        ?? `scoped Skarbiec reader for ${def.secret}/password`]
      : []),
  ];
  if (missing.length) {
    return {
      status: 'needs_configuration',
      operation,
      secret: def.secret,
      vaultItemId: def.secret,
      provider: def.provider,
      missing,
      message: `Cannot enqueue Entra password ${operation} without ${missing.join(', ')}`,
    };
  }
  const params = paramsFor(def, { ...request, accountUpn, tenantId, principalObjectId });
  const action = operation === 'verify'
    ? 'microsoft_entra_verify_password'
    : operation === 'adopt'
      ? 'microsoft_entra_adopt_password'
      : 'microsoft_entra_reset_password';
  const actionLogId = queueAction(action, binding.accountId!, params, request.priority ?? 10);
  return {
    status: 'operation_queued',
    operation,
    secret: def.secret,
    provider: ENTRA_PROVIDER,
    actionLogId,
    action,
    flowName: 'microsoft-entra-password-lifecycle',
    vaultItemId: def.secret,
    message: `Entra password ${operation} queued; Skarbiec remains pending until the fresh-login identity assertion rewrites the managed item`,
  };
}
