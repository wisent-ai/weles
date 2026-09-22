import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.build/installation-tests', randomUUID());
mkdirSync(evidence, { recursive: true });
let commandNumber = 0;

function command(program, args, env = process.env) {
  const result = spawnSync(program, args, { cwd: root, env, encoding: 'utf8' });
  writeFileSync(resolve(evidence, `command-${++commandNumber}.json`), JSON.stringify({
    program, args, cwd: root, exit_status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
  }, null, 2));
  return result;
}

function successful(program, args) {
  const result = command(program, args);
  assert.equal(result.status, 0, `${program}: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

test('managed installation provides the current CLI and refuses account mutations', () => {
  const revision = successful('git', ['rev-parse', 'HEAD']);
  const patch = successful('git', ['diff', '--binary', 'HEAD']);
  writeFileSync(resolve(evidence, 'source-revision.txt'), `${revision}\n`);
  writeFileSync(resolve(evidence, 'working.patch'), patch);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const install = successful('wisent-products', ['install', 'weles', '--surface', 'cli', '--json']);
  writeFileSync(resolve(evidence, 'installation-output.txt'), install);
  const status = successful('wisent-products', ['status', 'weles', '--surface', 'cli', '--json']);
  writeFileSync(resolve(evidence, 'installed-status.json'), status);

  const executable = resolve(homedir(), '.local/bin/weles');
  assert.equal(successful(executable, ['version']), manifest.version);

  // No exact account or endpoint is supplied: this checks the installed
  // command's local argument boundary, never a provider workflow.
  const env = { ...process.env };
  delete env.WELES_WORKER_API_BASE;
  delete env.WELES_WORKER_TOKEN;
  for (const args of [
    ['account-security'],
    ['account-security', '--enable'],
    ['account-security', '--login-item', '--run'],
  ]) {
    const refusal = command(executable, args, env);
    assert.equal(refusal.error, undefined, 'The installed command must start, not fail process creation');
    assert.equal(refusal.signal, null, 'A refusal must complete, not crash');
    assert.equal(refusal.status, 1, JSON.stringify(refusal));
    assert.equal(refusal.stdout.trim(), '', 'A refused request must not emit an accepted run');
  }
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
    source_revision: revision, installed_version: manifest.version,
    outcome: 'passed', scope: 'owner-local CLI installation and argument refusals only',
    google_observation: false, worker_deployed: false, gui_exercised: false,
  }, null, 2));
  console.log(`Retained installation evidence: ${evidence}`);
});
