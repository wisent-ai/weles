// Types for `browser.cjs`.
import type { Cause, DeclaredError, Operation, Values } from '../index.cjs';

export declare const SESSION: Operation;
export declare function engineCause(
  error: unknown,
  values: Values,
): DeclaredError;
export declare const causes: Readonly<{
  REQUEST_NOT_JSON: Cause;
  METHOD_UNKNOWN: Cause;
  CALL_WITHOUT_PARAMS: Cause;
  TOOL_UNKNOWN: Cause;
  ARGUMENT_MISSING: Cause;
  ARGUMENT_TYPE: Cause;
  ENGINE_UNKNOWN: Cause;
  OS_UNKNOWN: Cause;
  BROWSER_ID_UNKNOWN: Cause;
  PAGE_ID_UNKNOWN: Cause;
  RELEASE_MISSING: Cause;
  LAUNCH_FAILED: Cause;
  STORAGE_UNREADABLE: Cause;
  STORAGE_NOT_STATE: Cause;
}>;
