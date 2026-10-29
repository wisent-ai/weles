// Read-only qualification against a real deployed Weles service and CLI.
// Run once with WELES_TEST_IDENTITY_STATE=refused and once with =ready on a
// dedicated deployment whose identity is managed through Stado, each with
// WELES_TEST_RUNTIME_STATE (reported or probing) declaring what the one
// status read must show of the browser runtime. This runner
// never changes the deployment, restarts a process or launches a browser.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} must name the qualification input`);
  return value;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// One of `table`'s states, as the run declares it in `name`; a missing or
// unknown value is refused naming the setting and the states it accepts.
function declared(name, table) {
  const value = required(name);
  assert.ok(
    Object.hasOwn(table, value),
    `${name} must be one of ${Object.keys(table).join(', ')}; it is ${value}`,
  );
  return value;
}
// The identity states a qualification may expect, each with what the
// answering service must then show.
const EXPECTATIONS = {
  refused({ worker, response, version, text }) {
    assert.equal(worker.ready, false);
    assert.equal(worker.prerequisites.serviceIdentity, false);
    assert.ok(worker.serviceIdentityFailure);
    assert.equal(typeof worker.serviceIdentityFailure.operation, 'string');
    assert.ok(
      worker.serviceIdentityFailure.operation.trim(),
      'The identity failure does not name the operation that failed',
    );
    assert.equal(typeof worker.serviceIdentityFailure.message, 'string');
    assert.ok(
      worker.serviceIdentityFailure.message.trim(),
      'The failed identity operation did not retain its cause',
    );
    assert.equal(response.ok, false);
    assert.equal(version.ready, false);
    assert.equal(version.error, 'deployed-service-identity-mismatch');
    assert.equal(
      Object.hasOwn(version, 'serviceIdentityFailure'),
      false,
      'Anonymous version disclosed the private diagnostic',
    );
    assert.equal(
      text.includes(worker.serviceIdentityFailure.message),
      false,
      'Anonymous version disclosed the underlying identity error',
    );
  },
  ready({ worker, response, version }) {
    assert.equal(response.ok, true);
    assert.equal(version.ready, true);
    assert.equal(worker.prerequisites.serviceIdentity, true);
    assert.equal(
      worker.serviceIdentityFailure,
      null,
      'Successful identity admission retained an earlier failure',
    );
  },
};
// The browser runtime states a run may expect its one status read to show,
// each with what the read must then carry. The runner never waits for a
// probe: an encoder that hangs is the `probing` run.
const RUNTIME_EXPECTATIONS = {
  // A finished probe's report, with when it was probed.
  reported(probe) {
    assert.ok(
      probe.report !== null,
      `The run declares a finished runtime report, and the status has none: ${probe.said} (probingSince ${probe.probingSince})`,
    );
    assert.ok(
      typeof probe.probedAt === 'string',
      `A runtime report states no time it was probed: ${JSON.stringify(probe)}`,
    );
    const runtime = probe.report;
    assert.ok(
      typeof runtime.ok === 'boolean',
      `The runtime report states no ok: ${JSON.stringify(runtime)}`,
    );
    // The inspector states a components list once it resolved the encoder,
    // and only an error when it could not: a list that is absent is said as
    // absent, never counted as no failing component.
    const listed = Array.isArray(runtime.components);
    const failing = listed
      ? runtime.components.filter((component) => component.ok !== true)
      : null;
    if (runtime.ok) {
      assert.ok(
        listed && runtime.components.length && !failing.length,
        `A ready browser runtime names no probed component, or one of them failed: ${JSON.stringify(runtime)}`,
      );
    } else if (!(typeof runtime.error === 'string' && runtime.error.trim())) {
      assert.ok(
        listed,
        `A failing browser runtime states neither its resolution error nor its components: ${JSON.stringify(runtime)}`,
      );
      assert.ok(
        failing.length &&
          failing.every(
            (component) =>
              typeof component.error === 'string' && component.error.trim(),
          ),
        `A failing browser runtime does not say why: ${JSON.stringify(runtime)}`,
      );
    }
  },
  // No report yet, and a probe running since a stated time.
  probing(probe) {
    assert.ok(
      probe.report === null && typeof probe.probingSince === 'string',
      `The run declares a probe still running with no report, and the status says otherwise: ${JSON.stringify(probe)}`,
    );
  },
};
// Every run keeps a report, a run refused for its own inputs among them, so
// a refused invocation is retained with its cause like any other.
const evidence = join(root, 'build', 'real-tests', 'worker-identity');
mkdirSync(evidence, { recursive: true });
const output = mkdtempSync(join(evidence, 'run-'));
const report = {
  started_at: new Date().toISOString(),
  binary: null,
  binary_sha256: null,
  expected: null,
  runtime_expected: null,
  commands: [],
  verdict: 'blocked',
};
let binary;

function command(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
  report.commands.push({
    program,
    args,
    exit_status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${program} was terminated`);
  assert.ok(
    result.status !== null && !result.status,
    `${program} refused: ${result.stderr}`,
  );
  return result.stdout;
}

try {
  binary = realpathSync(required('WELES_BIN'));
  report.binary = binary;
  report.binary_sha256 = createHash('sha256')
    .update(readFileSync(binary))
    .digest('hex');
  report.expected = declared('WELES_TEST_IDENTITY_STATE', EXPECTATIONS);
  report.runtime_expected = declared(
    'WELES_TEST_RUNTIME_STATE',
    RUNTIME_EXPECTATIONS,
  );
  report.revision = command('git', ['rev-parse', 'HEAD']).trim();
  report.checkout_status = command('git', ['status', '--porcelain']);
  const status = JSON.parse(command(binary, ['worker', 'status', '--json']));
  report.initial_status = status;
  assert.equal(status.ok, true, 'Worker status was refused');
  const endpoint = new URL(status.endpoint);
  endpoint.pathname = '/api/v1/version';
  endpoint.search = '';
  endpoint.hash = '';
  const response = await fetch(endpoint);
  const text = await response.text();
  report.public_version = {
    endpoint: endpoint.toString(),
    http_status: response.status,
    body: text,
  };
  const version = JSON.parse(text);
  const observed = JSON.parse(command(binary, ['worker', 'status', '--json']));
  report.observed_status = observed;
  assert.equal(
    version.sourceRevision,
    report.revision,
    'The answering service was not built from this exact source revision',
  );
  assert.equal(
    report.checkout_status,
    '',
    'Qualification requires a committed checkout without uncommitted sources',
  );
  assert.equal(
    observed.ok,
    true,
    'Worker status was refused after identity read',
  );
  assert.equal(
    observed.endpoint,
    status.endpoint,
    'Worker resolution changed during qualification',
  );
  const worker = observed.worker;
  assert.ok(
    worker && Object.hasOwn(worker, 'serviceIdentityFailure'),
    'The service does not expose deployment identity diagnostics',
  );
  // The browser runtime as the doctor's own inspector last reported it, from
  // the second status read (observed_status, after the identity refresh); the
  // first read may itself have started the probe, so the two can differ. A
  // status read never waits on the probe and neither does this runner: it
  // keeps that read in the report and holds it to the state the run declares
  // (RUNTIME_EXPECTATIONS).
  const probe = worker.browserRuntime;
  report.browser_runtime_read = probe;
  assert.ok(
    probe && typeof probe.said === 'string' && probe.said.trim(),
    'The worker status carries no browser runtime probe',
  );
  RUNTIME_EXPECTATIONS[report.runtime_expected](probe);
  EXPECTATIONS[report.expected]({ worker, response, version, text });
  report.verdict = 'passed';
} catch (error) {
  report.error = String(error.stack || error);
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(report, null, '\t') + '\n',
  );
  console.log(`${report.verdict}: ${join(output, 'report.json')}`);
}
