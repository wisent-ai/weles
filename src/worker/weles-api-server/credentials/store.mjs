import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../public-task-service/wire/canonical-json.mjs';
import { persistRunResult } from '../run/run-outcome.mjs';
import { CredentialAdmissionError } from './authority.mjs';

const PREFIX = 'credential-request-';
const FILE = /^credential-request-([a-fA-F0-9]{64})\.json$/;
const IDENTITY_KEYS = [
  'version', 'request_id', 'credential_id', 'provider', 'field', 'operation',
  'consumer', 'purpose', 'account_email', 'directory', 'signup_origin', 'baseline_revision',
  'dry_run',
];

export function requestIdentity(request) {
  const identity = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, request[key] ?? null]));
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

export function createCredentialStore(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  function pathFor(id) {
    if (!/^[a-fA-F0-9]{64}$/.test(id)) throw new Error('invalid credential request id');
    return join(root, `${PREFIX}${id}.json`);
  }
  function load(id) {
    const path = pathFor(id);
    let metadata;
    try { metadata = lstatSync(path); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
        || (metadata.mode & 0o77) !== 0 || metadata.size > 256 * 1024) {
      throw new CredentialAdmissionError(503, 'WELES_CREDENTIAL_STATE_UNSAFE',
        `credential admission record is not an owner-only bounded file: ${path}`);
    }
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.schema !== 'weles.credential-admission.v1' || record.request?.request_id !== id) {
      throw new CredentialAdmissionError(503, 'WELES_CREDENTIAL_STATE_INVALID',
        `credential admission record identity is invalid: ${path}`);
    }
    return record;
  }
  function check(record, request, consumer) {
    if (record.consumer !== consumer || record.fingerprint !== requestIdentity(request)) {
      throw new CredentialAdmissionError(409, 'WELES_CREDENTIAL_REQUEST_CONFLICT',
        'credential request id is already bound to another identity or request');
    }
    if (request.mode === 'status' && record.reply.actionLogId !== request.action_log_id) {
      throw new CredentialAdmissionError(409, 'WELES_CREDENTIAL_TASK_MISMATCH',
        'credential status names another action log');
    }
  }
  return {
    load,
    check,
    save(record) { persistRunResult(pathFor(record.request.request_id), record); },
    records() {
      return readdirSync(root).filter((name) => FILE.test(name))
        .map((name) => load(FILE.exec(name)[1]));
    },
  };
}
