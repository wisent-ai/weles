/**
 * Every compiled module loads.
 *
 * This defends the regression class that took the whole fleet down between
 * 5960e6f and 9319340: `wsession_atoms.ts` mutated `WSession.prototype` from a
 * top-level side-effect import that ran before the class declaration, so every
 * module in `dist/` threw at `require()` time — and only new processes saw it,
 * because the long-running workers still held the pre-regression load. Nothing
 * catches that except loading each module.
 *
 * It used to be a lint script under `scripts/lint`, invoked by CI as
 * `npm run lint-modules`. The script is gone and the check is a test, where a
 * check belongs.
 *
 * It also refuses a checkout where git is hiding source the build reads. A
 * bare directory pattern in .gitignore matches that directory at every depth:
 * `build/` hid this very file, and `supabase/` hid two real trajectories, so
 * the published trajectory catalog counted a tree nobody could clone. Ignored
 * source is worse than missing source, because every local check passes.
 *
 * Run: node --test tests/build/module-load.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const DIST = join(REPO, 'dist');
const require = createRequire(import.meta.url);

// Some worker modules refuse to load without their deployment contract, on
// purpose: a worker booted without an action allowlist must die at import
// rather than at the first claim. That fail-closed check is right, so the walk
// supplies the contract from the same catalog the launcher reads instead of
// weakening it.
process.env.WELES_ACTION_ALLOWLIST ??= readFileSync(
  join(REPO, 'src/worker/deploy/weles-action-allowlist.txt'), 'utf8',
)
  .split(/\r?\n/)
  .map((action) => action.trim())
  .filter(Boolean)
  .join(',');

// `dist/page-init` and `dist/diagnostics/property_trap.js` are page-side init
// scripts injected through addInitScript, not Node modules.
const injectedIntoPage = (path) => /\/(page-init|diagnostics\/property_trap)\b/.test(path);

function compiledModules(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...compiledModules(path));
    else if (path.endsWith('.js') && !injectedIntoPage(path)) found.push(path);
  }
  return found.sort();
}

test('every compiled module in dist/ loads without throwing', () => {
  const modules = compiledModules(DIST);
  assert.ok(modules.length > 0, 'dist/ holds no compiled modules; run npm run build first');
  const failures = [];
  for (const path of modules) {
    try {
      require(path);
    } catch (error) {
      failures.push(`${path.replace(`${DIST}/`, '')}: ${(error?.message ?? String(error)).slice(0, 200)}`);
    }
  }
  assert.deepEqual(failures, [], `modules that failed to load:\n  ${failures.join('\n  ')}`);
});

/** Whatever git reports for one of its own listings, as lines. */
function gitLines(argv) {
  return execFileSync('git', ['-C', REPO, ...argv], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('no source this repository builds from is ignored by git', () => {
  // Every directory whose contents are source. A file here that git ignores
  // exists for whoever wrote it and for nobody else: the build works on that
  // machine, the published counts describe that machine, and main cannot
  // reproduce either.
  for (const directory of ['src', 'tests', 'release', 'docs', '.github']) {
    assert.deepEqual(
      gitLines(['ls-files', '--others', '--ignored', '--exclude-standard', '--', directory]),
      [],
      `${directory} carries ignored source; a bare directory pattern in .gitignore matches every depth, `
      + 'so name the path from the root (/build/, /supabase/) instead',
    );
  }
});

test('every trajectory file the catalog publishes is tracked', () => {
  // The published trajectory count is a walk of src/trajectories on disk, so
  // an untracked file there is a number no clone can reproduce.
  const walked = [];
  const walk = (directory) => {
    for (const name of readdirSync(join(REPO, directory))) {
      const path = `${directory}/${name}`;
      if (statSync(join(REPO, path)).isDirectory()) walk(path);
      else walked.push(path);
    }
  };
  walk('src/trajectories');
  const tracked = new Set(gitLines(['ls-files', '--', 'src/trajectories']));
  assert.deepEqual(
    walked.filter((path) => !tracked.has(path)).sort(),
    [],
    'these trajectory files are on disk but not in the repository, so the published catalog counts a tree '
    + 'nobody else has',
  );
});
