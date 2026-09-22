import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(root, 'src/_shared/skarbiec-runtime.mjs');
const evidence = resolve(root, '.build/account-security-tests', randomUUID());
mkdirSync(evidence, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(resolve(evidence, 'source-revision.txt'), revision);
writeFileSync(resolve(evidence, 'source.patch'),
  execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root }));
writeFileSync(resolve(evidence, 'source-files.json'), JSON.stringify({
  revision,
  helper_sha256: createHash('sha256').update(readFileSync(helper)).digest('hex'),
  test_sha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
}, null, 2));
let commandNumber = 0;

function command(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8' });
  writeFileSync(resolve(evidence, `command-${++commandNumber}.json`), JSON.stringify({
    revision, executable, arguments: args, exit_status: result.status,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    error: result.error?.message,
  }, null, 2));
  return result;
}

function refused(result) {
  assert.equal(result.error, undefined, 'The actual helper must execute');
  assert.equal(typeof result.status, 'number', 'A signal is not a filesystem refusal');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
}

test('an absent selected Stado executable retains its path and filesystem cause', () => {
  const missing = resolve(evidence, 'absent-selected-stado');
  const result = command(process.execPath, [helper, 'active-binary'], {
    ...process.env, WELES_STADO_BIN: missing,
  });
  refused(result);
  assert.ok(result.stderr.includes(missing), result.stderr);
});

test('an unconfigured runtime reports both real per-user lookup failures', () => {
  const home = resolve(evidence, 'empty-home');
  mkdirSync(home);
  const result = command(process.execPath, [helper, 'active-binary'], {
    ...process.env, WELES_STADO_BIN: '', STADO_BIN: '', HOME: home,
  });
  refused(result);
  for (const relative of ['.stado/bin/stado', '.local/bin/stado']) {
    assert.ok(result.stderr.includes(resolve(home, relative)), result.stderr);
  }
});

test('normal resolution returns the real executable that answers as Skarbiec', () => {
  const selected = command(process.execPath, [helper, 'active-binary']);
  assert.equal(selected.status, 0, selected.stderr);
  const version = command(selected.stdout.trim(), ['--version']);
  assert.equal(version.status, 0, version.stderr);
  const identity = JSON.parse(version.stdout);
  assert.equal(identity.provenance, 'release');
  assert.match(identity.release, /^stado:\/\/releases\/skarbiec\//);
});

test.after(() => {
  rmSync(resolve(evidence, 'empty-home'), { recursive: true, force: true });
  console.log(`Real runtime selection evidence: ${evidence}`);
});
