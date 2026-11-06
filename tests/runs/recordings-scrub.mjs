// What `weles recordings scrub` does to stored runs, through the built CLI
// (dist/cli.js) against a run-owned recordings directory:
//   - every session_meta.json still holding env_all is rewritten to env_names,
//     the sorted variable names, with no value left in the file: a secret
//     under a name no pattern would catch (AWS_ACCESS_KEY_ID), one under a
//     secret-looking name, and one an older sanitizer redacted alike;
//   - an envelope that already records env_names, and one without either,
//     are left as they were and counted clean;
//   - an envelope that is not JSON is listed under failed with its cause, the
//     other envelopes are still scrubbed, and the command exits non-zero;
//   - with WELES_RECORDINGS_ROOT unset the command is refused naming it.
// The secrets written are this test's own random strings, never a real one.
//
// Usage: npm run build && node --test tests/runs/recordings-scrub.mjs
// With WELES_TEST_DEFECT and WELES_TEST_CRITERION named together, a passing
// run on committed source writes criterion.json under
// build/real-tests/runs/recordings-scrub-<stamp>/.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const defectId = process.env.WELES_TEST_DEFECT?.trim();
const criterion = process.env.WELES_TEST_CRITERION?.trim();
assert.equal(
  Boolean(defectId),
  Boolean(criterion),
  'WELES_TEST_DEFECT and WELES_TEST_CRITERION are named together or not at all',
);

// The shell's statuses (https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html).
const SUCCEEDED = 0;

const commands = [];
function run(executable, args, env) {
  const result = spawnSync(executable, args, { encoding: 'utf8', env });
  commands.push({
    executable,
    args,
    exit: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return result;
}
function git(...args) {
  const result = run('git', ['-C', root, ...args], process.env);
  assert.equal(result.status, SUCCEEDED, result.stderr);
  return result.stdout.trim();
}
const revision = git('rev-parse', 'HEAD');
const uncommitted = git(
  'status',
  '--porcelain',
  '--',
  'src/cli',
  'src/cli.ts',
  'src/utils/sanitize-env.ts',
  'src/session/wsession/run-provenance.ts',
  'src/diagnostics/runs/run-import.ts',
  'tests/runs',
);
assert.ok(
  !defectId || uncommitted === '',
  'commit the scrub command and this test before qualification',
);

const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const output = resolve(
  root,
  'build',
  'real-tests',
  'runs',
  `recordings-scrub-${stamp}`,
);
const recordings = join(output, 'recordings');
mkdirSync(recordings, { recursive: true });

function envelope(name, content) {
  const directory = join(recordings, randomUUID(), name);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'session_meta.json');
  writeFileSync(path, content);
  return path;
}

function scrub(env) {
  return run(process.execPath, [cli, 'recordings', 'scrub', '--json'], env);
}

const secret = `test-secret-${randomUUID()}`;
const keyId = `test-key-id-${randomUUID()}`;
const leaked = envelope(
  'leaked',
  JSON.stringify({
    started_at: stamp,
    env_all: { STRIPE_SECRET_KEY: secret, AWS_ACCESS_KEY_ID: keyId, LANG: 'C' },
  }),
);
const redacted = envelope(
  'redacted',
  JSON.stringify({ env_all: { GITHUB_TOKEN: '[REDACTED]', LANG: 'C' } }),
);
const cleanEnvelopes = [
  envelope('named', JSON.stringify({ env_names: ['GITHUB_TOKEN', 'LANG'] })),
  envelope('bare', JSON.stringify({ started_at: stamp })),
];
const broken = envelope('broken', '{"env_all": ');
const before = new Map(
  cleanEnvelopes.map((path) => [path, readFileSync(path, 'utf8')]),
);
const observed = {};

const registered = [];
const completed = [];
function journey(name, body) {
  registered.push(name);
  test(name, () => {
    body();
    completed.push(name);
  });
}

journey(
  'every recorded environment becomes its names and no value remains',
  () => {
    const result = scrub({ ...process.env, WELES_RECORDINGS_ROOT: recordings });
    observed.scrub = { exit: result.status, stdout: result.stdout };
    assert.notEqual(
      result.status,
      SUCCEEDED,
      'an unreadable envelope must make the scrub fail',
    );
    const answer = JSON.parse(result.stdout);
    assert.deepEqual([...answer.scrubbed].sort(), [leaked, redacted].sort());
    const rewritten = JSON.parse(readFileSync(leaked, 'utf8'));
    assert.equal(rewritten.env_all, undefined);
    assert.deepEqual(rewritten.env_names, [
      'AWS_ACCESS_KEY_ID',
      'LANG',
      'STRIPE_SECRET_KEY',
    ]);
    assert.equal(rewritten.started_at, stamp);
    const text = readFileSync(leaked, 'utf8');
    assert.ok(
      !text.includes(secret) && !text.includes(keyId),
      'no recorded value is left in the file',
    );
    assert.deepEqual(JSON.parse(readFileSync(redacted, 'utf8')).env_names, [
      'GITHUB_TOKEN',
      'LANG',
    ]);
    assert.deepEqual(
      answer.failed.map(({ file }) => file),
      [broken],
    );
    assert.match(answer.failed.map(({ error }) => error).join(' '), /JSON/);
    assert.equal(answer.clean, cleanEnvelopes.length);
  },
);

journey('clean envelopes are left byte for byte', () => {
  for (const [path, text] of before)
    assert.equal(readFileSync(path, 'utf8'), text, path);
});

journey('an unset recordings root is refused by name', () => {
  const env = { ...process.env };
  delete env.WELES_RECORDINGS_ROOT;
  const result = scrub(env);
  observed.unset = { exit: result.status, stderr: result.stderr };
  assert.notEqual(result.status, SUCCEEDED);
  assert.match(result.stderr, /WELES_RECORDINGS_ROOT/);
});

after(() => {
  if (!defectId || completed.length !== registered.length) return;
  const digest = (path) =>
    createHash('sha256').update(readFileSync(path)).digest('hex');
  const path = join(output, 'criterion.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        defectId,
        criterion,
        sourceRevision: revision,
        result: 'passed',
        binarySha256: digest(cli),
        testSha256: digest(fileURLToPath(import.meta.url)),
        observedFinalState: { cases: completed, observed },
        commands,
      },
      null,
      '  ',
    )}\n`,
    { mode: constants.S_IRUSR | constants.S_IWUSR },
  );
  console.log(`criterion report: ${path}`);
});
