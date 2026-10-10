import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { constants as HTTP } from 'node:http2';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Run only on the selected dedicated host with its real authenticated Weles API.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'build/real-tests/keeper-api', randomUUID());
mkdirSync(directory, { recursive: true });
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  host: hostname(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  requests: [],
  status: 'blocked',
};
const save = () =>
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
process.once('exit', (code) => {
  report.exit_status = code;
  save();
});
save();

await test('authenticated API observes and stops its real keeper owner', async () => {
  const binary = process.env.WELES_BIN;
  const origin = process.env.WELES_WORKER_API_BASE;
  const token = process.env.WELES_WORKER_TOKEN;
  assert.ok(binary, 'WELES_BIN is required');
  assert.ok(origin, 'WELES_WORKER_API_BASE is required');
  assert.ok(token, 'WELES_WORKER_TOKEN is required');
  assert.ok(
    !process.env.WELES_STANDALONE,
    'Stado placement must remain enforced',
  );
  assert.ok(!process.env.ACCOUNT_ID, 'an operator profile must not be used');
  const exchange = async (path, method, authenticated = true) => {
    const url = new URL(path, origin);
    const response = await fetch(url, {
      method,
      headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
    });
    const text = await response.text();
    report.requests.push({
      url: String(url),
      method,
      authenticated,
      status: response.status,
      body: text,
    });
    save();
    return { status: response.status, body: JSON.parse(text) };
  };
  const session = `keeper-api-test-${randomUUID()}`;
  const args = [
    'keeper',
    'start',
    '--session',
    session,
    '--url',
    'about:blank',
  ];
  report.keeper_command = [binary, ...args];
  const version = await exchange('/worker/version', 'GET');
  assert.equal(version.status, HTTP.HTTP_STATUS_OK);
  report.worker_identity = version.body.identity;
  assert.equal(
    version.body.identity.runner.worker_host,
    hostname(),
    'the API must serve the dedicated host running this journey',
  );
  const expectedRevision = process.env.WELES_GATEWAY_SOURCE_REVISION;
  assert.ok(expectedRevision, 'WELES_GATEWAY_SOURCE_REVISION is required');
  assert.equal(
    version.body.identity.deployment.weles_commit,
    expectedRevision,
    'worker source revision differs from the selected qualification',
  );
  const child = spawn(binary, args, {
    cwd: root,
    env: {
      ...process.env,
      WELES_RECORDINGS_ROOT: join(directory, 'recordings'),
      WELES_RUN_ID: randomUUID(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    report.stderr = stderr;
    save();
  });
  const ready = Promise.withResolvers();
  const exited = once(child, 'exit');
  exited.then(([code, signal]) => {
    report.keeper_exit = { code, signal };
    ready.reject(
      new Error(`keeper ended before readiness: ${code} ${signal}: ${stderr}`),
    );
  });
  child.once('error', ready.reject);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const answer = JSON.parse(line);
      if (answer.session === session && answer.socket) ready.resolve(answer);
    } catch (error) {
      report.non_json_output = { line, error: error.message };
    }
  });
  try {
    const owner = await ready.promise;
    report.owner = owner;
    report.status = 'failed';
    const inventory = await exchange('/keepers', 'GET');
    assert.equal(inventory.status, HTTP.HTTP_STATUS_OK);
    assert.equal(
      inventory.body.keepers.find((entry) => entry.session === session).state,
      'running',
    );
    const status = await exchange(`/keepers/${session}`, 'GET');
    assert.equal(status.status, HTTP.HTTP_STATUS_OK);
    assert.equal(status.body.session, session);
    assert.equal(status.body.state, 'running');
    assert.equal(status.body.url, 'about:blank');
    const denied = await exchange(`/keepers/${session}/stop`, 'POST', false);
    assert.equal(denied.status, HTTP.HTTP_STATUS_UNAUTHORIZED);
    assert.equal(
      (await exchange(`/keepers/${session}`, 'GET')).body.state,
      'running',
    );
    const stopped = await exchange(`/keepers/${session}/stop`, 'POST');
    assert.equal(stopped.status, HTTP.HTTP_STATUS_OK);
    assert.equal(stopped.body.session, session);
    assert.equal(stopped.body.state, 'stopped');
    const [code, signal] = await exited;
    assert.ifError(code);
    assert.equal(signal, null);
    assert.equal(existsSync(owner.socket), false);
    assert.equal(
      (await exchange(`/keepers/${session}`, 'GET')).body.state,
      'stopped',
    );
    const repeated = await exchange(`/keepers/${session}/stop`, 'POST');
    assert.equal(repeated.status, HTTP.HTTP_STATUS_BAD_GATEWAY);
    assert.ok(repeated.body.error.includes(session));
    report.status = 'passed';
  } catch (error) {
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    throw error;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await exited;
    save();
  }
});
