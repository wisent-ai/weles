/**
 * Run the actual worker startup with the published native dependency.
 * Stado supplies WISENT_INPUT_JEDEN_RUNTIME_DIR; local runs can supply its
 * archive through WELES_TEST_JEDEN_ARCHIVE. The fleet CLI is real.
 * Source identity, commands and observed refusals remain in .wisent-output.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stadoBinary } from '../../src/_shared/skarbiec-runtime.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const input = process.env.WISENT_INPUT_JEDEN_RUNTIME_DIR;
const archive = input ? null : process.env.WELES_TEST_JEDEN_ARCHIVE;
const stado = stadoBinary();
assert.ok((input || archive) && existsSync(input || archive),
  'WISENT_INPUT_JEDEN_RUNTIME_DIR or WELES_TEST_JEDEN_ARCHIVE must name the real published native input');
const output = join(REPO, '.wisent-output', 'native-runtime-tests', randomUUID());
const scratch = join(output, 'scratch');
mkdirSync(scratch, { recursive: true });
const report = {
  source_revision: process.env.WISENT_SOURCE_COMMIT ?? null,
  source_patch: null,
  native_input_directory: input ? resolve(input) : null,
  native_archive: archive ? resolve(archive) : null,
  native_archive_sha256: archive ? createHash('sha256').update(readFileSync(archive)).digest('hex') : null,
  native_binary_sha256: {},
  commands: [],
};
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Native runtime evidence: ${join(output, 'report.json')}`);
});

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: REPO, encoding: 'utf8', ...options });
  const index = report.commands.length;
  writeFileSync(join(output, `${index}.stdout`), result.stdout ?? '');
  writeFileSync(join(output, `${index}.stderr`), result.stderr ?? '');
  report.commands.push({
    program, args, cwd: options.cwd ?? REPO, exit_code: result.status,
    signal: result.signal, error: result.error?.message ?? null,
    stdout: `${index}.stdout`, stderr: `${index}.stderr`,
  });
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return result;
}

if (report.source_revision) {
  assert.match(report.source_revision, /^[0-9a-f]{40}$/, 'Stado must export the full source commit');
} else {
  const revision = command('git', ['rev-parse', 'HEAD']);
  assert.equal(revision.status, 0, revision.stderr);
  report.source_revision = revision.stdout.trim();
  const patch = command('git', ['diff', '--binary', 'HEAD']);
  assert.equal(patch.status, 0, patch.stderr);
  writeFileSync(join(output, 'source.patch'), patch.stdout);
  report.source_patch = 'source.patch';
}
const native = join(scratch, 'input');
mkdirSync(native);
if (archive) {
  const extracted = command('tar', ['-xzf', resolve(archive), '-C', native]);
  assert.equal(extracted.status, 0, extracted.stderr);
} else {
  mkdirSync(join(native, 'bin'));
  for (const name of ['jeden', 'jeden-sandbox-helper']) {
    copyFileSync(join(input, 'bin', name), join(native, 'bin', name));
  }
}
for (const name of ['jeden', 'jeden-sandbox-helper']) {
  report.native_binary_sha256[name] = createHash('sha256')
    .update(readFileSync(join(native, 'bin', name))).digest('hex');
  const version = command(join(native, 'bin', name), ['--version']);
  assert.equal(version.status, 0, `${name} is not a working native input: ${version.stderr}`);
}


function fixture(name, helper = true, input = native) {
  const root = join(scratch, name);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  for (const relative of ['src/worker/weles-api-launcher.mjs', 'src/_shared/skarbiec-runtime.mjs']) {
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(REPO, relative), destination);
  }
  const bin = join(root, 'native', 'jeden', 'bin');
  const staged = command(process.execPath, [
    join(REPO, 'release/native/runtime.mjs'), 'stage', bin, input,
  ]);
  assert.equal(staged.status, 0, staged.stderr);
  if (!helper) rmSync(join(bin, 'jeden-sandbox-helper'));
  return { root, home, bin };
}

function startup({ root, home }) {
  return command(process.execPath, [join(root, 'src/worker/weles-api-launcher.mjs')], {
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      NODE_BIN: process.execPath,
      STADO_BIN: resolve(stado),
      STADO_CONFIG: join(home, 'absent-stado-config.json'),
      WELES_API_PORT: '0',
      // A complete, real external runtime must not hide a broken bundle.
      WELES_JEDEN_BIN: join(native, 'bin', 'jeden'),
    },
  });
}

function noBroker(home) {
  assert.equal(existsSync(join(home, '.stado/run/weles-api-capability.sock')), false,
    'a refused startup created a capability broker');
}

test('a missing bundled helper refuses despite a complete external Jeden', () => {
  const value = fixture('missing-helper', false);
  const result = startup(value);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(join(value.bin, 'jeden-sandbox-helper')), result.stderr);
  noBroker(value.home);
});

test('an executable but corrupt bundled helper refuses before credentials', () => {
  const value = fixture('corrupt-helper');
  truncateSync(join(value.bin, 'jeden-sandbox-helper'), 8);
  const result = startup(value);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(join(value.bin, 'jeden-sandbox-helper')), result.stderr);
  assert.doesNotMatch(result.stderr, /Skarbiec endpoint resolution/);
  noBroker(value.home);
});

test('the complete signed native pair reaches the real missing-directory refusal', () => {
  const value = fixture('complete', true, archive ?? native);
  const result = startup(value);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Skarbiec endpoint resolution refused/);
  noBroker(value.home);
});

test('an archive outside the declared digest is refused before staging bytes', () => {
  const wrong = join(scratch, 'wrong-native.tar.gz');
  const destination = join(scratch, 'untrusted', 'bin');
  copyFileSync(join(native, 'bin', 'jeden'), wrong);
  const result = command(process.execPath, [
    join(REPO, 'release/native/runtime.mjs'), 'stage', destination, wrong,
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SHA-256/);
  assert.equal(existsSync(destination), false, 'unverified input reached the staged runtime');
});
