// Exercises the managed executor and the real CLI (`weles security`). No local
// browser or provider substitute.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evidenceFor } from './evidence.mjs';

// The HTTP status RFC 9110 gives `reason`, read from Node's own table.
function statusOf(reason) {
  const code = Object.keys(STATUS_CODES).find(
    (candidate) => STATUS_CODES[candidate] === reason,
  );
  assert.ok(code, `Node's HTTP table names no status "${reason}"`);
  return Number(code);
}

const evidence = await evidenceFor('account-security');
const { report, request, command } = evidence;
try {
  const { values } = parseArgs({
    options: {
      'login-role': { type: 'string' },
      'admission-report': { type: 'string' },
    },
  });
  assert.notEqual(
    Boolean(values['login-role']),
    Boolean(values['admission-report']),
    'provide exactly one of --login-role or --admission-report',
  );
  report.source_diff = command('git', ['diff', '--', 'src', 'tests/security']);
  const binary = process.env.WELES_REAL_BIN;
  assert.ok(
    binary,
    'WELES_REAL_BIN names the weles binary under test; none is assumed',
  );
  report.cli_version = command(binary, ['version']);
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, statusOf('OK'));
  const { sourceRevision, publicTask } = health.value;
  report.worker_revision =
    sourceRevision === undefined ? publicTask?.sourceRevision : sourceRevision;
  assert.equal(
    report.worker_revision,
    report.source_revision,
    'the managed executor must run the source revision being qualified',
  );

  let run;
  if (values['admission-report']) {
    const previous = JSON.parse(
      await readFile(values['admission-report'], 'utf8'),
    );
    assert.equal(previous.status, 'awaiting_observation');
    assert.equal(previous.source_revision, report.source_revision);
    assert.equal(previous.worker_revision, report.worker_revision);
    assert.ok(previous.admission?.id);
    assert.ok(previous.login_role);
    report.admission_report = resolve(values['admission-report']);
    report.login_role = previous.login_role;
    report.admission = previous.admission;
    run = previous.admission;
  } else {
    report.login_role = values['login-role'].trim();
    assert.ok(report.login_role, 'the login role must be nonempty');
    const denied = await request(
      '/run',
      {
        action: 'google_mfa_status',
        params: { login_role: report.login_role },
        detached: true,
      },
      null,
    );
    assert.equal(denied.status, statusOf('Unauthorized'));
    const mutation = await request('/run', {
      action: 'google_mfa_status',
      params: { login_role: report.login_role, enable: true },
      detached: true,
    });
    assert.equal(mutation.status, statusOf('Bad Request'));
    assert.equal(
      mutation.value.detached_run,
      undefined,
      'refused mutation must not start a run',
    );
    run = JSON.parse(
      command(binary, [
        'security',
        '--provider',
        'google',
        '--login-role',
        report.login_role,
        '--json',
      ]),
    );
    report.admission = run;
  }

  assert.equal(run.action, 'google_mfa_status');
  assert.equal(run.params.login_role, report.login_role);
  assert.ok(
    run.params.login_item,
    'admission must identify the resolved login',
  );
  assert.equal(run.id, report.admission.id);
  evidence.runs.add(run.id);
  const persisted = await request(
    `/diagnostics/${encodeURIComponent(run.id)}/file?path=run-result.json`,
  );
  assert.equal(persisted.status, statusOf('OK'));
  assert.equal(persisted.value.action, run.action);
  assert.equal(persisted.value.params.login_role, report.login_role);
  assert.equal(persisted.value.params.login_item, run.params.login_item);
  report.persisted_run = persisted.value;
  if (typeof persisted.value.run_id === 'string')
    evidence.runs.add(persisted.value.run_id);

  if (persisted.value.status === 'running') {
    report.status = 'awaiting_observation';
    // Not a pass: the run ends unfinished and says how to resume.
    throw new Error(
      'Admission and persisted identity agree; the provider observation is not finished. Resume with --admission-report.',
    );
  }
  assert.equal(persisted.value.status, 'finished');
  assert.equal(persisted.value.ok, true);
  const observed = persisted.value.result;
  assert.equal(observed.schema, 'weles.account-security.v1');
  assert.equal(observed.login_item, run.params.login_item);
  assert.equal(observed.source_revision, report.worker_revision);
  assert.equal(observed.ok, true);
  assert.equal(typeof observed.two_factor_enabled, 'boolean');
  assert.ok(observed.account);
  assert.ok(observed.account_evidence);
  assert.ok(observed.status_evidence);
  assert.ok(Number.isFinite(Date.parse(observed.checked_at)));
  const readBack = JSON.parse(
    command(binary, ['security', '--run', run.id, '--json']),
  );
  assert.deepEqual(readBack.result, observed);
  report.status = 'passed';
} catch (error) {
  if (report.status !== 'awaiting_observation') report.status = 'failed';
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  throw error;
} finally {
  await evidence.finish();
}
