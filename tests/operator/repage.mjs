// Real test of asking the operator again when what he was asked for changed
// (Google's phone prompt expired before he approved it), through the request
// store a run uses and the real `stado alerts send` pager with the channels
// the operator chose.
//
// A request is opened as a run opens it; asking again keeps the reason as a
// note and adds one page attempt that went through `stado alerts send`, so the
// record shows every time he was asked and why. Refusals: asking again with no
// reason, and asking again on a closed request, which names when it closed.
// The records live under this checkout's ignored build directory; the pages are
// real and reach the operator through his chosen channels, so they say they
// are a test.
//
// Usage: node tests/operator/repage.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = resolve('build', 'real-tests', 'operator', stamp);
const requests = join(root, 'requests');
mkdirSync(requests, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['diff', '--quiet']).status ? ' (dirty)' : '';
writeFileSync(report, `revision: ${revision}${dirty}\nrecords: ${requests}\n`);
process.env.WELES_OPERATOR_REQUEST_DIR = requests;

const store = await import('../../src/operator/request.mjs');
const record = (label, value) => appendFileSync(report, `${label}: ${JSON.stringify(value, null, 2)}\n`);

try {
  const opened = store.openOperatorRequest({
    kind: 'real-test-repage',
    account: `real-test-${stamp}`,
    run: `tests/operator/repage.mjs ${stamp}`,
    instruction: 'This is a Weles real test of asking you again; nothing waits for you.',
  });
  record('opened', opened);
  const reason = `Google's prompt expired at ${new Date().toISOString()} before it was approved (real test)`;
  const asked = store.repageOperatorRequest(opened.id, reason);
  record('asked again', asked);
  const [added, ...more] = asked.pages.slice(opened.pages.length);
  assert.deepEqual(more, [], 'asking again adds exactly one page attempt');
  assert.ok(added?.ok, `the second page reached the operator's chosen channels: ${added?.detail}`);
  assert.equal([...asked.notes].pop()?.note, reason, 'the reason is kept as a note');

  assert.throws(() => store.repageOperatorRequest(opened.id, ''), /why the operator is asked again/,
    'asking again without a reason is refused');

  store.closeOperatorRequest(opened.id, false, 'real test finished');
  assert.throws(() => store.repageOperatorRequest(opened.id, reason), /closed at .*; it cannot be asked again/,
    'a closed request cannot be asked again');

  appendFileSync(report, 'PASS\n');
  console.log(`PASS: ${report}`);
} catch (error) {
  appendFileSync(report, `FAIL: ${error?.stack || error}\n`);
  console.error(`FAIL (${report})`);
  throw error;
}
