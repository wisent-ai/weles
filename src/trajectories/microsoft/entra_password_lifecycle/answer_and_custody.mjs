// What an Entra password run hands back to the operator, and how the password
// material itself is held: one shape for every terminal answer, the approval and
// receipt resources it carries, and the read, write and zeroing of the secret.
//
// Moved out of entra_password_lifecycle.mjs, which keeps the three trajectory
// entry points.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import {
  readWelesManagedCredential,
  writeWelesAcquiredSecret,
} from '../../../../dist/secrets/scoped-service.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

import { PASSWORD_FIELD } from './queued_job.mjs';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const MESSAGE_LIMIT = Number('512');
const HOST_LIMIT = Number('128');
const PROVIDER_EFFECTS = Object.freeze(['none', 'changed', 'unknown']);
// A human approval holds the lease. Four hours is long enough for a person to
// answer and short enough that an unanswered approval releases on its own.
const APPROVAL_TTL_MS = Number('14400000');
const RESUME_TOKEN_BYTES = Number('48');

export function generatedPassword() {
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
export function outcome(contract, fields) {
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

// Skarbiec write provenance keeps the exact operation: 'rotate' for a rotation,
// 'reset' for a directory reset, 'verify' for a rewrite of the same value, and
// 'rollback' only for compensating restores.
export function commitPassword(contract, password, writeOperation) {
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
    for (let index = Number('0'); index < secret.length; index += Number('1')) secret[index] = Number('0');
  }
}

export function managedPassword(contract) {
  try {
    return readWelesManagedCredential(contract.credentialId, PASSWORD_FIELD, contract.skarbiecTenantId);
  } catch {
    return undefined;
  }
}
