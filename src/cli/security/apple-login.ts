// weles login --provider apple: one authorized Apple account sign-in on the
// execution host. The command is named for what it does; the provider whose
// account it signs in to is an argument, and apple is the one implemented.
// Reading a run back needs only its id.
//
// apple_login starts only with a guard id, the execution host and agent, and
// three one-use capabilities Stado mints on that host; this command issues
// them and starts the run through the managed executor's POST /run (detached).
// --run reads the run back.

import type { ParsedCli } from '../../cli.js';
import { DeclaredError } from '../../errors/index.cjs';
import { causes } from '../../errors/operations/sign-in.cjs';
import { printAnswer } from '../usage.js';
import {
  issueAppleAuthorization,
  readAppleRun,
  startAppleRun,
} from '../../runtime/api/apple-runs.js';

const CONFIRMATION_PHRASE = 'AUTHORIZE ONE APPLE LOGIN';
// The Skarbiec role the Apple account plays (tag stado:role:<role>); the
// worker selects the item, so no command names one.
const STANDARD_ACCOUNT_ROLE = 'apple-account-holder';
const ROLE = /^[a-z0-9][a-z0-9-]{0,126}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const STANDARD_AGENT = 'weles-worker';
const START_OPTIONS = [
  'provider',
  'account-role',
  'confirm',
  'execution-host',
  'execution-agent',
  'expires-in-minutes',
];
const PROVIDER = 'apple';

/** What each option's value is, as a refusal of a missing one names it. */
const MEANINGS: Readonly<Record<string, string>> = Object.freeze({
  'account-role': 'skarbiec-role',
  confirm: CONFIRMATION_PHRASE,
  'execution-host': 'stado-host',
  'execution-agent': 'agent',
  'expires-in-minutes': 'minutes',
  run: 'run-id',
});

function missingValue(key: string, value: unknown): DeclaredError {
  return new DeclaredError(causes.OPTION_VALUE, {
    option: key,
    value: value === undefined ? 'not given' : 'given without a value',
    meaning: MEANINGS[key],
  });
}

function optional(parsed: ParsedCli, key: string, standard: string): string {
  const value = parsed.options[key];
  if (value === undefined) return standard;
  if (typeof value !== 'string' || !value) throw missingValue(key, value);
  return value;
}

function required(parsed: ParsedCli, key: string): string {
  const value = parsed.options[key];
  if (typeof value !== 'string' || !value) throw missingValue(key, value);
  return value;
}

async function start(parsed: ParsedCli): Promise<Record<string, unknown>> {
  const accountRole = optional(parsed, 'account-role', STANDARD_ACCOUNT_ROLE);
  const executionHost = required(parsed, 'execution-host');
  const executionAgent = optional(parsed, 'execution-agent', STANDARD_AGENT);
  // How long the one-use capabilities live is the operator's to say for each
  // run; no lifetime is chosen here.
  const expiry = required(parsed, 'expires-in-minutes');
  const expiryMinutes = Number(expiry);
  if (!ROLE.test(accountRole))
    throw new DeclaredError(causes.ROLE, {
      value: JSON.stringify(accountRole),
      standard: STANDARD_ACCOUNT_ROLE,
    });
  const confirmation = required(parsed, 'confirm');
  if (confirmation !== CONFIRMATION_PHRASE)
    throw new DeclaredError(causes.CONFIRMATION, {
      value: JSON.stringify(confirmation),
      phrase: CONFIRMATION_PHRASE,
    });
  if (!HOST.test(executionHost))
    throw new DeclaredError(causes.HOST, {
      value: JSON.stringify(executionHost),
    });
  if (!Number.isInteger(expiryMinutes) || expiryMinutes <= 0)
    throw new DeclaredError(causes.EXPIRY, { value: JSON.stringify(expiry) });
  const authorization = await issueAppleAuthorization(
    accountRole,
    executionHost,
    executionAgent,
    expiryMinutes,
  );
  const runId = await startAppleRun('apple_login', authorization, {});
  return {
    status: 'running',
    run: runId,
    guard_id: authorization.guardId,
    account_role: accountRole,
    execution_host: executionHost,
    capabilities_expire_in_minutes: expiryMinutes,
    next: `weles login --run ${runId}`,
  };
}

export async function runAppleLogin(parsed: ParsedCli): Promise<void> {
  const keys = Object.keys(parsed.options).filter((key) => key !== 'json');
  const reading = keys.includes('run');
  const allowed = reading ? ['run'] : START_OPTIONS;
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (parsed.positional.length || unknown.length) {
    throw new DeclaredError(causes.OPTIONS_UNKNOWN, {
      start: START_OPTIONS.map((key) => `--${key}`).join(' '),
      given: [...parsed.positional, ...unknown.map((key) => `--${key}`)].join(
        ' ',
      ),
    });
  }
  const json = parsed.options.json === true;
  if (!reading) {
    if (parsed.options.provider !== PROVIDER) {
      throw new DeclaredError(causes.PROVIDER, {
        provider:
          typeof parsed.options.provider === 'string'
            ? JSON.stringify(parsed.options.provider)
            : 'not given',
        providers: PROVIDER,
      });
    }
    printAnswer(await start(parsed), json);
    return;
  }
  if (typeof parsed.options.run !== 'string' || !parsed.options.run.trim())
    throw new DeclaredError(causes.RUN_ID_MISSING);
  const run = await readAppleRun(parsed.options.run);
  printAnswer(
    { status: run.status, run: run.id, ok: run.ok, error: run.error },
    json,
  );
  if (run.ok === false) process.exitCode = 1;
}
