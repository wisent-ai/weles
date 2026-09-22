import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setInterval } from 'node:timers/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.build/account-security-tests', randomUUID());
mkdirSync(evidence, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(resolve(evidence, 'source-revision.txt'), revision);
let commandNumber = 0;

function cli(args) {
  const command = [resolve(root, 'dist/cli.js'), 'account-security', ...args];
  const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8' });
  writeFileSync(resolve(evidence, `command-${++commandNumber}.json`), JSON.stringify({
    revision, executable: process.execPath, arguments: command, exit_status: result.status,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
  }, null, 2));
  return result;
}

async function completed(run) {
  if (run.completed_at) return run;
  for await (const tick of setInterval(5000)) {
    void tick;
    const read = cli(['--run', run.id]);
    assert.ok(read.stdout, `No persisted run result: ${read.stderr}`);
    run = JSON.parse(read.stdout);
    if (run.completed_at) return run;
  }
}

test('real accounts retain enabled, disabled and unknown provider observations', async () => {
  const fixturePath = process.env.WELES_TEST_2FA_CASES;
  assert.ok(fixturePath, 'WELES_TEST_2FA_CASES must name real account fixtures; no simulated provider is permitted');
  const workerRevision = process.env.WELES_TEST_WORKER_REVISION;
  assert.match(workerRevision || '', /^[a-f0-9]{40}$/, 'Bind the deployed worker to its exact source revision');
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.ok(fixtures.some((item) => item.two_factor_enabled === true), 'A real enabled account is required');
  assert.ok(fixtures.some((item) => item.two_factor_enabled === false), 'A real disabled account is required');
  assert.ok(fixtures.some((item) => item.two_factor_enabled === null), 'A real unavailable-session account is required');
  for (const fixture of fixtures) {
    assert.equal(typeof fixture.login_item, 'string');
    const submitted = cli(['--login-item', fixture.login_item]);
    assert.equal(submitted.status, 0, submitted.stderr);
    const run = await completed(JSON.parse(submitted.stdout));
    const observed = run.result;
    writeFileSync(resolve(evidence, `run-${run.id}.json`), JSON.stringify(run, null, 2));
    assert.equal(observed?.schema, 'weles.account-security.v1');
    assert.equal(observed.login_item, fixture.login_item);
    assert.equal(observed.source_revision, workerRevision);
    assert.equal(observed.two_factor_enabled, fixture.two_factor_enabled, JSON.stringify(run));
    assert.equal(observed.ok, fixture.two_factor_enabled !== null);
    if (fixture.two_factor_enabled === null) {
      assert.ok(observed.reason, 'Unknown requires the actual reason, not a disabled result');
      assert.notEqual(cli(['--run', run.id]).status, 0);
    } else {
      assert.equal(observed.account, fixture.account);
      assert.ok(observed.status_evidence, 'A boolean must carry the provider statement');
      assert.ok(observed.account_evidence, 'The active account must be established');
      assert.equal(cli(['--run', run.id]).status, 0);
    }
  }
});

test('the deployed run API refuses mutation parameters before execution', async () => {
  assert.ok(process.env.WELES_WORKER_API_BASE && process.env.WELES_WORKER_TOKEN,
    'The real authenticated Weles deployment is required');
  const response = await fetch(new URL('/run', process.env.WELES_WORKER_API_BASE), {
    method: 'POST', redirect: 'error',
    headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WELES_WORKER_TOKEN}`,
    },
    body: JSON.stringify({ action: 'google_mfa_status', params: { login_item: 'unused', enable: true } }),
  });
  const body = await response.json();
  writeFileSync(resolve(evidence, 'mutation-refusal.json'), JSON.stringify({ status: response.status, body }, null, 2));
  assert.equal(response.status, 400);
  assert.equal(body.ok, false, 'A refused mutation must not be accepted for execution');
});
