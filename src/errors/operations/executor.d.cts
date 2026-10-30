// Types for `executor.cjs`.
import type { Cause } from '../index.cjs';

export declare const causes: Readonly<{
  STADO_UNAVAILABLE: Cause;
  STADO_REFUSED: Cause;
  STADO_ANSWER: Cause;
  ROUTE_UNRESOLVED: Cause;
  VARIABLE_MISSING: Cause;
  VARIABLE_INVALID: Cause;
  ENDPOINT_INVALID: Cause;
  ENDPOINT_INSECURE: Cause;
  UNREACHABLE: Cause;
  UNAUTHORIZED: Cause;
  REFUSED: Cause;
  NOT_FOUND: Cause;
  FAILED: Cause;
  ANSWER_NOT_JSON: Cause;
}>;
