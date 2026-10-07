// Types for `request.mjs`. The implementation is plain ESM because the
// trajectories that open requests are plain ESM; the worker's run views are
// TypeScript, so the shape is declared here once.

export declare const OPERATOR_REQUEST_SCHEMA: 'wisent.weles-operator-request.v1';

export type OperatorPageAttempt = {
  at: string;
  ok: boolean;
  channel: string;
  detail: string;
};

export type OperatorAnswer = 'ready' | 'approved' | 'not_received';

export type OperatorAnswerRecord = {
  at: string;
  answer: OperatorAnswer;
  detail: string;
};

export type OperatorNote = {
  at: string;
  note: string;
};

export type OperatorRequest = {
  schema: string;
  id: string;
  kind: string;
  account: string;
  instruction: string;
  run: string;
  /** The Weles runs waiting on this request; empty for a run no worker started. */
  run_ids?: string[];
  run_pid?: number;
  host: string;
  opened_at: string;
  closed_at: string | null;
  approved: boolean | null;
  waited_seconds: number | null;
  outcome_detail: string;
  pages: OperatorPageAttempt[];
  /** What the operator told the waiting run, oldest first. */
  answers?: OperatorAnswerRecord[];
  /** What the waiting run did about an answer or saw on the page. */
  notes?: OperatorNote[];
};

export type OpenOperatorRequestInput = {
  kind: string;
  account: string;
  instruction: string;
  run: string;
};

export declare function operatorRequestDir(): string;
export declare function pageBody(request: OperatorRequest): string;
export declare function pageSubject(request: OperatorRequest): string;
export declare function openOperatorRequest(
  input: OpenOperatorRequestInput,
): OperatorRequest;
export declare function closeOperatorRequest(
  id: string,
  approved: boolean,
  detail: string,
): OperatorRequest;
export declare function openRequestOfRun(runId: string): OperatorRequest | null;
export declare function readOperatorRequest(id: string): OperatorRequest;
export declare function isOpen(request: OperatorRequest): boolean;
export declare function isAbandoned(request: OperatorRequest): boolean | null;
export declare function listOperatorRequests(options?: {
  limit?: number;
  openOnly?: boolean;
}): OperatorRequest[];
export declare const OPERATOR_ANSWERS: readonly OperatorAnswer[];
export declare function answerOperatorRequest(
  id: string,
  answer: OperatorAnswer,
  detail: string,
): OperatorRequest;
export declare function noteOperatorRequest(
  id: string,
  note: string,
): OperatorRequest;
export declare function repageOperatorRequest(
  id: string,
  why: string,
): OperatorRequest;
export declare function nextOperatorAnswer(
  id: string,
  seen: number,
  signal?: AbortSignal,
): Promise<OperatorAnswerRecord | null>;
