// Types for `request.mjs`. The implementation is plain ESM because the
// trajectories that open requests are plain ESM; the CLI and the desktop
// bridge are TypeScript, so the shape is declared here once.

export declare const OPERATOR_REQUEST_SCHEMA: 'wisent.weles-operator-request.v1';

export type OperatorPageAttempt = {
  at: string;
  ok: boolean;
  channel: string;
  detail: string;
};

export type OperatorRequest = {
  schema: string;
  id: string;
  kind: string;
  account: string;
  instruction: string;
  run: string;
  run_pid?: number;
  host: string;
  opened_at: string;
  closed_at: string | null;
  approved: boolean | null;
  waited_seconds: number | null;
  outcome_detail: string;
  pages: OperatorPageAttempt[];
};

export type OpenOperatorRequestInput = {
  kind: string;
  account: string;
  instruction: string;
  run: string;
  runPid?: number;
};

export declare function operatorRequestDir(): string;
export declare function pageBody(request: OperatorRequest): string;
export declare function pageSubject(request: OperatorRequest): string;
export declare function openOperatorRequest(input: OpenOperatorRequestInput): OperatorRequest;
export declare function closeOperatorRequest(id: string, approved: boolean, detail: string): OperatorRequest;
export declare function reopenOperatorRequest(id: string): OperatorRequest;
export declare function readOperatorRequest(id: string): OperatorRequest;
export declare function isOpen(request: OperatorRequest): boolean;
export declare function isAbandoned(request: OperatorRequest): boolean | null;
export declare function listOperatorRequests(options?: { limit?: number; openOnly?: boolean }): OperatorRequest[];
