// Uses only the Stado-managed operator API; the browser stays on its dedicated host.
// Supply a dedicated Google test login, not an operator's production account.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'build', 'real-tests', 'app-password', randomUUID());
await mkdir(directory, { recursive: true });
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source_sha256: createHash('sha256').update(await readFile(new URL('../../src/worker/weles-api-server/routes/run-route.mjs', import.meta.url))).digest('hex'),
  command: [process.execPath, ...process.argv.slice(1)],
  started_at: new Date().toISOString(),
  operations: [],
  status: 'running',
};
try {
  const { values } = parseArgs({ options: {
    'login-role': { type: 'string' }, 'login-item': { type: 'string' },
    email: { type: 'string' }, revision: { type: 'string' },
  } });
  for (const key of ['login-role', 'login-item', 'email', 'revision']) {
    assert.ok(values[key]?.trim(), `--${key} is required; use an isolated Google test account`);
  }
  const { welesOperatorConnection, operatorJson } = await import('../../dist/runtime/api/connection.js');
  async function request(path, body) {
    const connection = welesOperatorConnection(path);
    const response = await connection.fetch(connection.endpoint, {
      method: body ? 'POST' : 'GET', headers: connection.headers, redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await operatorJson(response);
    report.operations.push({ method: body ? 'POST' : 'GET', path, http_status: response.status, body: value });
    return { response, value };
  }
  const health = await request('/healthz');
  assert.equal(health.response.status, 200);
  assert.equal(health.value.sourceRevision, values.revision, 'the managed executor must run the revision being qualified');
  for (const params of [{}, { login_role: values['login-role'], login_item: values['login-item'] }]) {
    const refusal = await request('/run', { action: 'google_app_password', params, detached: true });
    assert.equal(refusal.response.status, 400);
    assert.equal(refusal.value.error, 'provide exactly one of login_role or login_item');
    assert.equal(refusal.value.detached_run, undefined, 'a refused selector must not admit a browser run');
  }
  const invoke = (...args) => {
    const command = [join(root, 'dist/cli.js'), 'app-password', ...args, '--json'];
    const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8' });
    report.operations.push({ command: [process.execPath, ...command], exit_status: result.status,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    return result;
  };
  const cli = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const args of [
    ['--login-role', values['login-role'], '--login-item', values['login-item']],
    ['--login-item', ''],
    ['--login-item', values['login-item'], '--run', 'not-an-admitted-run'],
  ]) {
    const refused = invoke(...args);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /--login-role.*--login-item.*--run/);
  }
  for (const selector of ['login-role', 'login-item']) {
    const admitted = cli(`--${selector}`, values[selector]);
    assert.equal(admitted.action, 'google_app_password');
    const expectedRole = selector === 'login-role' ? values['login-role'] : undefined;
    assert.equal(admitted.params.login_role, expectedRole);
    assert.equal(admitted.params.login_item, values['login-item']);
    const terminal = await request(`/diagnostics/${encodeURIComponent(admitted.id)}/file?path=run-result.json&wait=terminal`);
    assert.equal(terminal.response.status, 200);
    assert.equal(terminal.value.status, 'finished');
    assert.equal(terminal.value.ok, true, terminal.value.error ?? terminal.value.stderr_tail);
    const persisted = cli('--run', admitted.id);
    assert.equal(persisted.params.login_role, expectedRole);
    assert.equal(persisted.params.login_item, values['login-item']);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.stdout, terminal.value.stdout);
    const outcome = JSON.parse(persisted.stdout);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.login_item, values['login-item']);
    assert.equal(outcome.email, values.email);
    assert.equal(outcome.app_name, 'Skrzynka');
    assert.equal(outcome.skrzynka.email, values.email);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  const path = join(directory, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path, ...report }, null, 2));
}
