// Post-build journey of .wisent-release.json: the error standard, asked of
// the weles-worker payload this build staged.
//
// The payload is unpacked from $WISENT_OUTPUT_DIR into the evidence directory
// Stado's build worker retains ($WISENT_TEST_EVIDENCE_DIR), and its own
// `weles errors check` is run against the source tree it was built from: every
// operation that declares how it fails must declare complete causes (what
// failed, why, the state shown, the fix, a code that is not the catch-all),
// each cause's test must exist in tests/, and no error message in src may say
// a failure happened without saying which. A build that breaks the standard
// fails here, naming each problem.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const output = process.env.WISENT_OUTPUT_DIR;
const evidence = process.env.WISENT_TEST_EVIDENCE_DIR;
const source = resolve(import.meta.dirname, '..', '..');

await test('the staged build holds its source to the error standard', () => {
  assert.ok(
    output,
    "WISENT_OUTPUT_DIR is required: Stado's build worker names the output of the build under test",
  );
  assert.ok(
    evidence,
    "WISENT_TEST_EVIDENCE_DIR is required: Stado's build worker names the qualification output it retains",
  );
  const unpacked = join(evidence, 'error-standard', 'payload');
  mkdirSync(unpacked, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    join(output, 'payload', 'weles-worker.tar.gz'),
    '-C',
    unpacked,
    'dist',
    'node_modules',
    'package.json',
  ]);
  const checked = spawnSync(
    process.execPath,
    [
      join(unpacked, 'dist', 'cli.js'),
      'errors',
      'check',
      '--root',
      source,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  writeFileSync(
    join(evidence, 'error-standard', 'check.json'),
    `${JSON.stringify({ exit: checked.status, stdout: checked.stdout, stderr: checked.stderr }, null, 2)}\n`,
  );
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
  const answer = JSON.parse(checked.stdout);
  assert.ok(answer.operations > 0, 'operations declare how they fail');
  assert.deepEqual(answer.problems, []);
});
