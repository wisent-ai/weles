// How `weles login` fails: every cause from the command line to the run's
// record, declared once. Reaching Stado and the executor is declared in
// ./executor.cjs and listed here too, since a sign-in meets every one of them.
'use strict';

const { declare } = require('../index.cjs');
const executor = require('./executor.cjs').causes;

const TEST = 'tests/sign-in/failures.mjs';
const cause = (fields) => declare('sign-in', fields);
const usage = (fields) => cause({ usage: true, code: 'refused', ...fields });

const OPTIONS_UNKNOWN = usage({
  id: 'options-unknown',
  failed: 'reading the weles login command line',
  cause:
    'it holds a word or option login does not take: login either starts a sign-in with {start} or reads one back with --run <run-id>',
  observed: 'not taken: {given}',
  remedy: 'run `weles login --help` for the two forms and give one of them',
  test: `${TEST}::login_refuses_an_option_it_does_not_take`,
});

const PROVIDER = usage({
  id: 'provider-unsupported',
  failed: 'choosing the identity provider to sign in to',
  cause: '--provider is missing or names a provider Weles has no sign-in for',
  observed: '--provider: {provider}; providers Weles signs in to: {providers}',
  remedy: 'give --provider {providers}',
  test: `${TEST}::login_refuses_a_provider_it_cannot_sign_in_to`,
});

const OPTION_VALUE = usage({
  id: 'option-value-missing',
  failed: 'reading --{option}',
  cause: '--{option} is required and was given no value',
  observed: '--{option}: {value}',
  remedy: 'give --{option} <{meaning}>',
  test: `${TEST}::login_refuses_a_missing_execution_host`,
});

const ROLE = usage({
  id: 'account-role-invalid',
  failed: 'reading --account-role',
  cause:
    'a Skarbiec role is lowercase letters, digits and hyphens, starting with a letter or digit, at most 127 characters',
  observed: '--account-role: {value}',
  remedy:
    'give the role the Apple account plays in Skarbiec (the item tagged stado:role:<role>), or leave it out for {standard}',
  test: `${TEST}::login_refuses_an_account_role_that_is_not_a_role`,
});

const CONFIRMATION = usage({
  id: 'confirmation-mismatch',
  failed: 'authorizing one Apple sign-in',
  cause:
    "the operator's confirmation is not the exact phrase, so no authorization is issued",
  observed: '--confirm: {value}',
  remedy: 'give --confirm "{phrase}" exactly, in capitals',
  test: `${TEST}::login_refuses_a_confirmation_that_is_not_the_phrase`,
});

const HOST = usage({
  id: 'execution-host-invalid',
  failed: 'reading --execution-host',
  cause:
    'a Stado host name is letters, digits, ., _ and -, starting with a letter or digit',
  observed: '--execution-host: {value}',
  remedy:
    'give the registry target that runs the browser, as `stado registry host list` names it',
  test: `${TEST}::login_refuses_an_execution_host_that_is_not_a_host_name`,
});

const EXPIRY = usage({
  id: 'expiry-invalid',
  failed: 'reading --expires-in-minutes',
  cause:
    'the lifetime of the one-use capabilities is a positive whole number of minutes',
  observed: '--expires-in-minutes: {value}',
  remedy:
    'give --expires-in-minutes <n>, the minutes the sign-in may take, such as 15',
  test: `${TEST}::login_refuses_an_expiry_that_is_not_whole_minutes`,
});

const RUN_ID_MISSING = usage({
  id: 'run-id-missing',
  failed: 'reading a sign-in run back',
  cause: '--run names no run id',
  observed: '--run: no value',
  remedy: 'give --run <run-id>, the run the start answered',
  test: `${TEST}::login_refuses_run_without_an_id`,
});

const INSTALL_INCOMPLETE = cause({
  id: 'install-incomplete',
  code: 'config',
  failed: 'loading the Apple capability issuer {module}',
  cause:
    'the installed Weles lacks the module that asks Stado for the capabilities: the install is incomplete or was built without src/auth',
  observed: '{answer}',
  remedy:
    'reinstall the Weles release through Stado (its payload carries src/auth), then run again',
  test: `${TEST}::login_from_an_install_without_the_issuer_names_the_module`,
});

const CAPABILITIES_NOT_ISSUED = cause({
  id: 'capabilities-not-issued',
  code: 'refused',
  failed: 'issuing the Apple sign-in capabilities on {host}',
  cause:
    'Stado answered, but not with capabilities issued for that host: it issued them for another target, or reported a status other than issued',
  observed: '{answer}',
  remedy:
    "run `stado identity issue --provider apple --target {host} ...` by hand to see what it answers, and correct the target or Stado's identity configuration",
  test: `${TEST}::login_whose_capabilities_name_another_host_is_refused`,
});

const RUN_NOT_STARTED = cause({
  id: 'run-not-started',
  code: 'refused',
  failed: 'starting {action} on the executor',
  cause:
    'the executor answered without starting a detached run: it refused the action or its parameters',
  observed: 'the executor answered: {answer}',
  remedy:
    "read the executor's answer above; `weles runs list` shows what it runs now",
  test: `${TEST}::login_whose_run_the_executor_does_not_start_quotes_it`,
});

const RUN_RESULT_UNREADABLE = cause({
  id: 'run-result-unreadable',
  code: 'refused',
  failed: 'reading the result of sign-in run {run}',
  cause:
    "the run's run-result.json carries no status: it was written by another program, or is not a run result",
  observed: '{answer}',
  remedy:
    "read the run's files with `weles runs show {run}` to see what it wrote",
  test: `${TEST}::login_reading_a_result_without_a_status_names_it`,
});

const CHALLENGE_NOT_CONFIRMED = cause({
  id: 'challenge-not-confirmed',
  code: 'refused',
  failed: 'relaying the Apple two-factor challenge (stado {command})',
  cause:
    'Stado answered without confirming the challenge as {expected} with its holder, user and destination',
  observed: '{answer}',
  remedy:
    'run the same stado identity relay command by hand on the execution host, and correct the session or identity it names',
  test: `${TEST}::relay_whose_stado_answer_lacks_the_holder_is_refused`,
});

const SIGN_IN = Object.freeze({
  id: 'sign-in.apple',
  command: 'weles login --provider apple',
  summary:
    'Sign one Skarbiec Apple account in on a Stado host: the operator confirms in words, Stado issues three one-use capabilities on the execution host, the executor starts the run, and --run reads it back.',
  causes: [
    OPTIONS_UNKNOWN,
    PROVIDER,
    OPTION_VALUE,
    ROLE,
    CONFIRMATION,
    HOST,
    EXPIRY,
    RUN_ID_MISSING,
    INSTALL_INCOMPLETE,
    executor.STADO_UNAVAILABLE,
    executor.STADO_REFUSED,
    executor.STADO_ANSWER,
    CAPABILITIES_NOT_ISSUED,
    executor.ROUTE_UNRESOLVED,
    executor.VARIABLE_MISSING,
    executor.VARIABLE_INVALID,
    executor.ENDPOINT_INVALID,
    executor.ENDPOINT_INSECURE,
    executor.UNREACHABLE,
    executor.UNAUTHORIZED,
    executor.REFUSED,
    executor.NOT_FOUND,
    executor.FAILED,
    executor.ANSWER_NOT_JSON,
    RUN_NOT_STARTED,
    RUN_RESULT_UNREADABLE,
    CHALLENGE_NOT_CONFIRMED,
  ],
});

module.exports = {
  SIGN_IN,
  causes: Object.freeze({
    OPTIONS_UNKNOWN,
    PROVIDER,
    OPTION_VALUE,
    ROLE,
    CONFIRMATION,
    HOST,
    EXPIRY,
    RUN_ID_MISSING,
    INSTALL_INCOMPLETE,
    CAPABILITIES_NOT_ISSUED,
    RUN_NOT_STARTED,
    RUN_RESULT_UNREADABLE,
    CHALLENGE_NOT_CONFIRMED,
  }),
};
