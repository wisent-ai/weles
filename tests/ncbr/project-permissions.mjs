import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { constants as http } from 'node:http2';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectPermissionsUrl } from '../../src/trajectories/ncbr/settings/index.mjs';

// Run on the dedicated managed Weles browser host with an authorized NCBR
// session and a declared project. This only reads; no field or account changes.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(
  root,
  'build/real-tests/ncbr-project-permissions',
  randomUUID(),
);
mkdirSync(directory, { recursive: true });
const script =
  'src/trajectories/ncbr/inspect/inspect_existing_cdp_no_close.mjs';
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  host: hostname(),
  scope: 'read_only_selected_project_permissions',
  status: 'blocked',
  operations: [],
};
const save = () =>
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
process.once('exit', (code) => {
  report.exit_status = code;
  save();
});
save();
const inspect = (env) => {
  const operation = { command: [process.execPath, script] };
  report.operations.push(operation);
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    operation.outcome = 'completed';
    operation.observed = JSON.parse(stdout);
    return operation.observed;
  } catch (error) {
    operation.outcome = 'refused';
    operation.exit_status = error.status;
    operation.signal = error.signal;
    operation.stderr = error.stderr?.toString();
    operation.error = error.message;
    throw error;
  }
};
await test('inspection reads the declared project and refuses missing declarations', () => {
  try {
    assert.ok(
      !process.env.WELES_STANDALONE,
      'managed browser placement is required',
    );
    assert.ok(
      process.env.NCBR_CDP_ENDPOINT,
      'declare the existing dedicated browser endpoint',
    );
    const expectedUrl = projectPermissionsUrl();
    for (const name of ['NCBR_PROJECT_ID', 'NCBR_CDP_ENDPOINT']) {
      const env = { ...process.env };
      delete env[name];
      assert.throws(
        () => inspect(env),
        (error) => String(error.stderr).includes(`${name} is not set:`),
      );
    }
    report.status = 'failed';
    const observed = inspect(process.env);
    assert.equal(
      observed.auth.url,
      expectedUrl,
      'the actual request names the caller-selected project',
    );
    assert.equal(
      observed.auth.error,
      undefined,
      'a transport failure is not authorization',
    );
    assert.equal(
      observed.auth.status,
      http.HTTP_STATUS_OK,
      'the real NCBR service must authorize the selected project',
    );
    report.status = 'passed';
  } catch (error) {
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    throw error;
  } finally {
    save();
    console.log(
      `project-permissions report: ${join(directory, 'report.json')}`,
    );
  }
});
