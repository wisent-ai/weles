// Real qualification of the Skarbiec runtime resolver the worker launcher runs
// at start (src/_shared/skarbiec-runtime.mjs) against the Stado this machine
// has installed. It asks Stado itself, through the exact verbs the resolver
// uses, and compares the resolver's answer with Stado's own; nothing is
// mocked, nothing is restarted and no browser opens.
//
// What Stado reports decides what the resolver owes. On a host that manages
// the Skarbiec unit through Stado (the fleet's vault owner) the resolver must
// print the absolute SKARBIEC_CAP_SOCKET Stado declares for that unit. On a
// workstation that manages no Skarbiec unit it must refuse naming the host and
// print no socket. Both runs are evidence; run it on both kinds of host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stadoBinary } from '../../src/_shared/skarbiec-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stado = stadoBinary();
const resolver = join(root, 'src/_shared/skarbiec-runtime.mjs');
const evidence = join(root, 'build', 'real-tests', 'worker-skarbiec-runtime');
mkdirSync(evidence, { recursive: true });
const output = mkdtempSync(join(evidence, 'run-'));
const report = {
  started_at: new Date().toISOString(),
  stado,
  commands: [],
  verdict: 'blocked',
};

function command(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
  report.commands.push({
    program,
    args,
    exit_status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${program} was terminated`);
  return result;
}

// A process that exited by its own success status; any other exit is a refusal.
function exitedClean(result) {
  return result.status !== null && !result.status;
}

function succeeded(program, args) {
  const result = command(program, args);
  assert.ok(exitedClean(result), `${program} refused: ${result.stderr}`);
  return result.stdout;
}

try {
  report.revision = succeeded('git', ['rev-parse', 'HEAD']).trim();
  const host = succeeded(stado, ['registry', 'self', '--name-only']).trim();
  assert.ok(host, 'Stado named no registry target for this host');
  report.host = host;
  const declared = command(stado, [
    'service',
    'env',
    'show',
    'skarbiec',
    '--host',
    host,
    '--json',
  ]);
  const units = exitedClean(declared) ? JSON.parse(declared.stdout) : [];
  const unit = Array.isArray(units) ? units.find((u) => u?.environment) : null;
  report.unit = unit;
  const resolved = command(process.execPath, [resolver, 'capability-socket']);
  if (unit) {
    assert.ok(
      exitedClean(resolved),
      `the resolver refused on a host that manages Skarbiec: ${resolved.stderr}`,
    );
    const socket = resolved.stdout;
    assert.ok(
      isAbsolute(socket),
      `the resolver printed no absolute socket: ${socket}`,
    );
    assert.equal(
      socket,
      unit.environment.SKARBIEC_CAP_SOCKET,
      'the resolver and Stado disagree on SKARBIEC_CAP_SOCKET',
    );
    report.socket = socket;
  } else {
    assert.ok(
      !exitedClean(resolved),
      'the resolver answered on a host without a Skarbiec unit',
    );
    assert.equal(resolved.stdout, '', 'a refusal printed a socket');
    assert.ok(
      resolved.stderr.includes(`Skarbiec unit environment on ${host}`) ||
        resolved.stderr.includes(
          `SKARBIEC_CAP_SOCKET for the Skarbiec unit on ${host}`,
        ),
      `the refusal does not name the host or the operation: ${resolved.stderr}`,
    );
    assert.equal(
      resolved.stderr.includes('unrecognized subcommand'),
      false,
      'the resolver called a verb the installed Stado does not have',
    );
  }
  report.verdict = 'passed';
} catch (error) {
  report.error = String(error.stack || error);
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(report, null, '\t') + '\n',
  );
  console.log(`${report.verdict}: ${join(output, 'report.json')}`);
}
