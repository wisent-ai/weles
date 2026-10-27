// The TypeScript errors of one committed revision of Weles, one per line, as
// the locked compiler reports them; an empty answer means the revision
// compiles. The revision's tree is exported from Git into the checkout's
// ignored .build directory, given this checkout's installed node_modules,
// typechecked there with node_modules/.bin/tsc --noEmit -p ., and removed, so
// uncommitted work in the checkout never decides the answer.
//
// Usage: node tests/build/typecheck-revision.mjs <revision>
// Exits nonzero, naming the step and its cause, when the tree cannot be
// exported or the compiler cannot run; compiler errors are the inventory and
// exit zero.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAILED = Math.sign(Infinity);
const root = fileURLToPath(new URL('../../', import.meta.url));
const [revision] = process.argv.slice(FAILED + FAILED);
let tree;

/** Ends the run naming the step that failed and why, leaving no exported tree behind. */
function fail(step, cause) {
  if (tree) rmSync(tree, { recursive: true, force: true });
  process.stderr.write(`typecheck-revision: ${step}: ${cause}\n`);
  process.exit(FAILED);
}

/** Runs one program to its end; a program that cannot start ends the run. */
function run(program, args, options, step) {
  const result = spawnSync(program, args, { maxBuffer: Infinity, ...options });
  if (result.error) fail(step, `${program} could not run: ${result.error.message}`);
  if (result.signal) fail(step, `${program} was ended by ${result.signal}`);
  return result;
}

if (!revision) fail('read the arguments', 'the revision to typecheck is required');
const commit = run('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, encoding: 'utf8' }, 'resolve the revision');
if (commit.status !== Number()) fail('resolve the revision', `${revision} is not a commit here: ${commit.stderr}`);
const sha = commit.stdout.trim();

const modules = join(root, 'node_modules');
const tsc = join(modules, '.bin', 'tsc');
if (!existsSync(tsc)) fail('find the compiler', `${modules} holds no installed TypeScript; run npm ci in ${root}`);

tree = join(root, '.build', 'typecheck-revision', sha);
rmSync(tree, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });
const archive = run('git', ['archive', '--format=tar', sha], { cwd: root }, 'export the revision');
if (archive.status !== Number()) fail('export the revision', `git archive ${sha} exited ${archive.status}: ${archive.stderr}`);
const unpacked = run('tar', ['-x', '-C', tree], { input: archive.stdout }, 'unpack the revision');
if (unpacked.status !== Number()) fail('unpack the revision', `tar exited ${unpacked.status}: ${unpacked.stderr}`);
symlinkSync(modules, join(tree, 'node_modules'), 'dir');

const checked = run(tsc, ['--noEmit', '-p', '.'], { cwd: tree, encoding: 'utf8' }, 'typecheck');
const errors = checked.stdout.split('\n').filter((line) => /: error TS\d+:/.test(line));
if (checked.status !== Number() && !errors.length) {
  fail('typecheck', `tsc exited ${checked.status} without reporting an error: ${checked.stdout}${checked.stderr}`);
}
rmSync(tree, { recursive: true, force: true });
for (const error of errors) process.stdout.write(`${error}\n`);
