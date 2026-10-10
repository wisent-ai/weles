// The launcher names every startup step as it begins and as it ends, with
// the instant of each, so a unit log that stops after a `began` line names
// the program still waiting and when it started. This runs one real step
// through the launcher's own `run` (tests/worker/step-lines.mjs: this Node
// asked for its version) and reads the lines it wrote: `began` before the
// step, `ended ... after <n> ms` after it, then the step's answer, in that
// order, and the instants parse as times that do not go backwards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const label = 'the step under test';
const evidence = join(root, 'build', 'real-tests', 'worker-launcher-steps');
mkdirSync(evidence, { recursive: true });
const output = mkdtempSync(join(evidence, 'run-'));
const report = {
  started_at: new Date().toISOString(),
  revision: spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim(),
  node: process.execPath,
  commands: [],
  verdict: 'failed',
};

try {
  const result = spawnSync(
    process.execPath,
    [join(root, 'tests', 'worker', 'step-lines.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, WELES_TEST_STEP_LABEL: label },
    },
  );
  report.commands.push({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(
    result.status,
    Number(process.env.WELES_TEST_SUCCESS_EXIT),
    `the step program was refused: ${result.stderr}`,
  );
  const [began, ended, answer, ...rest] = result.stdout.trim().split('\n');
  const beganAt = began.match(
    new RegExp(`^\\[weles-api\\] ${label}: began (?<at>\\S+)$`),
  );
  assert.ok(beganAt, `the first line names the step's beginning: ${began}`);
  const endedAt = ended.match(
    new RegExp(
      `^\\[weles-api\\] ${label}: ended (?<at>\\S+) after (?<ms>\\d+) ms$`,
    ),
  );
  assert.ok(
    endedAt,
    `the second line names the step's end and duration: ${ended}`,
  );
  assert.ok(
    Date.parse(endedAt.groups.at) >= Date.parse(beganAt.groups.at),
    `the end is not before the beginning: ${began} / ${ended}`,
  );
  assert.equal(
    answer,
    `answer ${process.version}`,
    "the step's answer follows its lines",
  );
  assert.deepEqual(rest, [], `nothing else is written: ${result.stdout}`);
  report.verdict = 'passed';
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(report, null, '  '),
  );
  console.log(`${report.verdict}: ${join(output, 'report.json')}`);
}
