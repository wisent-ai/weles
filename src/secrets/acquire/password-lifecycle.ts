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

import { createHash } from 'node:crypto';
import {
  acquiredSecretContract,
  hasWelesManagedCredentialReader,
  welesManagedCredentialReaderMismatch,
} from '../scoped-service.js';
import { welesAcquiredSecretWriterProblem } from '../scoped-service/transport.js';
import type {
  AcquireSecretRequest,
  AcquireSecretResult,
  CredentialOperation,
} from './request.js';
import {
  ENTRA_ORIGIN,
  ENTRA_PROVIDER,
  ENTRA_UPN,
  LOWER_UUID,
  type SecretDefinition,
} from './catalog.js';
import { paramsFor, queueAction } from './queued-job.js';
import {
  entraAccountBinding,
  microsoftAccountBinding,
} from './password-lifecycle/account-binding.js';

// A credential operation's request id is one sha256, written in hex.
const REQUEST_ID_LENGTH = createHash('sha256').digest('hex').length;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// The trajectory each lifecycle runs for each operation it offers. Kept as
// literals so a queued result names exactly the operation and trajectory the
// result type allows, and an operation outside the map is refused by name.
const MICROSOFT_ACTIONS = {
  adopt: 'microsoft_adopt_password',
  verify: 'microsoft_verify_password',
  rotate: 'microsoft_reset_password',
} as const;
const ENTRA_ACTIONS = {
  adopt: 'microsoft_entra_adopt_password',
  verify: 'microsoft_entra_verify_password',
  rotate: 'microsoft_entra_reset_password',
  reset: 'microsoft_entra_reset_password',
} as const;

/** Whether `actions` offers `operation`, read by its own keys. */
function offers<Actions extends object>(
  actions: Actions,
  operation: CredentialOperation,
): operation is CredentialOperation & keyof Actions {
  return Object.hasOwn(actions, operation);
}

function normalized(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase();
}
const matches = (pattern: RegExp, value: string | undefined) =>
  typeof value === 'string' && pattern.test(value);
const isRequestId = (value: string | undefined) =>
  typeof value === 'string' &&
  value.length === REQUEST_ID_LENGTH &&
  /^[a-f\d]+$/i.test(value);

/** What is missing for the managed password reader of `secret`: the mismatch the catalog in force names, else the absent grant. */
function readerProblem(
  secret: string,
  tenantId: string | null | undefined,
  absent: string,
): string[] {
  // A catalog that grants the item on another field, or cannot be read, is
  // named first: it is a different fix from a reader nobody declared.
  const mismatch = welesManagedCredentialReaderMismatch(
    secret,
    'password',
    tenantId,
  );
  if (mismatch) return [mismatch];
  if (hasWelesManagedCredentialReader(secret, 'password', tenantId)) return [];
  return [absent];
}

function writerProblem(
  secret: string,
  tenantId: string | null | undefined,
): string[] {
  const problem = welesAcquiredSecretWriterProblem(secret, tenantId);
  if (problem === null) return [];
  return [problem];
}

export async function queueMicrosoftPasswordOperation(
  def: SecretDefinition,
  request: AcquireSecretRequest,
  enqueue: typeof queueAction = queueAction,
): Promise<AcquireSecretResult> {
  const { operation } = request;
  if (!offers(MICROSOFT_ACTIONS, operation)) {
    return {
      status: 'unsupported_operation',
      secret: def.secret,
      operation,
      provider: def.provider,
      message: `${operation} is not supported for a Microsoft account password`,
    };
  }
  const action = MICROSOFT_ACTIONS[operation];
  const accountEmail = normalized(request.accountEmail);
  if (!accountEmail || !EMAIL.test(accountEmail)) {
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
  const binding = microsoftAccountBinding(
    accountEmail,
    def.secret,
    request.tenantId,
  );
  const { accountId } = binding;
  const missing = [
    ...(isRequestId(request.requestId)
      ? []
      : ['one exact credential operation request id']),
    ...(!accountId && !binding.error
      ? ['one uniquely matching active Microsoft account']
      : []),
    ...(binding.error ? [binding.error] : []),
    ...writerProblem(def.secret, request.tenantId),
    ...readerProblem(
      def.secret,
      request.tenantId,
      `tenant-scoped Skarbiec reader for ${def.secret}/password`,
    ),
  ];
  if (missing.length || !accountId) {
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
  const actionLogId = await enqueue(
    action,
    accountId,
    params,
    request.priority,
  );
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
  enqueue: typeof queueAction = queueAction,
): Promise<AcquireSecretResult> {
  const { operation } = request;
  if (!offers(ENTRA_ACTIONS, operation)) {
    return {
      status: 'unsupported_operation',
      secret: def.secret,
      operation,
      provider: def.provider,
      message: `${operation} is not supported for a Microsoft Entra directory password`,
    };
  }
  const action = ENTRA_ACTIONS[operation];
  const accountUpn = normalized(request.accountUpn);
  const tenantId = normalized(request.tenantId);
  const principalObjectId = normalized(request.principalObjectId);
  const contract = acquiredSecretContract(def.secret);
  // The Entra directory id addresses the identity, not a Weles Skarbiec tenant.
  const skarbiecTenantId = null;
  const coordinates =
    accountUpn &&
    tenantId &&
    principalObjectId &&
    ENTRA_UPN.test(accountUpn) &&
    LOWER_UUID.test(tenantId) &&
    LOWER_UUID.test(principalObjectId)
      ? { accountUpn, tenantId, principalObjectId }
      : undefined;
  const binding = coordinates
    ? entraAccountBinding(
        coordinates.accountUpn,
        def.secret,
        coordinates.tenantId,
        coordinates.principalObjectId,
        skarbiecTenantId,
      )
    : undefined;
  const missing = [
    ...(isRequestId(request.requestId)
      ? []
      : ['one exact credential operation request id']),
    ...(matches(ENTRA_UPN, accountUpn) ? [] : ['one exact Entra account UPN']),
    ...(matches(LOWER_UUID, tenantId)
      ? []
      : ['one exact lowercase Entra tenant id']),
    ...(matches(LOWER_UUID, principalObjectId)
      ? []
      : ['one exact lowercase Entra principal object id']),
    ...(contract &&
    contract.field === 'password' &&
    contract.item === def.secret
      ? []
      : [`exact Skarbiec password contract for ${def.secret}`]),
    ...(contract && contract.sourceOrigin === ENTRA_ORIGIN
      ? []
      : [`Entra credential source origin ${ENTRA_ORIGIN} for ${def.secret}`]),
    ...(binding && !binding.accountId && !binding.error
      ? [
          'one uniquely matching active account bound to the requested Entra identity',
        ]
      : []),
    ...(binding && binding.error ? [binding.error] : []),
    ...writerProblem(def.secret, skarbiecTenantId),
    // A reset writes a password nobody knew, so it needs no reader.
    ...(operation === 'reset'
      ? []
      : readerProblem(
          def.secret,
          skarbiecTenantId,
          `scoped Skarbiec reader for ${def.secret}/password`,
        )),
  ];
  if (missing.length || !coordinates || !binding || !binding.accountId) {
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
  const params = paramsFor(def, { ...request, ...coordinates });
  const actionLogId = await enqueue(
    action,
    binding.accountId,
    params,
    request.priority,
  );
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
