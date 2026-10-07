// Real test of answering a run that waits for a person, through the built CLI
// (dist/cli.js) as an operator runs it, against the managed Weles worker the
// CLI resolves (stado service directory connect weles-admission, or
// WELES_WORKER_API_BASE with WELES_WORKER_TOKEN).
//
// A run that waits for a person names its request in `weles runs show`, and
// `weles runs answer <run> --approved | --not-received` writes the answer on
// the request that run watches. The test answers a run that really waits
// (--waiting-run, a run whose `runs show` names a request, for example a Google
// phone approval) with --approved, which makes the run read the page and note
// what Google shows, and checks the answer is on the request the run waits on.
// Refusals: the removed `weles operator-requests` command, a missing run id,
// no answer flag, both answer flags, an unknown run, and a finished run
// (--finished-run). Without a waiting run named the test does not pass: it is
// blocked, and says so.
//
// Usage: node tests/runs/answer.mjs --waiting-run <run-id> --finished-run <run-id>
//   (WELES_CLI selects the built entry point, default dist/cli.js)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const cli = process.env.WELES_CLI || 'dist/cli.js';
const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = resolve('build', 'real-tests', 'runs', stamp);
mkdirSync(root, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['diff', '--quiet']).status === 0 ? '' : ' (dirty)';
writeFileSync(report, `revision: ${revision}${dirty}\nbinary: ${cli}\n`);

function weles(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  appendFileSync(report, `$ weles ${args.join(' ')}\nexit ${result.status}\n${result.stdout}${result.stderr}\n`);
  return result;
}

function showJson(runId) {
  const shown = weles(['runs', 'show', runId, '--json']);
  assert.equal(shown.status, 0, `runs show ${runId} answers: ${shown.stderr}`);
  return JSON.parse(shown.stdout);
}

try {
  const { values } = parseArgs({ options: { 'waiting-run': { type: 'string' }, 'finished-run': { type: 'string' } } });
  const waitingRun = values['waiting-run'];
  const finishedRun = values['finished-run'];
  assert.ok(finishedRun, '--finished-run must name a run the worker has finished');

  const removed = weles(['operator-requests', 'list']);
  assert.equal(removed.status, 2, 'the removed operator-requests command is a usage error');
  assert.match(removed.stderr, /unknown command: operator-requests/);

  const noRun = weles(['runs', 'answer', '--approved']);
  assert.equal(noRun.status, 2, 'an answer without a run id is a usage error');
  const target = waitingRun || finishedRun;
  const noFlag = weles(['runs', 'answer', target]);
  assert.equal(noFlag.status, 2, 'an answer without --approved or --not-received is a usage error');
  assert.match(noFlag.stderr, /exactly one of --ready, --approved or --not-received/);
  const both = weles(['runs', 'answer', target, '--ready', '--not-received']);
  assert.equal(both.status, 2, 'two answers at once are a usage error');

  const unknown = weles(['runs', 'answer', randomUUID(), '--approved']);
  assert.equal(unknown.status, 1, 'an unknown run is refused');
  assert.match(unknown.stderr, /run_not_found/);

  const finished = weles(['runs', 'answer', finishedRun, '--approved']);
  assert.equal(finished.status, 1, 'a finished run waits for no answer');
  assert.match(finished.stderr, /run_not_running_here: the run finished at/);

  if (!waitingRun) {
    appendFileSync(report, 'result: blocked: no --waiting-run named; the success path was not exercised\n');
    process.stderr.write(`runs answer: blocked, no waiting run named (report ${report})\n`);
    process.exitCode = 1;
  } else {
    const before = showJson(waitingRun);
    const request = before.running?.operator_request;
    assert.ok(request, `run ${waitingRun} must wait for a person; runs show names no request`);
    const answeredBefore = (request.answers ?? []).length;
    const detail = `runs answer real test ${stamp}`;
    const answered = weles(['runs', 'answer', waitingRun, '--approved', '--detail', detail]);
    assert.equal(answered.status, 0, `the answer is accepted: ${answered.stderr}`);
    assert.match(answered.stdout, new RegExp(`answered +\\S+ approved: ${detail}`));
    const after = showJson(waitingRun);
    const kept = after.running?.operator_request;
    assert.ok(kept, 'the run still waits on its request after an approval Google has not seen');
    assert.equal(kept.id, request.id, 'the answer lands on the request the run waits on');
    assert.equal(kept.answers.length, answeredBefore + 1);
    assert.deepEqual(
      { answer: kept.answers.at(-1).answer, detail: kept.answers.at(-1).detail },
      { answer: 'approved', detail },
    );
    appendFileSync(report, 'result: passed\n');
    process.stdout.write(`runs answer: passed (report ${report})\n`);
  }
} catch (error) {
  appendFileSync(report, `result: failed: ${error.stack || error}\n`);
  process.stderr.write(`runs answer: failed (report ${report})\n${error.stack || error}\n`);
  process.exitCode = 1;
}
