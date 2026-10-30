// Every way `weles login --provider apple` fails, provoked through the built
// CLI (dist/cli.js) as an operator runs it: one test per declared cause of
// sign-in.apple (src/errors/operations/sign-in.cjs and executor.cjs). Each
// failure must exit with the cause's status and print `weles: <what failed,
// why, observed>`, the fix, and the cause's id.
//
// The executor is the real Weles API server (src/worker/weles-api-server.mjs)
// on a loopback port with a sandboxed HOME; Stado is this host's `stado` run
// under that HOME, so it holds no registry and refuses as a host without one
// does. Where a cause needs an answer neither gives -- a forward that fails,
// a page that is not the executor, Stado answering JSON of another shape --
// a loopback HTTP server or a two-line program stands in for that one party,
// and the test says so. No Apple account is signed in to.
//
// Usage: node --test tests/sign-in/failures.mjs
// The report is build/real-tests/sign-in-failures/<uuid>/report.json.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  evidenceFor,
  freePort,
  publish,
  root,
  sandbox,
  sourceRevision,
  startServer,
} from '../admission/server.mjs';

const require = createRequire(import.meta.url);
const { SIGN_IN } = require('../../src/errors/operations/sign-in.cjs');
const { exitCode } = require('../../src/errors/index.cjs');

const evidence = evidenceFor('sign-in-failures');
const { report } = evidence;
report.scope = 'weles login failures, one per declared cause';

const box = sandbox(join(evidence.directory, 'sandbox'));
const work = join(evidence.directory, 'work');
const PHRASE = 'AUTHORIZE ONE APPLE LOGIN';
let server;
let stub;
let stubPort;
let stado;
const stubAnswers = new Map();

/** `program` on this host's PATH, or the refusal naming it. */
function onPath(program) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${program}`], {
    encoding: 'utf8',
  });
  assert.equal(
    found.status,
    0,
    `${program} is not on this host's PATH, so the causes it answers cannot be provoked`,
  );
  return found.stdout.trim();
}

/** A program printing `text` and exiting 0, standing in for Stado's answer. */
function answering(name, text) {
  const path = join(work, name);
  writeFileSync(path, `#!/bin/sh\ncat <<'ANSWER'\n${text}\nANSWER\n`, {
    mode: 0o755,
  });
  return path;
}

before(async () => {
  mkdirSync(work, { recursive: true });
  stado = onPath('stado');
  const port = await freePort();
  publish(box, port, sourceRevision());
  server = await startServer(box, port);
  // The loopback party standing in for a forward or another service.
  stub = createServer((request, response) => {
    const answer = stubAnswers.get(new URL(request.url, 'http://x').pathname);
    response.writeHead(answer.status, { 'content-type': answer.type });
    response.end(answer.body);
  });
  stubPort = await freePort();
  await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve));
});

after(async () => {
  if (server) report.server_output = await server.stop();
  if (stub) await new Promise((resolve) => stub.close(resolve));
  evidence.finish();
});

/**
 * `weles <args>` from `cli` with `environment` over a sandboxed HOME. Run
 * asynchronously: the executor and the loopback party answer from this
 * process's event loop, which a synchronous spawn would hold.
 */
async function weles(
  args,
  environment = {},
  cli = join(root, 'dist', 'cli.js'),
) {
  const env = {
    PATH: process.env.PATH,
    HOME: box.home,
    WELES_STADO_BIN: stado,
    ...environment,
  };
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name];
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve) => child.once('close', resolve));
  const result = { status, stdout, stderr };
  const run = {
    args,
    environment: Object.fromEntries(
      Object.entries(environment).map(([name, value]) => [
        name,
        /TOKEN/.test(name) ? '[withheld]' : value,
      ]),
    ),
    exit: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  report.operations.push(run);
  return run;
}

/** The run ended with declared cause `id`, its sentence holding every `names`. */
function failed(id, run, names = []) {
  const cause = SIGN_IN.causes.find((entry) => entry.id === id);
  assert.ok(cause, `sign-in.apple declares ${id}`);
  report.cases.push({ cause: id, run });
  assert.equal(run.exit, exitCode(cause), run.stderr);
  assert.match(run.stderr, /^weles: .+; observed: /m, run.stderr);
  assert.match(run.stderr, /^fix: \S/m, run.stderr);
  assert.ok(
    run.stderr.includes(`cause: ${cause.area}.${cause.id};`),
    run.stderr,
  );
  for (const name of names)
    assert.ok(run.stderr.includes(name), `${id}: names ${name}: ${run.stderr}`);
}

/** A complete start command line, with `changes` applied. */
function start(changes = {}) {
  const options = {
    provider: 'apple',
    confirm: PHRASE,
    'execution-host': 'test-host',
    'expires-in-minutes': '15',
    ...changes,
  };
  const args = ['login'];
  for (const [name, value] of Object.entries(options))
    if (value !== undefined) args.push(`--${name}`, value);
  return args;
}

const executor = (base, token = box.apiToken) => ({
  WELES_WORKER_API_BASE: base,
  WELES_WORKER_TOKEN: token,
});

test('login_refuses_an_option_it_does_not_take', async () => {
  failed('options-unknown', await weles([...start(), '--account', 'x']), [
    '--account',
  ]);
});

test('login_refuses_a_provider_it_cannot_sign_in_to', async () => {
  failed('provider-unsupported', await weles(start({ provider: 'google' })), [
    '"google"',
  ]);
});

test('login_refuses_a_missing_execution_host', async () => {
  failed(
    'option-value-missing',
    await weles(start({ 'execution-host': undefined })),
    ['--execution-host', 'not given'],
  );
});

test('login_refuses_an_account_role_that_is_not_a_role', async () => {
  failed(
    'account-role-invalid',
    await weles(start({ 'account-role': 'Apple Holder' })),
    ['"Apple Holder"'],
  );
});

test('login_refuses_a_confirmation_that_is_not_the_phrase', async () => {
  failed('confirmation-mismatch', await weles(start({ confirm: 'yes' })), [
    '"yes"',
  ]);
});

test('login_refuses_an_execution_host_that_is_not_a_host_name', async () => {
  failed(
    'execution-host-invalid',
    await weles(start({ 'execution-host': 'host;rm' })),
    ['"host;rm"'],
  );
});

test('login_refuses_an_expiry_that_is_not_whole_minutes', async () => {
  failed(
    'expiry-invalid',
    await weles(start({ 'expires-in-minutes': '1.5' })),
    ['"1.5"'],
  );
});

test('login_refuses_run_without_an_id', async () => {
  failed('run-id-missing', await weles(['login', '--run', ' ']), ['--run']);
});

test('login_from_an_install_without_the_issuer_names_the_module', async () => {
  // An install of the built tree alone, without the src/auth it ships.
  const install = join(work, 'install-without-auth');
  cpSync(join(root, 'dist'), join(install, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(install, 'package.json'));
  failed(
    'install-incomplete',
    await weles(start(), {}, join(install, 'dist', 'cli.js')),
    ['apple-account-placement.mjs', 'Cannot find module'],
  );
});

test('login_on_a_host_without_stado_names_where_it_looked', async () => {
  const absent = join(work, 'no-stado');
  failed(
    'stado-unavailable',
    await weles(start(), { WELES_STADO_BIN: absent }),
    [absent],
  );
});

test('login_whose_capabilities_stado_refuses_quotes_stado', async () => {
  failed(
    'stado-refused',
    await weles(start({ 'execution-host': 'no-such-target' })),
    ['identity issue', 'unknown target no-such-target'],
  );
});

test('login_through_a_stado_that_prints_no_json_names_it', async () => {
  failed(
    'stado-answer-not-json',
    await weles(start(), { WELES_STADO_BIN: '/bin/echo' }),
    ['identity issue', 'not JSON'],
  );
});

test('login_whose_capabilities_name_another_host_is_refused', async () => {
  // Stado answering issued capabilities for another target.
  const other = answering(
    'stado-issued-elsewhere',
    JSON.stringify({
      status: 'issued',
      target: 'other-host',
      capabilities: {},
    }),
  );
  failed(
    'capabilities-not-issued',
    await weles(start(), { WELES_STADO_BIN: other }),
    ['test-host', '"other-host"'],
  );
});

test('login_whose_run_the_executor_does_not_start_quotes_it', async () => {
  const issued = answering(
    'stado-issued',
    JSON.stringify({
      status: 'issued',
      target: 'test-host',
      capabilities: { a: 1 },
    }),
  );
  stubAnswers.set('/run', {
    status: 200,
    type: 'application/json',
    body: JSON.stringify({
      ok: false,
      error: 'apple_login is not served here',
    }),
  });
  failed(
    'run-not-started',
    await weles(start(), {
      WELES_STADO_BIN: issued,
      ...executor(`http://127.0.0.1:${stubPort}`),
    }),
    ['apple_login is not served here'],
  );
});

test('relay_whose_stado_answer_lacks_the_holder_is_refused', async () => {
  // The relay is the module the Apple trajectory imports; it is asked as the
  // trajectory asks it, with Stado answering "ready" without a holder.
  const ready = answering('stado-ready', JSON.stringify({ status: 'ready' }));
  const { preflightAppleChallengeRelay } = await import(
    '../../src/auth/apple-account-placement.mjs'
  );
  const previous = process.env.WELES_STADO_BIN;
  process.env.WELES_STADO_BIN = ready;
  let thrown;
  try {
    preflightAppleChallengeRelay('apple-holder', 'guard-1');
  } catch (error) {
    thrown = error;
  } finally {
    if (previous === undefined) delete process.env.WELES_STADO_BIN;
    else process.env.WELES_STADO_BIN = previous;
  }
  assert.ok(thrown, 'the relay refuses an answer without a holder');
  const answer = {
    cause: thrown.declared?.id,
    message: thrown.message,
    remedy: thrown.remedy,
  };
  report.cases.push({ cause: 'challenge-not-confirmed', answer });
  assert.equal(answer.cause, 'challenge-not-confirmed');
  assert.ok(answer.message.includes('identity relay'), answer.message);
  assert.ok(answer.message.includes('"status":"ready"'), answer.message);
  assert.ok(answer.remedy.length > 0);
});

test('login_reading_a_run_where_stado_places_no_executor', async () => {
  failed(
    'executor-route-unresolved',
    await weles(['login', '--run', 'run-1']),
    ['service directory connect weles-admission'],
  );
});

test('login_with_an_executor_address_and_no_token_names_the_variable', async () => {
  failed(
    'variable-missing',
    await weles(['login', '--run', 'run-1'], {
      WELES_WORKER_API_BASE: server.base,
    }),
    ['WELES_WORKER_TOKEN'],
  );
});

test('login_with_a_token_holding_a_newline_names_the_variable', async () => {
  failed(
    'variable-invalid',
    await weles(
      ['login', '--run', 'run-1'],
      executor(server.base, `${box.apiToken}\n`),
    ),
    ['WELES_WORKER_TOKEN'],
  );
});

test('login_with_an_executor_address_that_is_not_a_url_names_it', async () => {
  failed(
    'endpoint-invalid',
    await weles(['login', '--run', 'run-1'], executor('weles host')),
    ['WELES_WORKER_API_BASE', 'weles host'],
  );
});

test('login_with_a_remote_plain_http_executor_is_refused', async () => {
  failed(
    'endpoint-insecure',
    await weles(
      ['login', '--run', 'run-1'],
      executor('http://weles.example.com'),
    ),
    ['http://weles.example.com'],
  );
});

test('login_reading_a_run_from_a_closed_port_names_the_address', async () => {
  const closed = await freePort();
  failed(
    'executor-unreachable',
    await weles(
      ['login', '--run', 'run-1'],
      executor(`http://127.0.0.1:${closed}`),
    ),
    [`127.0.0.1:${closed}`, 'ECONNREFUSED'],
  );
});

test('login_reading_a_run_with_a_wrong_bearer_is_refused_by_the_executor', async () => {
  failed(
    'executor-unauthorized',
    await weles(
      ['login', '--run', 'run-1'],
      executor(server.base, randomUUID()),
    ),
    ['HTTP 401', 'unauthorized'],
  );
});

test('login_reading_a_run_id_the_executor_refuses_quotes_it', async () => {
  failed(
    'executor-refused',
    await weles(['login', '--run', '_bad'], executor(server.base)),
    ['HTTP 400', 'invalid_run_id'],
  );
});

test('login_reading_a_run_the_executor_never_had_is_not_found', async () => {
  failed(
    'executor-not-found',
    await weles(
      ['login', '--run', `run-${randomUUID()}`],
      executor(server.base),
    ),
    ['HTTP 404'],
  );
});

test('login_reading_a_result_without_a_status_names_it', async () => {
  const id = `run-${randomUUID()}`;
  mkdirSync(box.runResults, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(box.runResults, `${id}.json`),
    JSON.stringify({ ok: true, stdout: 'written by another program' }),
    { mode: 0o600 },
  );
  failed(
    'run-result-unreadable',
    await weles(['login', '--run', id], executor(server.base)),
    [id, 'written by another program'],
  );
});

test('login_reading_a_run_through_a_failing_forward_quotes_its_answer', async () => {
  stubAnswers.set('/diagnostics/run-1/file', {
    status: 502,
    type: 'text/plain',
    body: 'upstream weles-admission refused the connection',
  });
  failed(
    'executor-failed',
    await weles(
      ['login', '--run', 'run-1'],
      executor(`http://127.0.0.1:${stubPort}`),
    ),
    ['HTTP 502', 'upstream weles-admission refused the connection'],
  );
});

test('login_reading_a_run_through_a_page_that_is_not_the_executor_names_it', async () => {
  stubAnswers.set('/diagnostics/run-1/file', {
    status: 200,
    type: 'text/html',
    body: '<html>sign in to the proxy</html>',
  });
  failed(
    'executor-answer-not-json',
    await weles(
      ['login', '--run', 'run-1'],
      executor(`http://127.0.0.1:${stubPort}`),
    ),
    ['text/html', 'sign in to the proxy'],
  );
});
