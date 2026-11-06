// How an operator command fails to reach the managed Weles executor: every
// cause between the shell and the executor's answer, declared once. Every
// command that talks to the executor (login, certificate, runs, worker,
// security, password) meets these; each lists them in its own catalogue.
'use strict';

const { declare } = require('../index.cjs');

const TEST = 'tests/sign-in/failures.mjs';
const cause = (fields) => declare('executor', fields);

const STADO_UNAVAILABLE = cause({
  id: 'stado-unavailable',
  code: 'config',
  failed: 'running `stado {command}`',
  cause:
    'the Stado program cannot be run: it is not installed where it is looked for, or it is not executable',
  observed: '{answer}',
  remedy:
    'install Stado (it places itself in ~/.stado/bin/stado), or name the program with WELES_STADO_BIN',
  test: `${TEST}::login_on_a_host_without_stado_names_where_it_looked`,
});

const STADO_REFUSED = cause({
  id: 'stado-refused',
  code: 'refused',
  failed: 'running `stado {command}`',
  cause:
    'Stado ran and refused the request; its own words below name what it refused and why',
  observed: 'stado exited {status}: {answer}',
  remedy:
    'run the same stado command by hand, correct what it names (a target the registry does not hold, a credential it does not have), then run again',
  test: `${TEST}::login_whose_capabilities_stado_refuses_quotes_stado`,
});

const STADO_ANSWER = cause({
  id: 'stado-answer-not-json',
  code: 'config',
  failed: 'reading what `stado {command}` answered',
  cause:
    'Stado exited 0 but did not print the JSON document --json promises: an older Stado, or something writing to its standard output',
  observed: '{answer}',
  remedy:
    'upgrade Stado to the version this Weles release names as minimum_stado_version, then run again',
  test: `${TEST}::login_through_a_stado_that_prints_no_json_names_it`,
});

const ROUTE_UNRESOLVED = cause({
  id: 'executor-route-unresolved',
  code: 'not_found',
  failed: 'finding the Weles executor',
  cause:
    'WELES_WORKER_API_BASE is not set and Stado places no weles-admission service this shell can connect to',
  observed: '{answer}',
  remedy:
    "set WELES_WORKER_API_BASE and WELES_WORKER_TOKEN to the executor's address and bearer, or run where `stado service directory connect weles-admission --consumer operator` answers a url",
  test: `${TEST}::login_reading_a_run_where_stado_places_no_executor`,
});

const VARIABLE_MISSING = cause({
  id: 'variable-missing',
  code: 'config',
  failed: 'reading {name}',
  cause: '{name} is not set, or set empty',
  observed: '{name}: not set',
  remedy:
    'set {name}; for the executor, WELES_WORKER_TOKEN is the token field of the item playing the echo-weles-api role (stado credentials get --role echo-weles-api --field token)',
  test: `${TEST}::login_with_an_executor_address_and_no_token_names_the_variable`,
});

const VARIABLE_INVALID = cause({
  id: 'variable-invalid',
  code: 'config',
  failed: 'reading {name}',
  cause:
    '{name} holds whitespace around it or a control character, so it cannot be sent in a header or a URL',
  observed:
    '{name} holds {length} characters, some of them whitespace or control characters',
  remedy: 'set {name} to the value alone, with no newline or space around it',
  test: `${TEST}::login_with_a_token_holding_a_newline_names_the_variable`,
});

const ENDPOINT_INVALID = cause({
  id: 'endpoint-invalid',
  code: 'config',
  failed: 'reading {name}',
  cause:
    '{name} is not of the form it must have: an address that does not parse or carries credentials, a query or a fragment, or an id that is not a UUID',
  observed: '{name}: {value}; {answer}',
  remedy:
    'set {name} to the base address alone (such as https://<host>), or to the organization UUID for WISENT_ORGANIZATION_ID',
  test: `${TEST}::login_with_an_executor_address_that_is_not_a_url_names_it`,
});

const ENDPOINT_INSECURE = cause({
  id: 'endpoint-insecure',
  code: 'refused',
  failed: 'reading {name}',
  cause:
    'it names a plain-HTTP address on another machine, over which the bearer would travel readable',
  observed: '{name}: {value}',
  remedy:
    'use https:// for a remote executor; plain http:// is accepted only for a loopback address',
  test: `${TEST}::login_with_a_remote_plain_http_executor_is_refused`,
});

const UNREACHABLE = cause({
  id: 'executor-unreachable',
  code: 'infra_down',
  failed: '{operation} at {endpoint}',
  cause:
    'no HTTP answer came back: the host has no DNS answer, nothing listens on that port, or the connection was cut',
  observed: '{answer}',
  remedy:
    'check the executor runs there (stado service status com.wisent.weles) and that the address is the one Stado places it at, then run again',
  test: `${TEST}::login_reading_a_run_from_a_closed_port_names_the_address`,
});

const UNAUTHORIZED = cause({
  id: 'executor-unauthorized',
  code: 'auth',
  failed: '{operation} at {endpoint}',
  cause:
    "the executor did not admit the bearer: it is another deployment's, or the item was rotated after it was read",
  observed: 'HTTP {status}: {answer}',
  remedy:
    'read the bearer again with `stado credentials get --role echo-weles-api --field token` (or correct WELES_WORKER_TOKEN) and run again',
  test: `${TEST}::login_reading_a_run_with_a_wrong_bearer_is_refused_by_the_executor`,
});

const REFUSED = cause({
  id: 'executor-refused',
  code: 'refused',
  failed: '{operation} at {endpoint}',
  cause:
    'the executor understood the request and refused it; its own words below say why',
  observed: 'HTTP {status}: {answer}',
  remedy: 'correct what the executor names and run again',
  test: `${TEST}::login_reading_a_run_id_the_executor_refuses_quotes_it`,
});

const NOT_FOUND = cause({
  id: 'executor-not-found',
  code: 'not_found',
  failed: '{operation} at {endpoint}',
  cause:
    'the executor holds nothing at that address: the run id belongs to another executor, the run left no result yet, or its record was removed',
  observed: 'HTTP {status}: {answer}',
  remedy:
    'check the run id against `weles runs list`, and read it from the executor that started it',
  test: `${TEST}::login_reading_a_run_the_executor_never_had_is_not_found`,
});

const FAILED = cause({
  id: 'executor-failed',
  code: 'infra_down',
  failed: '{operation} at {endpoint}',
  cause: 'the executor, or the forward in front of it, failed while answering',
  observed: 'HTTP {status}: {answer}',
  remedy:
    "read the executor's log (stado service logs com.wisent.weles) for the failure it names, then run again",
  test: `${TEST}::login_reading_a_run_through_a_failing_forward_quotes_its_answer`,
});

const ANSWER_NOT_JSON = cause({
  id: 'executor-answer-not-json',
  code: 'infra_down',
  failed: '{operation} at {endpoint}',
  cause:
    'what answered is not the executor: a forward, proxy or other service answered in plain text or HTML because it could not reach the executor',
  observed: '{answer}',
  remedy:
    'check the address names the executor and that the Stado forward to it is up (stado service directory connect weles-admission), then run again',
  test: `${TEST}::login_reading_a_run_through_a_page_that_is_not_the_executor_names_it`,
});

module.exports = {
  causes: Object.freeze({
    STADO_UNAVAILABLE,
    STADO_REFUSED,
    STADO_ANSWER,
    ROUTE_UNRESOLVED,
    VARIABLE_MISSING,
    VARIABLE_INVALID,
    ENDPOINT_INVALID,
    ENDPOINT_INSECURE,
    UNREACHABLE,
    UNAUTHORIZED,
    REFUSED,
    NOT_FOUND,
    FAILED,
    ANSWER_NOT_JSON,
  }),
};
