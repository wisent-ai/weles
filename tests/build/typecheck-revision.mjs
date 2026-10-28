// The TypeScript errors of one committed revision of Weles, one per line, as
// the locked compiler reports them; an empty answer means the revision
// compiles. The revision's tree is exported from Git into the checkout's
// ignored .build directory, given this checkout's installed node_modules,
// typechecked there with node_modules/.bin/tsc --noEmit -p ., and removed, so
// uncommitted work in the checkout never decides the answer.
//
// Usage: node tests/build/typecheck-revision.mjs <revision>
// The inventory is every line tsc reports as an error, with a file location
// or without one (a tsconfig it cannot read, a global type it cannot find),
// and it exits zero. The packages are this checkout's, not the revision's
// lockfile: an error a package missing from this install causes (a type root,
// a config an extends names) is listed as the revision's own, so the answer
// is the revision compiled against the installed packages. The run exits
// nonzero, its error naming the step and its cause, when it is given other
// than one revision, the tree cannot be exported, a step on the exported tree
// fails, or the compiler cannot run, and it leaves no exported tree behind.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// process.argv holds the node executable, then this script, then the arguments.
const [, , revision, ...extra] = process.argv;
let tree;

/**
 * Ends the run naming the step that failed and why, leaving no exported tree
 * behind: the error is uncaught, so Node prints it and exits with its failure
 * status for an uncaught exception.
 */
function fail(step, cause) {
  if (tree) rmSync(tree, { recursive: true, force: true });
  throw new Error(`typecheck-revision: ${step}: ${cause}`);
}

/**
 * Runs one program to its end; a program that cannot start, or that a signal
 * ended (spawnSync then answers status null), ends the run here, so every
 * status a caller reads after it is the program's own exit number.
 */
function run(program, args, options, step) {
  const result = spawnSync(program, args, { maxBuffer: Infinity, ...options });
  if (result.error) fail(step, `${program} could not run: ${result.error.message}`);
  if (result.signal) fail(step, `${program} was ended by ${result.signal}`);
  return result;
}

/** One filesystem change to the exported tree; one that throws ends the run. */
function change(step, action) {
  try {
    action();
  } catch (error) {
    fail(step, error.message);
  }
}

if (!revision) fail('read the arguments', 'the revision to typecheck is required');
if (extra.length) fail('read the arguments', `one revision is taken, and ${extra.join(' ')} was given after it`);
const commit = run('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, encoding: 'utf8' }, 'resolve the revision');
if (commit.status) fail('resolve the revision', `${revision} is not a commit here: ${commit.stderr}`);
const sha = commit.stdout.trim();

const modules = join(root, 'node_modules');
const tsc = join(modules, '.bin', 'tsc');
if (!existsSync(tsc)) fail('find the compiler', `${modules} holds no installed TypeScript; run npm ci in ${root}`);

tree = join(root, '.build', 'typecheck-revision', sha);
change('clear the export directory', () => rmSync(tree, { recursive: true, force: true }));
change('create the export directory', () => mkdirSync(tree, { recursive: true }));
const archive = run('git', ['archive', '--format=tar', sha], { cwd: root }, 'export the revision');
if (archive.status) fail('export the revision', `git archive ${sha} exited ${archive.status}: ${archive.stderr}`);
const unpacked = run('tar', ['-x', '-C', tree], { input: archive.stdout }, 'unpack the revision');
if (unpacked.status) fail('unpack the revision', `tar exited ${unpacked.status}: ${unpacked.stderr}`);
change('give the tree the installed packages', () => symlinkSync(modules, join(tree, 'node_modules'), 'dir'));

const checked = run(tsc, ['--noEmit', '-p', '.'], { cwd: tree, encoding: 'utf8' }, 'typecheck');
// Every error tsc reports, at a file location or without one: an empty
// inventory is the only answer that says the revision compiles.
const errors = checked.stdout.split('\n').filter((line) => /\berror TS\d+:/.test(line));
if (checked.status && !errors.length) {
  fail('typecheck', `tsc exited ${checked.status} without reporting an error: ${checked.stdout}${checked.stderr}`);
}
change('remove the exported tree', () => rmSync(tree, { recursive: true, force: true }));
for (const error of errors) process.stdout.write(`${error}\n`);
