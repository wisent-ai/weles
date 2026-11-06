// The worker's record of each credential request it admitted, one owner-only
// file per request id under the store's root, so a repeated request is
// answered from the record and a conflicting one is refused.

import { createHash } from 'node:crypto';
import {
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { constants as http } from 'node:http2';
import { join } from 'node:path';
import { isRequestId } from '../../../../dist/secrets/request-id.js';
import { canonicalJson } from '../../public-task-service/wire/canonical-json.mjs';
import { persistRunResult } from '../run/run-outcome.mjs';
import { CredentialAdmissionError } from './authority.mjs';

const PREFIX = 'credential-request-';
const SUFFIX = '.json';
const OTHERS_ACCESS = constants.S_IRWXG | constants.S_IRWXO;
const IDENTITY_KEYS = [
  'version',
  'request_id',
  'credential_id',
  'provider',
  'field',
  'operation',
  'consumer',
  'purpose',
  'account_email',
  'directory',
  'signup_origin',
  'baseline_revision',
  'dry_run',
];

/**
 * The SHA-256 fingerprint of what identifies a request: every identity key,
 * an absent one written as null, in canonical JSON.
 */
export function requestIdentity(request) {
  const identity = Object.fromEntries(
    IDENTITY_KEYS.map((key) => [
      key,
      request[key] === undefined ? null : request[key],
    ]),
  );
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

/** The request id a store file is named for, or undefined for any other file. */
function requestIdOf(name) {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return undefined;
  const id = name.slice(PREFIX.length, name.length - SUFFIX.length);
  return isRequestId(id) ? id : undefined;
}

/**
 * The phases a credential operation's record moves through, each with the
 * phases it may move to: admitted, then queued for its trajectory, running
 * it, and finished; admission and a failure at any point finish it. A
 * finished record moves nowhere.
 */
export const PHASES = Object.freeze({
  admitting: Object.freeze(['queued', 'finished']),
  queued: Object.freeze(['running', 'finished']),
  running: Object.freeze(['finished']),
  finished: Object.freeze([]),
});

/** Whether a record in `phase` has not finished. */
export function unfinished(phase) {
  return phase !== 'finished';
}

/**
 * Move `record` to `next`, or refuse naming both phases and the moves its
 * current phase allows: the one place a phase changes.
 */
export function advance(record, next) {
  const allowed = PHASES[record.phase];
  if (!allowed.includes(next)) {
    throw new Error(
      `credential operation ${record.request.request_id} cannot move from ${record.phase} to ${next}; from ${record.phase} it moves to ${allowed.length ? allowed.join(' or ') : 'nothing'}`,
    );
  }
  record.phase = next;
}

export function createCredentialStore(root) {
  mkdirSync(root, { recursive: true, mode: constants.S_IRWXU });
  function pathFor(id) {
    if (!isRequestId(id)) throw new Error('invalid credential request id');
    return join(root, `${PREFIX}${id}${SUFFIX}`);
  }
  function load(id) {
    const path = pathFor(id);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      metadata.mode & OTHERS_ACCESS
    ) {
      throw new CredentialAdmissionError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'WELES_CREDENTIAL_STATE_UNSAFE',
        `credential admission record is not an owner-only regular file: ${path}`,
      );
    }
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (
      record.schema !== 'weles.credential-admission.v1' ||
      record.request?.request_id !== id
    ) {
      throw new CredentialAdmissionError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'WELES_CREDENTIAL_STATE_INVALID',
        `credential admission record identity is invalid: ${path}`,
      );
    }
    if (!Object.hasOwn(PHASES, record.phase)) {
      throw new CredentialAdmissionError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'WELES_CREDENTIAL_STATE_INVALID',
        `credential admission record ${path} names the phase ${JSON.stringify(record.phase)}; the phases are ${Object.keys(PHASES).join(', ')}`,
      );
    }
    return record;
  }
  function check(record, request, consumer) {
    if (
      record.consumer !== consumer ||
      record.fingerprint !== requestIdentity(request)
    ) {
      throw new CredentialAdmissionError(
        http.HTTP_STATUS_CONFLICT,
        'WELES_CREDENTIAL_REQUEST_CONFLICT',
        'credential request id is already bound to another identity or request',
      );
    }
    if (
      request.mode === 'status' &&
      record.reply.actionLogId !== request.action_log_id
    ) {
      throw new CredentialAdmissionError(
        http.HTTP_STATUS_CONFLICT,
        'WELES_CREDENTIAL_TASK_MISMATCH',
        'credential status names another action log',
      );
    }
  }
  return {
    load,
    check,
    save(record) {
      persistRunResult(pathFor(record.request.request_id), record);
    },
    records() {
      return readdirSync(root)
        .map(requestIdOf)
        .filter((id) => id !== undefined)
        .map((id) => load(id));
    },
  };
}
