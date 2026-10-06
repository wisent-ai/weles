// Real test of answering an operator request, through the built CLI
// (dist/cli.js) as an operator runs it, against a real request record and a
// real waiting process.
//
// A run that waits on a request watches the record for an answer
// (nextOperatorAnswer). The operator's answer reaches that run: a child
// process opens a request and waits; `weles operator-requests answer <id>
// --not-received --local` is answered, and the child must report exactly that
// answer and its detail. The answer is kept on the record and `show` lists it
// with the command that answers an open request. Refusals: no answer flag, two
// answer flags, and an answer to a request that has closed (no run waits for
// it) are each refused and leave the record unchanged.
//
// The records live under this checkout's ignored build directory
// (WELES_OPERATOR_REQUEST_DIR) and paging is off, so nobody is paged and no
// operator record is touched.
//
// Usage: node tests/operator/answers.mjs   (WELES_CLI selects the built
//   entry point, default dist/cli.js)

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const cli = process.env.WELES_CLI || 'dist/cli.js';
const run = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = resolve('build', 'real-tests', 'operator', run);
const requests = join(root, 'requests');
mkdirSync(requests, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['diff', '--quiet']).status === 0 ? '' : ' (dirty)';
writeFileSync(report, `revision: ${revision}${dirty}\nbinary: ${cli}\nrecords: ${requests}\n`);
const env = { ...process.env, WELES_OPERATOR_REQUEST_DIR: requests, WELES_OPERATOR_REQUEST_PAGING: 'off' };

function weles(args) {
  const result = spawnSync(process.execPath, [cli, 'operator-requests', ...args], { encoding: 'utf8', env });
  appendFileSync(report, `$ weles operator-requests ${args.join(' ')}\nexit ${result.status}\n${result.stdout}${result.stderr}\n`);
  return result;
}

// The waiting run: open a request, then wait for the first answer and print it.
const waiter = `
  const api = await import(${JSON.stringify(resolve('src/operator/request.mjs'))});
  const request = api.openOperatorRequest({ kind: 'test-approval', account: 'test@example.invalid',
    instruction: 'Answer this test request', run: 'operator answers test' });
  process.stdout.write(JSON.stringify({ opened: request.id }) + '\\n');
  const said = await api.nextOperatorAnswer(request.id, 0);
  process.stdout.write(JSON.stringify({ answered: said }) + '\\n');
  api.closeOperatorRequest(request.id, false, 'test run ended after its answer');
`;
const child = spawn(process.execPath, ['--input-type=module', '-e', waiter], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stderr.on('data', (chunk) => { err += chunk; });
const lines = [];
const nextLine = () => new Promise((resolveLine, reject) => {
  const look = () => {
    const end = out.indexOf('\n');
    if (end >= 0) {
      const line = out.slice(0, end);
      out = out.slice(end + 1);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      resolveLine(JSON.parse(line));
    }
  };
  const onData = (chunk) => { out += chunk; look(); };
  const onExit = (code) => reject(new Error(`waiting run exited ${code} before answering: ${err}`));
  child.stdout.on('data', onData);
  child.once('exit', onExit);
  look();
});

try {
  const { opened } = await nextLine();
  lines.push(`opened ${opened}`);

  const none = weles(['answer', opened, '--local']);
  assert.notEqual(none.status, 0, 'an answer without --approved, --not-received or --cancel is refused');
  const both = weles(['answer', opened, '--approved', '--cancel', '--local']);
  assert.notEqual(both.status, 0, 'two answers at once are refused');
  const untouched = JSON.parse(readFileSync(join(requests, `${opened}.json`), 'utf8'));
  assert.equal((untouched.answers ?? []).length, 0, 'a refused answer records nothing');

  const answered = weles(['answer', opened, '--not-received', '--detail', 'no prompt on the phone', '--local']);
  assert.equal(answered.status, 0, `the answer is accepted: ${answered.stderr}`);
  assert.match(answered.stdout, /answered +\S+ not_received: no prompt on the phone/);

  const { answered: said } = await nextLine();
  assert.equal(said.answer, 'not_received', 'the waiting run receives the operator\'s answer');
  assert.equal(said.detail, 'no prompt on the phone');
  await new Promise((resolveExit) => child.once('exit', resolveExit));

  const shown = weles(['show', opened, '--local']);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /answered +\S+ not_received/);
  assert.match(shown.stdout, /closed +\S+/);

  const late = weles(['answer', opened, '--cancel', '--local']);
  assert.notEqual(late.status, 0, 'a closed request refuses an answer: no run waits for it');
  assert.match(late.stdout + late.stderr, /no run waits for an answer/);
  const kept = JSON.parse(readFileSync(join(requests, `${opened}.json`), 'utf8'));
  assert.equal(kept.answers.length, 1, 'the refused late answer is not recorded');

  appendFileSync(report, `${lines.join('\n')}\nresult: passed\n`);
  process.stdout.write(`operator answers: passed (report ${report})\n`);
} catch (error) {
  child.kill();
  appendFileSync(report, `${lines.join('\n')}\nresult: failed: ${error.stack || error}\n`);
  process.stderr.write(`operator answers: failed (report ${report})\n${error.stack || error}\n`);
  process.exitCode = 1;
}
