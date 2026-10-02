import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('feng-selector-preflight');
evidence.report.scope = 'preflight_refusals_only';
evidence.report.browser_flow = 'not_run';
evidence.report.node_version = process.version;
evidence.report.source_sha256 = {};
for (const path of [
  'src/trajectories/feng/dump_selectors.mjs',
  'src/trajectories/feng/operator/actions.mjs',
  'tests/feng/selector-preflight.mjs',
]) {
  evidence.report.source_sha256[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
}
const failures = [];
try {
  for (const scenario of [
    { name: 'missing_values', code: 'FENG_VALUES_MISSING' },
    { name: 'malformed_values', code: 'FENG_JSON_READ_FAILED', content: '{' },
  ]) {
    const home = await mkdtemp(join(root, 'build/real-tests/feng-selector-preflight/home-'));
    const values = join(home, 'values.json');
    const entry = join(root, 'src/trajectories/feng/dump_selectors.mjs');
    const overrides = { HOME: home, FENG_VALUES: values, WELES_RUN_OUTPUT_DIR: join(home, 'runs') };
    const operation = { scenario: scenario.name, command: [process.execPath, entry], cwd: home, environment_overrides: overrides };
    evidence.report.operations.push(operation);
    try {
      if (scenario.content !== undefined) await writeFile(values, scenario.content);
      const before = await readdir(home, { recursive: true });
      const result = spawnSync(process.execPath, [entry], {
        cwd: home, env: { ...process.env, ...overrides }, encoding: 'utf8',
      });
      Object.assign(operation, {
        exit_status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
        error: result.error?.message ?? null, home_entries_before: before,
        home_entries_after: await readdir(home, { recursive: true }),
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null, 'the preflight must refuse through its CLI result');
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(result.stderr.includes(scenario.code), `missing refusal code ${scenario.code}: ${result.stderr}`);
      assert.ok(result.stderr.includes(values), 'the refusal must identify the input file');
      if (scenario.content !== undefined) {
        assert.ok(result.stderr.includes('SyntaxError'), 'the refusal must retain the JSON parser cause');
        assert.equal(await readFile(values, 'utf8'), scenario.content, 'the refused input must remain unchanged');
      }
      assert.deepEqual(operation.home_entries_after, before, 'invalid input must not start a browser run or write output');
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
