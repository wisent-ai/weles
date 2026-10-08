// Read-only qualification against a real deployed Weles service and CLI.
// Run once with WELES_TEST_IDENTITY_STATE=refused and once with =ready on a
// dedicated deployment whose identity is managed through Stado. This runner
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
const binary = realpathSync(required('WELES_BIN'));
const expected = required('WELES_TEST_IDENTITY_STATE');
assert.ok(
  expected === 'ready' || expected === 'refused',
  'WELES_TEST_IDENTITY_STATE must be ready or refused',
);
const evidence = join(root, 'build', 'real-tests', 'worker-identity');
mkdirSync(evidence, { recursive: true });
const output = mkdtempSync(join(evidence, 'run-'));
const report = {
  started_at: new Date().toISOString(),
  binary,
  binary_sha256: createHash('sha256')
    .update(readFileSync(binary))
    .digest('hex'),
  expected,
  commands: [],
  verdict: 'blocked',
};

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
  if (expected === 'refused') {
    assert.equal(worker.ready, false);
    assert.equal(worker.prerequisites.serviceIdentity, false);
    assert.ok(worker.serviceIdentityFailure);
    assert.ok(
      worker.serviceIdentityFailure.operation ===
        'read-deployed-service-identity' ||
        worker.serviceIdentityFailure.operation ===
          'validate-deployed-service-identity',
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
  } else {
    assert.equal(response.ok, true);
    assert.equal(version.ready, true);
    assert.equal(worker.prerequisites.serviceIdentity, true);
    assert.equal(
      worker.serviceIdentityFailure,
      null,
      'Successful identity admission retained an earlier failure',
    );
  }
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
