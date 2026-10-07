// Real test that a worker run ends once its trajectory has written its verdict,
// through the built CLI (dist/cli.js) against the managed Weles worker the CLI
// resolves (stado service directory connect weles-admission, or
// WELES_WORKER_API_BASE with WELES_WORKER_TOKEN).
//
// A Google authenticator enrolment wrote its result and then stood for twenty
// minutes in the close-time fingerprint probe's WebRTC section, so `weles runs
// list` kept showing a run that had already answered. Every worker run now
// closes its browser without that probe (WELES_FINGERPRINT=0 from
// runChildIdentity). The test reads one run that closed a browser session
// (--run, any trajectory the released worker ran, for example a
// google_authenticator_enrol or a sign-in) and checks: no live child answers
// for it, its record is finished, the session closed (`[wsession] close()` in
// its output), and no probe section ran after that. A run still running, or
// one that never closed a session, does not pass, and the test names which.
//
// Refusals: no --run (the test reports itself blocked and exits nonzero) and
// an unknown run (`weles runs show` refuses it).
//
// Usage: node tests/runs/close_probe.mjs --run <run-id>
//   (WELES_CLI selects the built entry point, default dist/cli.js)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const CLOSED = '[wsession] close()';
const PROBE = 'fingerprint probe';

const cli = process.env.WELES_CLI || 'dist/cli.js';
const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = resolve('build', 'real-tests', 'runs', `close-probe-${stamp}`);
mkdirSync(root, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() ? ' (dirty)' : '';
writeFileSync(report, `revision: ${revision}${dirty}\nbinary: ${cli}\n`);

function weles(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  appendFileSync(report, `$ weles ${args.join(' ')}\nexit ${result.status}\n${result.stdout}${result.stderr}\n`);
  return result;
}

const { values } = parseArgs({ options: { run: { type: 'string' } } });
if (!values.run) {
  appendFileSync(report, 'result: blocked: --run names no run that closed a browser session\n');
  throw new Error(`blocked: name a finished worker run with --run; report ${report}`);
}

try {
  const shown = weles(['runs', 'show', values.run, '--json']);
  assert.ok(!shown.status, `runs show ${values.run} answers: ${shown.stderr}`);
  const answer = JSON.parse(shown.stdout);
  assert.ok(!answer.running,
    `run ${values.run} still has a live child: it last wrote at ${answer.running?.last_output_at}, ending with ${String(answer.running?.stdout_tail).split('\n').pop()}`);
  const record = answer.record;
  assert.ok(record && record.status !== 'running', `run ${values.run} has no finished record: ${JSON.stringify(record)}`);
  const output = String(record.stdout_tail ?? '');
  assert.ok(output.includes(CLOSED),
    `run ${values.run} closed no browser session in its kept output, so it says nothing about the close-time probe`);
  const afterClose = output.slice(output.lastIndexOf(CLOSED));
  assert.ok(!afterClose.includes(PROBE),
    `run ${values.run} ran the close-time fingerprint probe after closing: ${afterClose.slice(afterClose.indexOf(PROBE)).split('\n').shift()}`);

  const unknown = randomUUID();
  const refused = weles(['runs', 'show', unknown, '--json']);
  assert.ok(refused.status, `runs show ${unknown} refuses an unknown run`);
  const missing = spawnSync(process.execPath, ['tests/runs/close_probe.mjs'], { encoding: 'utf8' });
  assert.ok(missing.status && missing.stderr.includes('blocked: name a finished worker run with --run'),
    `the test refuses a missing --run as blocked: exit ${missing.status}, ${missing.stderr}`);

  appendFileSync(report, 'result: passed\n');
  console.log(`passed; report ${report}`);
} catch (error) {
  appendFileSync(report, `result: failed: ${error.message}\n`);
  throw error;
}
