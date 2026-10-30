import { DeclaredError } from '../../errors/index.cjs';

export const STATUS_SCHEMA = 'weles.task-status.v1';
// The exact status vocabulary this service can put on the wire. `queued` and
// `running` are the only nonterminal states it assigns; `succeeded`, `failed`
// and `cancelled` are the only ones terminalCompletion can produce, and
// receiptFor signs `succeeded` as outcome `completed`. There is no `leased`,
// `pending_review` or `rejected` status here: a submission this service
// refuses is a declared cause of the admission catalogue
// (src/errors/operations/admission.cjs) answered over HTTP with no task and
// no receipt, never a rejected outcome.
export const TERMINAL_STATUSES = Object.freeze({
  succeeded: true,
  failed: true,
  cancelled: true,
});
export const NONTERMINAL_STATUSES = Object.freeze({
  queued: true,
  running: true,
});

export class EvidenceRetentionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function publicStatus(task, dispatcher, redact) {
  const terminal = Object.hasOwn(TERMINAL_STATUSES, task.status);
  // The wire vocabulary is exactly TERMINAL_STATUSES plus NONTERMINAL_STATUSES,
  // and every verifier downstream carries a matching status map. A new status
  // introduced here without teaching those maps would reach Spis as an
  // unsupported status mid-crawl, so it fails at this boundary instead.
  if (!terminal && !Object.hasOwn(NONTERMINAL_STATUSES, task.status)) {
    throw new Error(
      `public task status is outside the declared wire vocabulary: ${task.status}`,
    );
  }
  if (terminal && !task.receipt) {
    throw new Error('terminal public task has no retained-evidence receipt');
  }
  const base = {
    schema: STATUS_SCHEMA,
    taskId: task.id,
    organizationId: task.request.organizationId,
    origin: task.request.origin,
    action: task.request.action,
    status: task.status,
    serviceIdentity: task.serviceIdentity,
    dispatcher,
    evidenceError: task.evidenceError ? redact(task.evidenceError) : null,
    requestIdentity: {
      requestDigest: task.requestDigest,
      spisBinding: task.spisBinding,
    },
  };
  if (!terminal) return base;
  return {
    ...base,
    outcome: task.status === 'succeeded' ? 'completed' : task.status,
    resultDigest: task.resultDigest,
    receipt: task.receipt,
  };
}

/**
 * The HTTP answer of a declared refusal: its status, the code the answer has
 * always carried as `error`, the sentence naming what failed, why and what was
 * sent, the cause, the fix and whether retrying helps. Null for anything that
 * is not a declared cause, which the router answers as its own failure.
 */
export function publicTaskErrorResponse(error) {
  if (error instanceof DeclaredError)
    return { status: error.status, payload: error.answer() };
  return null;
}
