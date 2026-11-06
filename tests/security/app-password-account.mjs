// Real managed execution against a dedicated Gmail account and an existing isolated mailbox.
// A running provider journey is retained as awaiting_observation, never passed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { constants as http } from 'node:http2';
import { parseArgs } from 'node:util';
import { STATUS, evidenceFor } from './evidence.mjs';

const evidence = await evidenceFor('app-password-account');
const { report, command, request } = evidence;
const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    skrzynka: { type: 'string' },
    organization: { type: 'string' },
    mailbox: { type: 'string' },
    account: { type: 'string' },
    'login-item': { type: 'string' },
    bind: { type: 'string' },
    outcome: { type: 'string' },
    'admission-report': { type: 'string' },
  },
});
function cli(args) {
  const result = spawnSync(values.binary, args, { encoding: 'utf8' });
  report.operations.push({
    command: [values.binary, ...args],
    exit_status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    'the CLI must finish rather than be killed',
  );
  return { status: result.status, value: JSON.parse(result.stdout) };
}
function mailbox() {
  const row = JSON.parse(
    command(values.skrzynka, [
      '--organization',
      values.organization,
      'mailbox',
      'show',
      values.mailbox,
    ]),
  );
  const { credential_source, recovery_command, ...stored } = row;
  return stored;
}
try {
  for (const name of [
    'binary',
    'skrzynka',
    'organization',
    'mailbox',
    'account',
    'login-item',
    'bind',
    'outcome',
  ]) {
    assert.equal(typeof values[name], 'string', `--${name} is required`);
    assert.ok(values[name].trim(), `--${name} must be nonempty`);
  }
  assert.ok(['connected', 'account-mismatch'].includes(values.outcome));
  report.fixture = {
    organization: values.organization,
    mailbox: values.mailbox,
    account: values.account,
    login_item: values['login-item'],
    outcome: values.outcome,
  };
  report.source_diff = command('git', ['diff', '--', 'src', 'tests/security']);
  assert.equal(report.source_diff, '', 'qualify committed source only');
  report.cli_version = command(values.binary, ['version']);
  const { exit_status: successStatus } = report.operations.findLast(
    (operation) => operation.command?.includes(values.binary),
  );
  report.skrzynka_version = command(values.skrzynka, ['--version']);
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, http.HTTP_STATUS_OK);
  report.worker_revision = health.value.sourceRevision;
  assert.equal(report.worker_revision, report.source_revision);
  let run;
  if (values['admission-report']) {
    const previous = JSON.parse(
      await readFile(values['admission-report'], 'utf8'),
    );
    assert.equal(previous.status, 'awaiting_observation');
    assert.equal(previous.source_revision, report.source_revision);
    assert.equal(previous.worker_revision, report.worker_revision);
    assert.deepEqual(previous.fixture, report.fixture);
    report.before = previous.before;
    run = previous.admission;
  } else {
    report.before = mailbox();
    assert.equal(
      report.before.email.toLowerCase(),
      values.account.toLowerCase(),
    );
    const admitted = cli([
      'password',
      '--provider',
      'google',
      '--login-item',
      values['login-item'],
      '--organization',
      values.organization,
      '--account',
      values.account,
      '--json',
    ]);
    run = admitted.value;
    if (run.ok === false) assert.notEqual(admitted.status, successStatus);
    else assert.equal(admitted.status, successStatus);
  }
  report.admission = run;
  assert.equal(run.action, 'google_app_password');
  assert.equal(run.params.login_item, values['login-item']);
  assert.equal(run.params.organization, values.organization.trim());
  assert.equal(run.params.expected_account, values.account.trim());
  evidence.runs.add(run.id);
  const persisted = await request(
    `/diagnostics/${encodeURIComponent(run.id)}/file?path=run-result.json`,
  );
  assert.equal(persisted.status, http.HTTP_STATUS_OK);
  assert.equal(persisted.value.params.login_item, values['login-item']);
  assert.equal(persisted.value.params.organization, values.organization.trim());
  assert.equal(persisted.value.params.expected_account, values.account.trim());
  report.persisted_run = persisted.value;
  if (typeof persisted.value.run_id === 'string')
    evidence.runs.add(persisted.value.run_id);
  if (persisted.value.status === 'running') {
    report.status = STATUS.awaitingObservation;
    throw new Error(
      'The actual managed run is still active; resume with --admission-report and the same fixture',
    );
  }
  assert.equal(persisted.value.status, 'finished');
  const result = persisted.value.result;
  assert.equal(result.login_item, values['login-item']);
  assert.equal(result.expected_account, values.account.trim());
  const readback = cli(['password', '--run', run.id, '--json']);
  assert.deepEqual(readback.value.result, result);
  report.after = mailbox();
  if (values.outcome === 'account-mismatch') {
    assert.equal(persisted.value.ok, false);
    assert.equal(result.ok, false);
    assert.equal(result.blocked, 'expected_account_mismatch');
    assert.notEqual(
      result.email.toLowerCase(),
      values.account.trim().toLowerCase(),
    );
    assert.notEqual(readback.status, successStatus);
    assert.deepEqual(
      report.after,
      report.before,
      'a refused account binding must not change the mailbox',
    );
    assert.equal(result.app_password_created, undefined);
  } else {
    assert.equal(persisted.value.ok, true);
    assert.equal(result.ok, true);
    assert.equal(
      result.email.toLowerCase(),
      values.account.trim().toLowerCase(),
    );
    assert.equal(readback.status, successStatus);
    assert.equal(report.after.id, report.before.id);
    assert.equal(
      report.after.email.toLowerCase(),
      values.account.trim().toLowerCase(),
    );
    const connected = JSON.parse(
      command(values.skrzynka, [
        '--organization',
        values.organization,
        'account',
        'connection',
        '--provider',
        'gmail',
        '--email',
        values.account,
        '--bind',
        values.bind,
      ]),
    );
    report.connection = connected;
    assert.equal(
      connected.account.toLowerCase(),
      values.account.trim().toLowerCase(),
    );
    const password = connected.paths.find(
      (path) => path.path === 'app_password',
    );
    assert.equal(
      password?.verdict,
      'usable',
      'the resulting stored credential must really authenticate to Gmail',
    );
  }
  report.status = STATUS.passed;
} catch (error) {
  if (report.status !== STATUS.awaitingObservation) report.status = STATUS.failed;
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  throw error;
} finally {
  await evidence.finish();
}
