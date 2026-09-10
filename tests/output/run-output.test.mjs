// The resolver every trajectory now asks for its output path. What matters is
// not that it returns a string: it is that the string is absolute, outside
// this checkout, and movable, because the defect it replaced was twenty-one
// paths relative to the process working directory that filled `weles/.work`
// with 13 GB inside the repository.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runOutputPath, runOutputRoot } from '#run-output';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VARIABLE = 'WELES_RUN_OUTPUT_DIR';

/// A throwaway root inside this checkout's ignored build directory, which is
/// the one place the workshop allows it: the OS temp directory is swept on
/// sight on this machine and would take the fixture with it mid-run.
function scratch() {
  const parent = join(REPO, 'dist', 'tests-run-output');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'root-'));
}

test('the default root is absolute, in the product state directory, and outside this checkout', () => {
  const previous = process.env[VARIABLE];
  delete process.env[VARIABLE];
  try {
    const root = runOutputRoot();
    assert.ok(isAbsolute(root), `expected an absolute root, got ${root}`);
    assert.equal(root, join(homedir(), '.weles', 'runs'));
    assert.ok(
      !root.startsWith(REPO + sep),
      `run output must not land inside the checkout: ${root}`,
    );
    assert.ok(existsSync(root), 'the root is created rather than assumed');
  } finally {
    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
  }
});

test('the override moves the whole root and creates it', () => {
  const previous = process.env[VARIABLE];
  const root = scratch();
  const chosen = join(root, 'moved');
  process.env[VARIABLE] = chosen;
  try {
    assert.equal(runOutputRoot(), chosen);
    assert.ok(existsSync(chosen), 'an override root is created');
    assert.equal(
      runOutputPath('keeper', 'decodo_isp.json'),
      join(chosen, 'keeper', 'decodo_isp.json'),
    );
  } finally {
    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
    // The whole fixture goes, not only the override root inside it: three
    // empty `root-*` directories had already accumulated under dist/ from
    // earlier runs of this very case.
    rmSync(root, { recursive: true, force: true });
  }
});

test('a trajectory resolves the same root through the package import', async () => {
  const previous = process.env[VARIABLE];
  const previousDiag = process.env.GOOGLE_ADS_DIAG_DIR;
  const root = scratch();
  process.env[VARIABLE] = root;
  delete process.env.GOOGLE_ADS_DIAG_DIR;
  try {
    // Imported for its top-level `DIAG_DIR`, which calls the resolver through
    // `#run-output` from five directories below the package root: the
    // specifier has to resolve there, not only from this test.
    const settings = await import(
      '../../src/trajectories/google/ads/ads_keyword_planner_api_server/service_settings.mjs'
    );
    assert.equal(
      settings.DIAG_DIR,
      join(root, 'google-ads-keyword-planner', 'api'),
    );
  } finally {
    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
    if (previousDiag !== undefined) process.env.GOOGLE_ADS_DIAG_DIR = previousDiag;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a relative override is refused, because that is the defect being removed', () => {
  const previous = process.env[VARIABLE];
  process.env[VARIABLE] = '.work/keeper';
  try {
    assert.throws(
      () => runOutputRoot(),
      new RegExp(`^Error: ${VARIABLE} must be an absolute path, got \\.work/keeper$`),
    );
  } finally {
    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
  }
});
