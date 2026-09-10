// The sentences a browser worker is handed, in the words it must obey.
//
// This is prose, not logic: every branch below builds an instruction that a
// model reads and acts on, so an edit here changes what happens to a real
// account at a real provider. That is why it is separated from the payload
// assembly next door — the surrounding job carries ids, origins and flags that
// a bridge parses, while these strings are the only part a worker interprets.
//
// The per-provider branches exist because the safe order of operations differs:
// a directory identity must be re-proved against tenant and principal claims, a
// consumer account rolls back through an opaque capability, a Figma token is a
// scope grant on an existing session, and an unenumerated provider must first be
// found. Each spells out its own rollback and its own reason to stop for a human
// rather than sharing one sentence that would be wrong for three of them.

import { acquiredSecretContract } from '../../scoped-service.js';
import type { AcquireSecretRequest } from '../request.js';
import { ENTRA_PROVIDER, type SecretDefinition } from '../catalog.js';

export function purposeFor(request: AcquireSecretRequest, def: SecretDefinition): string {
  const purpose = request.purpose?.trim();
  if (purpose) return purpose;
  const goal = request.goal?.toLowerCase() ?? '';
  if (goal.includes('lem')) return 'lem';
  return def.defaultPurpose;
}


export function objectiveFor(def: SecretDefinition, request: AcquireSecretRequest, accountEmail: string): string {
  const purpose = purposeFor(request, def);
  const contract = acquiredSecretContract(def.secret);
  if (!contract) throw new Error(`missing exact Skarbiec acquisition contract for ${def.secret}`);
  if (def.provider === ENTRA_PROVIDER) {
    const operation = request.operation ?? 'acquire';
    const accountUpn = request.accountUpn?.trim().toLowerCase() ?? '';
    return [
      `${operation} the Microsoft Entra directory password for the exact identity ${accountUpn}.`,
      `Confirm that the authorized session claims carry tenant ${request.tenantId ?? ''} and principal object id ${request.principalObjectId ?? ''} before any password write and again after the fresh login.`,
      operation === 'verify'
        ? 'Perform a fresh password authentication and rewrite the same managed value only after Entra accepts it.'
        : operation === 'adopt'
          ? 'The current password is already known to the operator and staged in Skarbiec: read that staged candidate, prove it with a fresh Entra login, and never change the password in the directory.'
          : operation === 'reset'
            ? 'The current password is unknown: drive the Entra self-service reset and return needs_human_approval for every interactive identity verification instead of attempting to satisfy it.'
            : 'Generate a new strong password in-process, change it in the Entra directory, perform a fresh password authentication, and only then commit it to Skarbiec.',
      'If any step after the directory accepts the candidate fails, restore the previous password and verify the restored password before returning operation_failed.',
      'If Entra requires interactive identity approval, stop as needs_human_approval without changing Skarbiec.',
      `The encrypted target is ${contract.item} field ${contract.field}; never emit the password in logs or task results.`,
    ].join(' ');
  }
  if (def.provider === 'microsoft') {
    const operation = request.operation ?? 'acquire';
    return [
      `${operation} the password for the exact Microsoft account ${accountEmail}.`,
      'Use only the queued account session and the exact Skarbiec credential contract.',
      operation === 'verify'
        ? 'Perform a fresh password authentication and rewrite the same managed value only after Microsoft accepts it.'
        : operation === 'adopt'
          ? 'The current password is already known to the operator and staged in Skarbiec: read that staged candidate, prove it with a fresh Microsoft login, and never change the password at the provider.'
          : 'Generate a new strong password in-process, change it at Microsoft, perform a fresh password authentication, and only then commit it to Skarbiec.',
      'If any step after Microsoft accepts the candidate fails, restore the previous password through its opaque capability and verify the restored password before returning operation_failed. If that rollback cannot be verified, return needs_human_approval and leave the staged Skarbiec candidate intact.',
      'If Microsoft requires interactive identity approval, stop as needs_human_approval without changing Skarbiec.',
      `The encrypted target is ${contract.item} field ${contract.field}; never emit the password in logs or task results.`,
    ].join(' ');
  }
  if (def.provider === 'figma') {
    return [
      `Acquire ${def.displayName} for ${purpose}.`,
      accountEmail
        ? `Use the existing authenticated account ${accountEmail}. If sign-in is required, use only the configured Google SSO credential capability or saved browser session; never ask for or expose its password.`
        : '',
      'Open account Settings, select Security, and scroll to Personal access tokens.',
      'Create one token named "Wisent design-assets export" with the longest offered expiration.',
      `Grant exactly these read-only scopes and no write scope: ${def.requestedScopes.join(', ')}.`,
      `The token will access only these endpoints: ${def.endpoints.join(', ')}.`,
      `When the generated token is visible, call store_credential(target, 'api-key') on the token element. Never pass the token to done, logs, tool arguments, clipboard, or normal result data.`,
      `Finish only after store_credential confirms the exact encrypted Skarbiec item ${contract.item} field ${contract.field} write.`,
    ].filter(Boolean).join(' ');
  }
  const fieldClass = contract.field === 'api_key'
    ? 'api-key'
    : contract.field === 'password'
      ? 'password'
      : 'token';
  const accountInstruction = accountEmail
    ? `Use the existing authenticated account ${accountEmail}. If sign-in is required, choose that account and use only the configured credential capability or saved browser session; never ask for or expose its password.`
    : '';
  const completionInstruction = `When the generated credential is visible, call store_credential(target, '${fieldClass}') on the credential element. Never pass the credential to done, logs, tool arguments, or normal result data. Finish only after store_credential confirms the exact encrypted Skarbiec item ${contract.item} field ${contract.field} write.`;
  const mode = 'Submit the request after all required fields are filled. Use Weles-generated or invented applicant details for identity, affiliation, organization, role, website, country, and other registration profile fields; do not ask the user for personal or organization data. If CAPTCHA, reCAPTCHA, or Turnstile appears, call solve_captcha and continue after it reports success; only return needs_human_approval after solve_captcha reports failure or mailbox/key-delivery access cannot be completed.';
  return [
    `Acquire ${def.displayName} API access for ${purpose}.`,
    accountInstruction,
    def.sourceOrigin === undefined
      ? ''
      : def.sourceOrigin
        ? `The provider site is exactly ${def.sourceOrigin}: complete the sign-up and the key generation there, and capture the credential on that origin only.`
        : `No provider site was declared: from this discovery page find the official ${def.displayName} developer site, open the provider's own origin, and complete the sign-up and the key generation there.`,
    `Use case: ${def.usageText}`,
    `Requested endpoints: ${def.endpoints.join(', ')}.`,
    `Expected daily requests: ${def.dailyRequests}.`,
    mode,
    completionInstruction,
  ].filter(Boolean).join(' ');
}
