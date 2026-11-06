// The reply to a finished credential operation. A run states what it did in
// one place (src/secrets/operation/answer.ts): the credential_operation member
// of its service_action_result.json. A run that states it is answered with
// what it stated; a run that states nothing is answered from what the worker
// observed itself, the run's exit and the Skarbiec capture it acknowledged,
// and the reply says the run stated nothing.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { credentialResponse } from '@wisent-ai/weles-client/credential/response';
import {
  CREDENTIAL_OPERATION_FILE,
  statedCredentialOperation,
} from '../../../../dist/secrets/operation/answer.js';
import { diagnosticFile } from '../run/run-evidence.mjs';
import { credentialFailure } from '../run/credential-outcome.mjs';

/** The run's JSON file `name` under the action's recordings, or null when the run wrote none. */
function readRunFile(runId, action, name) {
  const file = diagnosticFile(runId, `${action}/${name}`);
  if (!file) return null;
  try {
    return {
      path: file.path,
      value: JSON.parse(readFileSync(file.path, 'utf8')),
    };
  } catch (error) {
    throw new Error(
      `credential_operation_unreadable: ${file.path} is not JSON: ${error.message}`,
      { cause: error },
    );
  }
}

/** Whether the run's Skarbiec capture is the one this request asked for. */
function capturedThisRequest(capture, request) {
  if (!capture) return false;
  const { value } = capture;
  return (
    value.requestId === request.request_id &&
    value.operation === request.operation &&
    value.vaultItemId === request.credential_id &&
    value.field === request.field &&
    (!request.signup_origin || value.sourceOrigin === request.signup_origin)
  );
}

/** The reply of a run that stated no answer, from its exit and its capture. */
function observedAnswer(runId, action, out, captured) {
  const completed = out.ok && captured;
  const exit =
    out.exitCode === null
      ? 'without a child exit code'
      : `with exit code ${out.exitCode}`;
  const observed = out.ok
    ? captured
      ? 'Skarbiec acknowledged the capture this request asked for'
      : 'Skarbiec holds no capture matching this request'
    : `the run failed (${credentialFailure(out).code})`;
  return {
    status: completed ? 'operation_completed' : 'operation_failed',
    providerEffect: captured ? 'changed' : 'unknown',
    code: completed
      ? 'WELES_CREDENTIAL_CAPTURED'
      : 'WELES_CREDENTIAL_RESULT_UNSTATED',
    message: `Weles ${action} run ${runId} ended ${exit} and stated no credential_operation in ${CREDENTIAL_OPERATION_FILE}; ${observed}`,
  };
}

export function finishedCredentialReply(record, action, out) {
  const runId = record.reply.actionLogId;
  const statement = readRunFile(runId, action, CREDENTIAL_OPERATION_FILE);
  const captured = capturedThisRequest(
    readRunFile(runId, action, 'credential_capture.json'),
    record.request,
  );
  const answer = statement
    ? statedCredentialOperation(statement.value, statement.path)
    : observedAnswer(runId, action, out, captured);
  return credentialResponse(
    {
      ...answer,
      operation: record.request.operation,
      provider: record.request.provider,
      vaultItemId: record.request.credential_id,
      actionLogId: runId,
      executionHost: hostname(),
      message: answer.message.replace(/\p{Cc}/gu, ' '),
    },
    record.request,
  );
}
