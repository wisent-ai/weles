export const STATUS_SCHEMA = 'weles.task-status.v1';
// The exact status vocabulary this service can put on the wire. `queued` and
// `running` are the only nonterminal states it assigns; `succeeded`, `failed`
// and `cancelled` are the only ones terminalCompletion can produce, and
// receiptFor signs `succeeded` as outcome `completed`. There is no `leased`,
// `pending_review` or `rejected` status here: a submission this service
// refuses is an HTTP PublicTaskError with no task and no receipt, never a
// rejected outcome.
export const TERMINAL_STATUSES = Object.freeze({ succeeded: true, failed: true, cancelled: true });
const NONTERMINAL_STATUSES = Object.freeze({ queued: true, running: true });

export class PublicTaskError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export class EvidenceRetentionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function publicStatus(task, dispatcher) {
  const terminal = Object.hasOwn(TERMINAL_STATUSES, task.status);
  // The wire vocabulary is exactly TERMINAL_STATUSES plus NONTERMINAL_STATUSES,
  // and every verifier downstream carries a matching status map. A new status
  // introduced here without teaching those maps would reach Spis as an
  // unsupported status mid-crawl, so it fails at this boundary instead.
  if (!terminal && !Object.hasOwn(NONTERMINAL_STATUSES, task.status)) {
    throw new Error(`public task status is outside the declared wire vocabulary: ${task.status}`);
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

export function publicTaskErrorResponse(error) {
  if (error instanceof PublicTaskError) {
    return { status: error.status, payload: { error: error.code, message: error.message } };
  }
  return null;
}
