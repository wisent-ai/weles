// Exercise the actual launcher on a Stado-provisioned isolated worker host.
// Its normal deployment must select real dependencies and an unused API endpoint.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { constants as HTTP } from 'node:http2';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(
  root,
  'build/real-tests/worker-launcher-steps',
  randomUUID(),
);
mkdirSync(output, { recursive: true });
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  host: hostname(),
  command: [process.execPath, join(root, 'src/worker/weles-api-launcher.mjs')],
  steps: [],
  requests: [],
  status: 'blocked',
};
const save = () =>
  writeFileSync(join(output, 'report.json'), JSON.stringify(report));
process.once('exit', (code) => {
  report.exit_status = code;
  save();
});
save();

await test('real worker startup retains operations and their actual outcomes', async () => {
  const target = process.env.WELES_TEST_STARTUP_HOST;
  const exitText = process.env.WELES_TEST_STARTUP_EXPECTED_EXIT;
  const origin = process.env.WELES_WORKER_API_BASE;
  const token = process.env.WELES_WORKER_TOKEN;
  assert.ok(
    target,
    'WELES_TEST_STARTUP_HOST must name the Stado-selected isolated worker',
  );
  assert.equal(
    hostname(),
    target,
    'run only on the selected isolated worker host',
  );
  assert.ok(exitText?.trim(), 'WELES_TEST_STARTUP_EXPECTED_EXIT is required');
  const expectedExit = Number(exitText);
  assert.ok(
    Number.isInteger(expectedExit),
    'WELES_TEST_STARTUP_EXPECTED_EXIT must be an exit status',
  );
  assert.ok(origin, 'WELES_WORKER_API_BASE is required');
  assert.ok(token, 'WELES_WORKER_TOKEN is required');
  if (expectedExit) {
    assert.ok(
      process.env.WELES_TEST_STARTUP_FAILURE_OPERATION,
      'WELES_TEST_STARTUP_FAILURE_OPERATION is required',
    );
    assert.ok(
      process.env.WELES_TEST_STARTUP_FAILURE_CAUSE,
      'WELES_TEST_STARTUP_FAILURE_CAUSE is required',
    );
  }
  const endpoint = new URL('/healthz', origin);
  const endpointAddress = endpoint.hostname.replace(/^\[|\]$/g, '');
  assert.ok(
    Object.values(networkInterfaces())
      .flat()
      .some((entry) => entry?.address === endpointAddress),
    'the fixture endpoint must name an address this dedicated host actually owns',
  );
  try {
    const response = await fetch(endpoint);
    report.requests.push({
      url: String(endpoint),
      status: response.status,
      body: await response.text(),
    });
    assert.fail(
      'the fixture endpoint already answers; no launcher was started and no existing service was changed',
    );
  } catch (error) {
    assert.equal(
      error.cause?.code,
      'ECONNREFUSED',
      `startup fixture admission: ${error.message}`,
    );
    report.initial_connection = {
      code: error.cause.code,
      message: error.message,
    };
  }
  save();
  const environment = { ...process.env };
  delete environment.XPC_SERVICE_NAME;
  const child = spawn(
    process.execPath,
    [join(root, 'src/worker/weles-api-launcher.mjs')],
    {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const finished = new Promise((resolve) => {
    child.once('error', (error) => {
      report.launch_error = {
        name: error.name,
        code: error.code,
        message: error.message,
      };
      save();
    });
    child.once('close', (exit, signal) => resolve({ exit, signal }));
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Set();
  let apiImported;
  const imported = new Promise((resolve) => {
    apiImported = resolve;
  });
  lines.on('line', (line) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const step = entry?.startup_step;
    if (!step) return;
    report.steps.push(step);
    if (step.ended_at) pending.delete(step.operation);
    else pending.add(step.operation);
    save();
    if (step.operation === 'import Weles HTTP API' && step.ended_at)
      apiImported();
  });
  try {
    report.status = 'running';
    if (expectedExit) {
      const result = await finished;
      report.launcher_exit = result;
      assert.equal(
        result.signal,
        null,
        'the launcher must refuse without being killed',
      );
      assert.equal(
        result.exit,
        expectedExit,
        'the real failed startup must retain its exit status',
      );
      const operation = process.env.WELES_TEST_STARTUP_FAILURE_OPERATION;
      assert.ok(
        report.steps.some(
          (step) => step.operation === operation && step.began_at,
        ),
        'the failed operation must have been announced before it ran',
      );
      assert.ok(
        `${stdout}\n${stderr}`.includes(
          process.env.WELES_TEST_STARTUP_FAILURE_CAUSE,
        ),
        'the actual dependency refusal must be retained',
      );
    } else {
      const result = await Promise.race([
        imported.then(() => ({ imported: true })),
        finished.then((exit) => ({ exit })),
      ]);
      assert.equal(
        result.imported,
        true,
        `launcher ended before API startup: ${JSON.stringify(result)}\n${stderr}`,
      );
      const url = new URL('/worker/version', origin);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      report.requests.push({
        url: String(url),
        status: response.status,
        body: text,
      });
      assert.equal(response.status, HTTP.HTTP_STATUS_OK, text);
      const identity = JSON.parse(text).identity;
      assert.equal(
        identity.runner.pid,
        child.pid,
        'the responding API must be the process started by this journey',
      );
      assert.equal(identity.runner.worker_host, target);
      assert.equal(
        identity.deployment.weles_commit,
        report.source_revision,
        'the responding release must match the tested source',
      );
      assert.ok(
        report.steps.some(
          (step) =>
            step.operation.startsWith('Skarbiec route declaration ') &&
            step.ended_at,
        ),
        'the real route declaration must have an observed outcome',
      );
      assert.deepEqual(
        [...pending],
        [],
        'no startup operation may remain pending after API initialization',
      );
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    report.launcher_exit = await finished;
    lines.close();
    writeFileSync(join(output, 'stdout.log'), stdout);
    writeFileSync(join(output, 'stderr.log'), stderr);
    report.finished_at = new Date().toISOString();
    save();
  }
});
