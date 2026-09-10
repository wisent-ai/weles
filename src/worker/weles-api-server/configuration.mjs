// What the environment configured this server to be, decided once at startup.
//
// Every value here is a boundary the whole process is held to: the address it
// binds, the credentials it accepts, the two directories its evidence lives in,
// and the limits a single request may not exceed. They are read in one place so
// that a misconfigured host fails while the port is still closed rather than on
// the request that first happens to cross a limit, and so that no route can
// invent a second reading of the same variable.
//
// Values that only one route understands are not here: the builder's bootstrap
// page and preamble belong to the builder route, and the Stado-published
// document paths belong to the module that reads those documents.

import { homedir } from 'node:os';
import { join } from 'node:path';

// Where a detached run records what happened, outside the repository so a
// rebuild cannot delete the answer.
export const RUN_RESULTS_DIR = join(homedir(), '.stado', 'weles-detached-runs');
export const RECORDINGS_ROOT = process.env.WELES_RECORDINGS_ROOT || join(homedir(), '.stado', 'var', 'weles', 'recordings');

function boundedIntegerEnvironment(name, declaredDefault, minimum, maximum) {
  const raw = String(process.env[name] ?? declaredDefault);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive base-10 integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
export const HOST = process.env.WELES_API_HOST || '127.0.0.1';
export const PORT = Number(process.env.WELES_API_PORT || 8788);
export const TOKEN = process.env.WELES_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || '';
export const BRAMA_REAUTH_TOKEN = process.env.BRAMA_WELES_REAUTH_TOKEN || '';
export const ALLOW_UNAUTH = process.env.WELES_API_ALLOW_UNAUTH === '1';
export const ALLOW_RAW_CREDS = (process.env.WELES_API_ALLOW_RAW_CREDS ?? '1') === '1';
export const TIMEOUT_MS = Number(process.env.WELES_API_TIMEOUT_MS || 15 * 60 * 1000);
export const PUBLIC_TASK_TIMEOUT_MS = boundedIntegerEnvironment(
  'WELES_PUBLIC_TASK_TIMEOUT_MS',
  2 * 60 * 60 * 1_000,
  15 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
);
export const PUBLIC_TASK_CONCURRENCY = boundedIntegerEnvironment(
  'WELES_PUBLIC_TASK_CONCURRENCY',
  1,
  1,
  1,
);
export const BODY_LIMIT = Number(process.env.WELES_API_BODY_LIMIT_BYTES || 256 * 1024);
export const RUN_DEDUPLICATION_TTL_MS = Number(process.env.WELES_API_RUN_DEDUPLICATION_TTL_MS || 60_000);
export const IMPORT_BODY_LIMIT = 2 * 1024 * 1024 + 4 * 1024;
