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
// The address comes from the service declaration (Stado's catalog writes
// WELES_API_HOST and WELES_API_PORT into the unit's environment); none is
// built in, so a host is never exposed on an interface or port nobody chose.
function declaredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: set it to the address the Weles service declaration assigns`);
  return value;
}
export const HOST = declaredAddress('WELES_API_HOST');
export const PORT = Number(declaredAddress('WELES_API_PORT'));
export const TOKEN = process.env.WELES_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || '';
export const BRAMA_REAUTH_TOKEN = process.env.BRAMA_WELES_REAUTH_TOKEN || '';
export const ALLOW_UNAUTH = process.env.WELES_API_ALLOW_UNAUTH === '1';
export const ALLOW_RAW_CREDS = (process.env.WELES_API_ALLOW_RAW_CREDS ?? '1') === '1';
export const PUBLIC_TASK_CONCURRENCY = boundedIntegerEnvironment(
  'WELES_PUBLIC_TASK_CONCURRENCY',
  1,
  1,
  1,
);
export const RUN_DEDUPLICATION_TTL_MS = Number(process.env.WELES_API_RUN_DEDUPLICATION_TTL_MS || 60_000);
