// Types for `index.cjs`. The implementation is CommonJS so the worker's
// ECMAScript modules and the TypeScript compiled to CommonJS share it; the
// shape is declared here once.
import type { Code, Envelope, GenericSentence } from '@wisent/errors' with {
  'resolution-mode': 'import',
};

/** One way an operation can fail, as `declare` freezes it. */
export type Cause = Readonly<{
  area: string;
  id: string;
  code: Code;
  usage: boolean;
  /** The `error` code an HTTP answer carries, where it differs from the id. */
  wire?: string;
  /** The HTTP status, where it differs from the code's. */
  status?: number;
  failed: string;
  cause: string;
  observed: string;
  remedy: string;
  test: string;
}>;

export type Operation = Readonly<{
  id: string;
  command: string;
  summary: string;
  causes: readonly Cause[];
}>;

export type Values = Readonly<Record<string, string | number>>;

export type Answer = {
  error: string;
  message: string;
  cause: string;
  remedy: string;
  retryable: boolean;
  docs: string;
};

export declare const DOCS: string;
export declare const FAILURE_EXIT: number;

export declare class DeclaredError extends Error {
  constructor(cause: Cause, values?: Values, options?: ErrorOptions);
  readonly declared: Cause;
  readonly values: Values;
  readonly remedy: string;
  readonly code: string;
  readonly status: number;
  readonly exitCode: number;
  naming(values: Values): DeclaredError;
  answer(): Answer;
  explanation(): string;
  envelope(service: string): Envelope;
}

export declare function declare(
  area: string,
  fields: Omit<Cause, 'area' | 'usage'> & { usage?: boolean },
): Cause;
export declare function catalogue(
  operation: Operation,
): Record<string, unknown>;
export declare function docOf(cause: Cause): string;
export declare function exitCode(cause: Cause): number;
export declare function fill(template: string, values: Values): string;
export declare function messageOf(error: unknown): string;
/** The generic sentences inside the string literals of one source line (wisent-errors' rule). */
export declare function genericSentencesIn(
  line: string,
  singleQuoted: boolean,
): GenericSentence[];
export declare function problems(operation: Operation): string[];
export declare function sentence(cause: Cause, values: Values): string;
