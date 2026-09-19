// Which services a topup can run for, asked of the real orchestrator.
//
// `topup_common.mjs` used to allow four provider names written into the file
// while thirteen trajectories carried a `topup.mjs`, so nine working flows
// were refused by the shared scaffolding and the refusal looked deliberate.
// The orchestrator reads the directory now. This test runs the real entry
// point with an unknown provider and with no provider at all — both answer
// before any card file, credential or browser is touched — and compares the
// names it prints with the trajectories that exist on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const trajectories = join(root, 'src', 'trajectories');
const orchestrator = join(trajectories, '_shared', 'services', 'topup_common.mjs');

/// The trajectories that carry a topup flow, read from the tree itself.
function onDisk() {
  return readdirSync(trajectories, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(trajectories, entry.name, 'topup.mjs')))
    .map((entry) => entry.name)
    .sort();
}

function run(args) {
  try {
    return execFileSync(process.execPath, [orchestrator, ...args], { encoding: 'utf8' });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

test('an unknown provider is refused naming the trajectories that exist', () => {
  const expected = onDisk();
  assert.ok(expected.length > 0, 'no topup trajectory found on disk');
  const output = run(['nosuchprovider', '30']);
  assert.match(output, /BLOCKER: unknown provider nosuchprovider/);
  const allowed = output
    .split('Allowed: ')[1]
    .split('\n')[0]
    .split(', ')
    .map((name) => name.trim());
  assert.deepEqual(allowed, expected);
});

test('the usage line offers exactly those trajectories', () => {
  const output = run([]);
  assert.match(output, /^Usage: node /);
  const offered = output.split('<')[1].split('>')[0].split('|');
  assert.deepEqual(offered, onDisk());
});
