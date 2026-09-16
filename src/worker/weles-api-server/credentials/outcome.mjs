import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { credentialResponse } from '@wisent-ai/weles-client/credential/response';
import { diagnosticFile } from '../run/run-evidence.mjs';
import { credentialFailure } from '../run/credential-outcome.mjs';

function readOutcome(runId, action, name) {
  const file = diagnosticFile(runId, `${action}/${name}`);
  if (!file) return null;
  if (file.stat.size > 64 * 1024) throw new Error('credential outcome exceeded size limit');
  const value = JSON.parse(readFileSync(file.path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('credential outcome is not an object');
  }
  return value;
}

export function finishedCredentialReply(record, action, out) {
  const runId = record.reply.actionLogId;
  const service = readOutcome(runId, action, 'service_action_result.json');
  const review = readOutcome(runId, action, 'pending_review.json');
  const capture = readOutcome(runId, action, 'credential_capture.json');
  const captured = capture && capture.requestId === record.request.request_id
    && capture.operation === record.request.operation && capture.vaultItemId === record.request.credential_id
    && capture.field === record.request.field
    && (!record.request.signup_origin || capture.sourceOrigin === record.request.signup_origin);
  const reported = service?.credential_operation ?? review
    ?? out.result?.service_action?.credential_operation ?? out.result?.pending_review
    ?? (out.result?.status ? out.result : null);
  const failure = out.ok ? null : credentialFailure(out);
  const completed = out.ok && captured;
  const message = reported?.message ?? reported?.reason
    ?? `Weles ${action} run ${runId} exited ${out.exitCode ?? 'without a child exit code'}; ${failure?.code ?? (completed ? 'Skarbiec capture acknowledged' : 'no matching Skarbiec capture evidence')}`;
  const status = reported?.status ?? (completed ? 'operation_completed' : 'operation_failed');
  return credentialResponse({
    operation: record.request.operation,
    provider: record.request.provider,
    vaultItemId: record.request.credential_id,
    ...reported,
    status,
    actionLogId: runId,
    executionHost: hostname(),
    providerEffect: reported?.providerEffect ?? (captured ? 'changed' : 'unknown'),
    code: reported?.code ?? (completed ? 'WELES_CREDENTIAL_CAPTURED' : 'WELES_CREDENTIAL_RESULT_UNCONFIRMED'),
    message: String(message).replace(/\p{Cc}/gu, ' ').slice(0, 512),
  }, record.request);
}
