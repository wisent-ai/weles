// Exercises the managed executor and the real CLI. No local browser or provider substitute.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evidenceFor } from './evidence.mjs';

const evidence = await evidenceFor('account-security');
const { report, request, command } = evidence;
try {
  const { values } = parseArgs({ options: {
    'login-role': { type: 'string' },
    'admission-report': { type: 'string' },
  } });
  assert.notEqual(Boolean(values['login-role']), Boolean(values['admission-report']),
    'provide exactly one of --login-role or --admission-report');
  report.source_diff = command('git', ['diff', '--', 'src', 'tests/security']);
  const binary = process.env.WELES_REAL_BIN || 'weles';
  report.cli_version = command(binary, ['version']);
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  report.worker_revision = health.value.sourceRevision ?? health.value.publicTask?.sourceRevision;
  assert.equal(report.worker_revision, report.source_revision,
    'the managed executor must run the source revision being qualified');

  let run;
  if (values['admission-report']) {
    const previous = JSON.parse(await readFile(values['admission-report'], 'utf8'));
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
    const denied = await request('/run', {
      action: 'google_mfa_status', params: { login_role: report.login_role }, detached: true,
    }, null);
    assert.equal(denied.status, 401);
    const mutation = await request('/run', {
      action: 'google_mfa_status', params: { login_role: report.login_role, enable: true }, detached: true,
    });
    assert.equal(mutation.status, 400);
    assert.equal(mutation.value.detached_run, undefined, 'refused mutation must not start a run');
    run = JSON.parse(command(binary, ['account-security', '--provider', 'google', '--login-role', report.login_role, '--json']));
    report.admission = run;
  }

  assert.equal(run.action, 'google_mfa_status');
  assert.equal(run.params.login_role, report.login_role);
  assert.ok(run.params.login_item, 'admission must identify the resolved login');
  assert.equal(run.id, report.admission.id);
  evidence.runs.add(run.id);
  const persisted = await request(`/diagnostics/${encodeURIComponent(run.id)}/file?path=run-result.json`);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.value.action, run.action);
  assert.equal(persisted.value.params.login_role, report.login_role);
  assert.equal(persisted.value.params.login_item, run.params.login_item);
  report.persisted_run = persisted.value;
  if (typeof persisted.value.run_id === 'string') evidence.runs.add(persisted.value.run_id);

  if (persisted.value.status === 'running') {
    report.status = 'awaiting_observation';
    report.error = { message: 'Admission and persisted identity agree; the provider observation is not finished. Resume with --admission-report.' };
    process.exitCode = 1;
  } else {
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
    const readBack = JSON.parse(command(binary, ['account-security', '--run', run.id, '--json']));
    assert.deepEqual(readBack.result, observed);
    report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await evidence.finish();
}
