// Every value the version capture could not read is recorded with the field
// it was for, the operation that failed and what that operation reported, so
// a row's missing version field always says why it is missing.
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { describeError } from '../../_shared/error-chain/index.cjs';

// The package that supplied this module, not the caller's working directory.
// Both src/diagnostics/versions and dist/diagnostics/versions have this depth.
export const WELES_ROOT = join(__dirname, '..', '..', '..');

export type CaptureFailure = {
  field: string;
  operation: string;
  message: string;
  code?: string | number;
  exit_status?: number;
  stderr?: string;
};

/** The failures of this process's one-time captures; each row copies them. */
export const captureFailures: CaptureFailure[] = [];

type ProcessError = Error & {
  code?: string | number;
  status?: number;
  stderr?: string | Buffer;
};

export function captureFailure(
  field: string,
  operation: string,
  error: unknown,
): CaptureFailure {
  const failure: CaptureFailure = {
    field,
    operation,
    message: describeError(error),
  };
  if (!(error instanceof Error)) return failure;
  const { code, status, stderr } = error as ProcessError;
  if (code !== undefined) failure.code = code;
  if (status !== undefined) failure.exit_status = status;
  if (stderr !== undefined) failure.stderr = stderr.toString().trim();
  return failure;
}

/**
 * `cmd`'s trimmed output, run in the Weles package. A failed command is
 * recorded in `failures` against `field` and leaves the value absent.
 */
export function safeExec(
  cmd: string,
  field: string,
  failures: CaptureFailure[] = captureFailures,
): string | undefined {
  let output: string | undefined;
  try {
    output = execSync(cmd, {
      cwd: WELES_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    failures.push(captureFailure(field, `${cmd} (cwd=${WELES_ROOT})`, error));
  }
  return output;
}
