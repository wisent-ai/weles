import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readOperatorRequest } from '../../src/operator/request.mjs';
import { nextApprovalEvent } from '../../src/trajectories/_shared/services/google_sso/sign_in/challenge/wait.mjs';

const file = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

if (process.argv.includes('--observe')) {
  assert.ok(
    !process.env.WELES_STANDALONE,
    'dedicated host placement must remain enforced',
  );
  assert.ok(
    !process.env.ACCOUNT_ID,
    'this journey must not open an operator account profile',
  );
  const id = process.env.WELES_OPERATOR_REQUEST_ID;
  assert.ok(
    id,
    'WELES_OPERATOR_REQUEST_ID must name a real existing operator request',
  );
  const before = readOperatorRequest(id);
  assert.ok(
    Array.isArray(before.answers),
    'the real request must carry its answer history',
  );
  const { WSession } = await import('../../dist/session/wsession.js');
  const session = await WSession.start({
    label: `approval-cancellation-${randomUUID()}`,
  });
  try {
    const navigation = session.page.waitForEvent('framenavigated');
    const answer = nextApprovalEvent(navigation, id, before.answers.length);
    const refused = assert.rejects(answer);
    await session.page.close();
    await refused;
    assert.deepEqual(
      readOperatorRequest(id),
      before,
      'observing and cancelling must not answer the request',
    );
    console.log(
      JSON.stringify({ result: 'page_failure_propagated', request: id }),
    );
  } finally {
    await session.close();
  }
  // Natural child termination proves the abandoned operator watcher no longer holds it alive.
} else {
  await test('a real browser closure releases the pending operator watcher', async () => {
    const directory = join(
      root,
      'build/real-tests/approval-cancellation',
      randomUUID(),
    );
    mkdirSync(directory, { recursive: true });
    const command = [file, '--observe'];
    const report = {
      source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      host: hostname(),
      command: [process.execPath, ...command],
      status: 'failed',
      stdout: '',
      stderr: '',
    };
    const save = () =>
      writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
    save();
    const child = spawn(process.execPath, command, {
      cwd: root,
      env: {
        ...process.env,
        WELES_RECORDINGS_ROOT: join(directory, 'recordings'),
        WELES_RUN_ID: randomUUID(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      report.stdout += text;
      save();
    });
    child.stderr.on('data', (text) => {
      report.stderr += text;
      save();
    });
    const completion = Promise.withResolvers();
    child.once('error', completion.reject);
    child.once('close', (code, signal) => completion.resolve({ code, signal }));
    const result = await completion.promise;
    report.exit_status = result.code;
    report.signal = result.signal;
    save();
    assert.equal(result.signal, null);
    assert.ifError(result.code);
    report.status = 'passed';
    save();
  });
}
