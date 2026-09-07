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
 * Run: node --test tests/build/module-load.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
