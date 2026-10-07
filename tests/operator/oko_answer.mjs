// Real test that an answer given in Oko reaches the run waiting on a Weles
// request, through the request store a run uses, the real `oko` CLI signed in
// to a disposable account, and the shared Oko database.
//
// A request is opened as a run opens it: it is asked through Oko with the
// run's answers (ready, approved, not_received) as the ask's choices, and the
// request waits on the ask with `oko asks wait`. The test then answers the ask
// the way Oko Desktop and Oko iOS do (`oko asks answer <ask> --text approved
// --on oko-weles-test`) and checks that the waiting side receives that answer
// from nextOperatorAnswer, recorded as answered in Oko. Refusal: an answer
// outside the choices is refused by Oko naming them. The records live under
// this checkout's ignored build directory.
//
// Usage: OKO_TEST_ASKS_DISPOSABLE_ACCOUNT=<signed-in email> node tests/operator/oko_answer.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const account = process.env.OKO_TEST_ASKS_DISPOSABLE_ACCOUNT;
if (!account) throw new Error('blocked: name the disposable signed-in Oko account in OKO_TEST_ASKS_DISPOSABLE_ACCOUNT');

const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = resolve('build', 'real-tests', 'operator', `oko-answer-${stamp}`);
const requests = join(root, 'requests');
mkdirSync(requests, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() ? ' (dirty)' : '';
writeFileSync(report, `revision: ${revision}${dirty}\nrecords: ${requests}\n`);
process.env.WELES_OPERATOR_REQUEST_DIR = requests;

const oko = (args) => {
  const result = spawnSync(process.env.WELES_OKO_BIN || 'oko', args, { encoding: 'utf8' });
  appendFileSync(report, `$ oko ${args.join(' ')}\nexit ${result.status}\n${result.stdout}${result.stderr}\n`);
  return result;
};

const signedIn = JSON.parse(oko(['database', 'check']).stdout);
assert.equal(signedIn.email, account, 'the signed-in Oko account is the disposable one');

const store = await import('../../src/operator/request.mjs');

try {
  const opened = store.openOperatorRequest({
    kind: 'real-test-oko-answer',
    account: `real-test-${stamp}`,
    run: `tests/operator/oko_answer.mjs ${stamp}`,
    instruction: 'This is a Weles real test of answering in Oko; nothing waits for you.',
  });
  const asked = opened.pages.find((attempt) => attempt.channel === 'oko-asks');
  assert.ok(asked?.ok && asked.ask_id, `the request was asked through Oko: ${asked?.detail}`);

  const shown = JSON.parse(oko(['asks', 'show', asked.ask_id]).stdout);
  assert.deepEqual(shown.ask.choices, [...store.OPERATOR_ANSWERS], 'the ask offers the run\'s answers as choices');

  const outside = oko(['asks', 'answer', asked.ask_id, '--text', 'maybe', '--on', 'oko-weles-test']);
  assert.ok(outside.status, 'an answer outside the choices is refused');
  assert.match(outside.stderr, /takes one of its choices/);

  const answersSoFar = (opened.answers ?? []).length;
  const received = store.nextOperatorAnswer(opened.id, answersSoFar);
  const answered = oko(['asks', 'answer', asked.ask_id, '--text', 'approved', '--on', 'oko-weles-test']);
  assert.ok(!answered.status, `Oko took the answer: ${answered.stderr}`);
  const answer = await received;
  appendFileSync(report, `received: ${JSON.stringify(answer)}\n`);
  assert.equal(answer.answer, 'approved', 'the waiting side receives the answer given in Oko');
  assert.match(answer.detail, /answered in Oko on oko-weles-test/);

  store.closeOperatorRequest(opened.id, true, 'real test finished');
  appendFileSync(report, 'PASS\n');
  console.log(`PASS: ${report}`);
} catch (error) {
  appendFileSync(report, `FAIL: ${error?.stack || error}\n`);
  console.error(`FAIL (${report})`);
  throw error;
}
