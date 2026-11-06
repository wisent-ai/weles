// Types for `admission.cjs`, read by the TypeScript that raises its causes.
import type { Cause, Operation } from '../index.cjs';

export declare const SUBMIT: Operation;
export declare const STATUS: Operation;
export declare const CANCEL: Operation;
export declare const causes: Readonly<Record<string, Cause>>;
