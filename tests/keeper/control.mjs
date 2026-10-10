import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

export async function keeperControl(
  binary,
  session,
  action,
  cwd,
  report,
  save,
) {
  const args = ['keeper', action, '--session', session];
  const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const { promise, resolve, reject } = Promise.withResolvers();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', reject);
  child.once('close', (code, signal) => {
    report.commands.push({
      command: binary,
      args,
      exit_status: code,
      signal,
      stdout,
      stderr,
    });
    save();
    resolve({ code, signal });
  });
  const { code, signal } = await promise;
  assert.equal(signal, null, stderr);
  assert.ifError(code);
  const answer = JSON.parse(stdout);
  assert.equal(answer.ok, true, stderr);
  assert.equal(answer.session, session);
  return answer;
}
