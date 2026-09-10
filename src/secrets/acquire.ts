// The two entry points the rest of Wisent has for credential acquisition, and
// the refusals that come before any of it.
//
// Both functions ask the same three questions in the same order — is this a
// credential we know, did the caller name a provider that contradicts it, and is
// the requested operation one this credential offers — and only then diverge:
// `acquireSecret` hands the request to the path that queues it, while
// `buildSecretAcquisitionPlan` returns the payload that would have been queued
// without touching the action log.
//
// The plan builder carries two refusals the queueing paths reach later or by a
// different route. It will not describe a directory operation whose identity
// coordinates are absent, because such a plan is one nobody could execute, and
// it will not describe a job aimed at a declared signup origin that is not one
// absolute https origin, because that job could never match its capture origin.
//
// What each of the pieces below owns is stated in its own file: `acquire/request`
// the caller's vocabulary, `acquire/catalog` which credential a request is about,
// `acquire/queued-job` the payload a worker receives, `acquire/password-lifecycle`
// the gates on an existing account's password, and `acquire/api-key-acquisition`
// the creation of a credential that does not exist yet. The three type names below
// are re-exported one by one so every caller's import is unchanged and nothing new
// leaks out with them.

import { isWelesAcquiredSourceOrigin } from './scoped-service.js';
import type { AcquireSecretRequest, AcquireSecretResult } from './acquire/request.js';
import { definitionFor, normalizeSecret, ENTRA_PROVIDER, ENTRA_UPN, LOWER_UUID } from './acquire/catalog.js';
import { paramsFor } from './acquire/queued-job.js';
import { queueEntraPasswordOperation, queueMicrosoftPasswordOperation } from './acquire/password-lifecycle.js';
import { queueAcquisition } from './acquire/api-key-acquisition.js';

export type { AcquireSecretRequest, AcquireSecretResult, CredentialOperation } from './acquire/request.js';

export async function acquireSecret(request: AcquireSecretRequest): Promise<AcquireSecretResult> {
  const def = definitionFor(request);
  if (!def) {
    // Name what the caller asked for. An id that matches no declaration
    // normalizes to nothing, and a refusal reading "unknown" hides the very fact
    // that resolves it: which id has no declared contract.
    const secret = normalizeSecret(request)
      || request.credentialId?.trim().toLowerCase()
      || 'unknown';
    return { status: 'unsupported_secret', secret, message: `No secret acquisition registry entry for ${secret}` };
  }
  if (request.provider && request.provider !== def.provider) {
    return {
      status: 'unsupported_secret',
      secret: def.secret,
      message: `Credential ${def.secret} is not registered for provider ${request.provider}`,
    };
  }
  const operation = request.operation ?? 'acquire';
  if (def.operations && !def.operations.includes(operation)) {
    return {
      status: 'unsupported_operation',
      operation,
      secret: def.secret,
      provider: def.provider,
      message: `${operation} is not supported for ${def.secret}`,
    };
  }
  if (def.provider === ENTRA_PROVIDER) {
    return queueEntraPasswordOperation(def, request);
  }
  if (def.provider === 'microsoft') {
    return queueMicrosoftPasswordOperation(def, request);
  }
  if (operation !== 'acquire') {
    return {
      status: 'unsupported_operation',
      operation,
      secret: def.secret,
      provider: def.provider,
      message: `${operation} is not supported for ${def.secret}`,
    };
  }


  return queueAcquisition(def, request);
}

export function buildSecretAcquisitionPlan(request: AcquireSecretRequest): AcquireSecretResult {
  const def = definitionFor(request);
  if (!def) {
    const secret = normalizeSecret(request)
      || request.credentialId?.trim().toLowerCase()
      || 'unknown';
    return { status: 'unsupported_secret', secret, message: `No secret acquisition registry entry for ${secret}` };
  }
  if (request.provider && request.provider !== def.provider) {
    return {
      status: 'unsupported_secret',
      secret: def.secret,
      message: `Credential ${def.secret} is not registered for provider ${request.provider}`,
    };
  }
  const operation = request.operation ?? 'acquire';
  if ((def.operations && !def.operations.includes(operation))
      || (!def.operations && operation !== 'acquire')) {
    return {
      status: 'unsupported_operation',
      operation,
      secret: def.secret,
      provider: def.provider,
      message: `${operation} is not supported for ${def.secret}`,
    };
  }
  // A plan for a directory provider without its sealed coordinates would
  // describe an operation nobody can execute: the queue path rejects it, and
  // the emitted directory block would carry empty identity fields. Refuse here
  // rather than hand back a plan the caller cannot act on.
  if (def.provider === ENTRA_PROVIDER) {
    const missing = [
      ...(ENTRA_UPN.test(request.accountUpn?.trim().toLowerCase() ?? '') ? [] : ['one exact account UPN']),
      ...(LOWER_UUID.test(request.tenantId?.trim().toLowerCase() ?? '') ? [] : ['one exact tenant id']),
      ...(LOWER_UUID.test(request.principalObjectId?.trim().toLowerCase() ?? '')
        ? []
        : ['one exact principal object id']),
    ];
    if (missing.length) {
      return {
        status: 'needs_configuration',
        operation,
        secret: def.secret,
        vaultItemId: def.secret,
        provider: def.provider,
        missing,
        message: `Cannot plan ${operation} for ${def.secret} without ${missing.join(', ')}`,
      };
    }
  }
  // A declared signup origin that is not one absolute https origin would send the
  // browser job to a target nobody named and could never match the capture
  // origin, so it is a configuration error, not a plan.
  if (def.sourceOrigin && !isWelesAcquiredSourceOrigin(def.sourceOrigin)) {
    return {
      status: 'needs_configuration',
      operation,
      secret: def.secret,
      vaultItemId: def.secret,
      provider: def.provider,
      missing: ['one exact absolute https signup origin'],
      message: `Cannot plan ${operation} for ${def.secret} without one exact absolute https signup origin`,
    };
  }
  const params = paramsFor(def, { ...request, dryRun: true });
  return {
    status: 'operation_plan',
    operation,
    secret: def.secret,
    vaultItemId: def.secret,
    provider: def.provider,
    url: def.formUrl,
    objective: String(params.objective),
    params,
  };
}
