// weles apple-login: one authorized Apple account sign-in on the execution host.
//
// apple_login starts only with a guard id, the execution host and agent, and
// three one-use capabilities Stado mints on that host; this command issues
// them and starts the run through the managed executor's POST /run (detached).
// --run reads the run back.

import type { ParsedCli } from '../../cli.js';
import { UsageError } from '../usage.js';
import { issueAppleAuthorization, readAppleRun, startAppleRun } from '../../runtime/api/apple-runs.js';

const CONFIRMATION_PHRASE = 'AUTHORIZE ONE APPLE LOGIN';
// The Skarbiec role the Apple account plays (tag stado:role:<role>); the
// worker selects the item, so no command names one.
const STANDARD_ACCOUNT_ROLE = 'apple-account-holder';
const ROLE = /^[a-z0-9][a-z0-9-]{0,126}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const STANDARD_AGENT = 'weles-worker';
const STANDARD_EXPIRY_MINUTES = '10';
const MIN_EXPIRY_MINUTES = 1;
const MAX_EXPIRY_MINUTES = 60;
const START_OPTIONS = ['account-role', 'confirm', 'execution-host', 'execution-agent', 'expires-in-minutes'];

function optional(parsed: ParsedCli, key: string, standard: string): string {
  const value = parsed.options[key];
  if (value === undefined) return standard;
  if (typeof value !== 'string' || !value) throw new Error(`--${key} needs a value`);
  return value;
}

function required(parsed: ParsedCli, key: string): string {
  const value = parsed.options[key];
  if (typeof value !== 'string' || !value) throw new Error(`--${key} is required`);
  return value;
}

async function start(parsed: ParsedCli): Promise<Record<string, unknown>> {
  const accountRole = optional(parsed, 'account-role', STANDARD_ACCOUNT_ROLE);
  const executionHost = required(parsed, 'execution-host');
  const executionAgent = optional(parsed, 'execution-agent', STANDARD_AGENT);
  const expiryMinutes = Number(optional(parsed, 'expires-in-minutes', STANDARD_EXPIRY_MINUTES));
  if (!ROLE.test(accountRole)) throw new Error('--account-role must be a Skarbiec role (lowercase letters, digits and hyphens)');
  if (required(parsed, 'confirm') !== CONFIRMATION_PHRASE) throw new Error(`--confirm must exactly equal "${CONFIRMATION_PHRASE}"`);
  if (!HOST.test(executionHost)) throw new Error('--execution-host must name the Stado host that runs the browser');
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < MIN_EXPIRY_MINUTES || expiryMinutes > MAX_EXPIRY_MINUTES) {
    throw new Error(`--expires-in-minutes must be a whole number between ${MIN_EXPIRY_MINUTES} and ${MAX_EXPIRY_MINUTES}`);
  }
  const authorization = await issueAppleAuthorization(accountRole, executionHost, executionAgent, expiryMinutes);
  const runId = await startAppleRun('apple_login', authorization, {});
  return {
    status: 'running',
    run: runId,
    guard_id: authorization.guardId,
    account_role: accountRole,
    execution_host: executionHost,
    capabilities_expire_in_minutes: expiryMinutes,
    next: `weles apple-login --run ${runId}`,
  };
}

export async function runAppleLogin(parsed: ParsedCli): Promise<void> {
  const keys = Object.keys(parsed.options);
  const reading = keys.includes('run');
  const allowed = reading ? ['run'] : START_OPTIONS;
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (parsed.positional.length || unknown.length) {
    throw new UsageError(`apple-login takes either ${START_OPTIONS.map((key) => `--${key}`).join(' ')} or --run <run-id>; got ${[...parsed.positional, ...unknown.map((key) => `--${key}`)].join(' ')}`);
  }
  if (!reading) {
    process.stdout.write(`${JSON.stringify(await start(parsed))}\n`);
    return;
  }
  const run = await readAppleRun(required(parsed, 'run'));
  process.stdout.write(`${JSON.stringify({ status: run.status, run: run.id, ok: run.ok, error: run.error })}\n`);
  if (run.ok === false) process.exitCode = 1;
}
