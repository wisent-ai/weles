// Types for `signin.cjs`.
import type { Cause, Operation } from '../index.cjs';

export declare const SIGN_IN: Operation;
export declare const causes: Readonly<{
  OPTIONS_UNKNOWN: Cause;
  PROVIDER: Cause;
  OPTION_VALUE: Cause;
  ROLE: Cause;
  CONFIRMATION: Cause;
  HOST: Cause;
  EXPIRY: Cause;
  RUN_ID_MISSING: Cause;
  INSTALL_INCOMPLETE: Cause;
  CAPABILITIES_NOT_ISSUED: Cause;
  RUN_NOT_STARTED: Cause;
  RUN_RESULT_UNREADABLE: Cause;
  CHALLENGE_NOT_CONFIRMED: Cause;
}>;
