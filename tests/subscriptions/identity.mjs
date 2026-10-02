#!/usr/bin/env node
// Exercise the real source entrypoints; missing identities must stop before keeper/vault access.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = join(root, '.build/real-tests/subscription-identity');
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(join(outputRoot, 'run-'));
const report = { started_at: new Date().toISOString(), commands: [], status: 'running' };
const hash = data => createHash('sha256').update(data).digest('hex');
const environment = { ...process.env };
delete environment.SESSION;
delete environment.SUBSCRIPTION_ACCOUNT;
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env: environment, encoding: 'utf8' });
  const index = report.commands.length;
  writeFileSync(join(output, `${index}.stdout`), result.stdout ?? '');
  writeFileSync(join(output, `${index}.stderr`), result.stderr ?? '');
  report.commands.push({ argv: [binary, ...args], exit_status: result.status,
    signal: result.signal, error: result.error?.message,
    stdout: `${index}.stdout`, stderr: `${index}.stderr` });
  if (result.error) throw result.error;
  return result;
}
function successful(binary, args) {
  const result = run(binary, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function refuses(args, error) {
  const result = run(process.execPath, args);
  assert.equal(result.status, 1, 'Missing identity did not fail');
  assert(result.stderr.includes(error), `Wrong refusal: ${result.stderr}`);
  assert(!result.stderr.includes('keeper at '), 'Missing identity reached a keeper');
  assert.equal(result.stdout, '', 'Missing identity reported a result');
}
try {
  report.source_revision = successful('git', ['rev-parse', 'HEAD']).trim();
  report.source_diff = successful('git', ['diff', '--', 'src']);
  report.test_sha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
  report.node = { path: process.execPath, version: process.version,
    sha256: hash(readFileSync(process.execPath)) };
  const session = `identity-refusal-${randomUUID()}`;
  for (const collector of ['collect_claude_billing_from_keeper', 'collect_kimi_subscription_from_keeper']) {
    const entrypoint = `src/trajectories/subscriptions/${collector}.mjs`;
    refuses([entrypoint, '--session', session], 'missing --account or SUBSCRIPTION_ACCOUNT');
    refuses([entrypoint, '--session', session, '--account', 'qualification@example.test'],
      'missing --service-credential-id');
  }
  refuses(['src/lib/service_credentials.mjs', 'ensure-kimi-google-sso'],
    'needs an explicit destination credential id');
  report.status = 'passed';
  report.scope = 'Real CLI input refusals only; no authenticated collection or credential write was attempted.';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${join(output, 'report.json')}`);
}
