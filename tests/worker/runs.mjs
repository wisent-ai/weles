// Real test of `weles runs`, through the built CLI (dist/cli.js) as an
// operator runs it, against the managed Weles worker.
//
// `list` reads the worker's live runs: every row names its run, action, kind,
// start and the tails of its output. `show` and `cancel` of a run the worker
// never had are refused with run_not_found and change nothing; `cancel`
// without --detail and either verb without a run id are refused with the
// usage status before the worker is reached.
//
// With WELES_TEST_CANCEL_RUN set to a run the operator wants ended (a
// sign-in that stands still), the test cancels it: the cancel answer carries
// the detail, the run leaves `list`, and `show` reads its record as finished
// with failure run_cancelled for a sign-in or cancel_detail for a run.
// Without it nothing is started or ended, so no account is touched.
//
// Usage: node tests/worker/runs.mjs   (WELES_CLI selects the built entry
//   point, default dist/cli.js)

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cli = process.env.WELES_CLI || 'dist/cli.js';
const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = join('build', 'real-tests', 'worker', stamp);
mkdirSync(root, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const dirty =
  spawnSync('git', ['diff', '--quiet']).status === 0 ? '' : ' (dirty)';
writeFileSync(report, `revision: ${revision}${dirty}\nbinary: ${cli}\n`);

function weles(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });
  appendFileSync(
    report,
    `$ weles ${args.join(' ')}\nexit: ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\n\n`,
  );
  return result;
}

function fail(message) {
  appendFileSync(report, `FAIL: ${message}\n`);
  console.error(`FAIL: ${message} (${report})`);
  process.exit(1);
}

function refused(args, status, expected) {
  const result = weles(args);
  if (result.status !== status || !result.stderr.includes(expected)) {
    fail(
      `weles ${args.join(' ')} exited ${result.status}, expected ${status} with '${expected}'`,
    );
  }
  appendFileSync(report, `ok: refused with: ${expected}\n`);
}

const listed = weles(['runs', 'list', '--json']);
if (listed.status !== 0) fail(`weles runs list exited ${listed.status}`);
const rows = JSON.parse(listed.stdout);
if (!Array.isArray(rows)) fail('weles runs list --json printed no list');
for (const row of rows) {
  for (const field of [
    'run_id',
    'action',
    'kind',
    'started_at',
    'stdout_tail',
    'stderr_tail',
  ]) {
    if (!(field in row)) fail(`running run ${row.run_id} has no ${field}`);
  }
}
appendFileSync(report, `ok: ${rows.length} running run(s) listed\n`);

const usageStatus = 2;
refused(['runs', 'show'], usageStatus, 'runs show requires <run-id>');
refused(['runs', 'cancel'], usageStatus, 'runs cancel requires <run-id>');
refused(
  ['runs', 'cancel', randomUUID()],
  usageStatus,
  'runs cancel requires --detail',
);
const unknown = randomUUID();
refused(['runs', 'show', unknown], 1, 'run_not_found');
refused(
  [
    'runs',
    'cancel',
    unknown,
    '--detail',
    'real test: a run the worker never had',
  ],
  1,
  'run_not_found',
);

const target = process.env.WELES_TEST_CANCEL_RUN?.trim();
if (target) {
  const detail = `real test ${stamp}: the operator ends a run that stands still`;
  const cancelled = weles([
    'runs',
    'cancel',
    target,
    '--detail',
    detail,
    '--json',
  ]);
  if (cancelled.status !== 0)
    fail(`weles runs cancel ${target} exited ${cancelled.status}`);
  const answer = JSON.parse(cancelled.stdout);
  if (answer.run_id !== target || answer.cancel_requested?.detail !== detail) {
    fail('the cancel answer does not carry the run and its detail');
  }
  const after = JSON.parse(weles(['runs', 'list', '--json']).stdout);
  if (after.some((row) => row.run_id === target))
    fail(`${target} is still listed as running after cancel`);
  const shown = weles(['runs', 'show', target, '--json']);
  if (shown.status !== 0)
    fail(`weles runs show ${target} exited ${shown.status}`);
  const { record, running } = JSON.parse(shown.stdout);
  if (
    running !== null ||
    record?.status !== 'finished' ||
    record.ok !== false
  ) {
    fail(`${target} is not recorded as finished and failed after cancel`);
  }
  const reason =
    record.failure?.code === 'run_cancelled'
      ? record.failure.message
      : record.cancel_detail;
  if (!reason?.includes(detail))
    fail(`${target}'s record does not keep the cancel detail`);
  appendFileSync(report, `ok: ${target} cancelled and recorded: ${reason}\n`);
}

appendFileSync(report, 'PASS\n');
console.log(`PASS: ${report}`);
