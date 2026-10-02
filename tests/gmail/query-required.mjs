import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

// Exercise the actual entry point with no workload identity. Neither the old
// credential refusal nor the query refusal can start a browser in these cases.
const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'src/trajectories/gmail/gmail_login_search.mjs');
const evidence = await evidenceFor('gmail-query-required');
evidence.report.scope = 'real_cli_preflight_refusals_only';
evidence.report.browser_flow = 'not_run';
evidence.report.node_version = process.version;
evidence.report.source_sha256 = createHash('sha256').update(await readFile(entry)).digest('hex');
const failures = [];
try {
  for (const scenario of [{ name: 'missing' }, { name: 'whitespace', query: ' \t\n ' }]) {
    const home = await mkdtemp(join(root, 'build/real-tests/gmail-query-required/home-'));
    const overrides = {
      HOME: home, WELES_RECORDINGS_ROOT: join(home, 'recordings'),
      WELES_RUN_OUTPUT_DIR: join(home, 'runs'),
      WELES_CREDENTIALS_FILE: '', SKARBIEC_WORKLOAD_ID: '', SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: '',
    };
    const environment = { ...process.env, ...overrides };
    delete environment.GM_QUERY;
    if (scenario.query !== undefined) environment.GM_QUERY = scenario.query;
    const operation = {
      scenario: scenario.name, command: [process.execPath, entry], cwd: home,
      environment_overrides: overrides, query: scenario.query ?? null,
    };
    evidence.report.operations.push(operation);
    try {
      const result = spawnSync(process.execPath, [entry], {
        cwd: home, env: environment, encoding: 'utf8',
      });
      Object.assign(operation, {
        exit_status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
        error: result.error?.message ?? null, home_entries_after: await readdir(home, { recursive: true }),
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(`${result.stdout}\n${result.stderr}`, /GMAIL_QUERY_REQUIRED/);
      assert.equal(operation.home_entries_after.some(path =>
        path === 'recordings' || path.startsWith('recordings/') || path === 'runs' || path.startsWith('runs/')),
      false, 'a refused query must not create browser-run artifacts');
      operation.status = 'passed';
    } catch (error) {
      operation.status = 'failed';
      operation.failure = error.message;
      failures.push(`${scenario.name}: ${error.message}`);
    } finally {
      await rm(home, { recursive: true });
    }
  }
  evidence.report.status = failures.length ? 'failed' : 'passed';
  evidence.report.failures = failures;
  if (failures.length) process.exitCode = 1;
} catch (error) {
  evidence.report.status = 'failed';
  evidence.report.failure = error.message;
  process.exitCode = 1;
} finally {
  await evidence.finish();
}
