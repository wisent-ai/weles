/**
 * What the worker archive has to contain.
 *
 * `release-worker` stages a fixed list of directories and files into the
 * archive every fleet host installs. Nothing read that list except a tag
 * build, so when the module restructure deleted `scripts/` the packaging kept
 * naming it: release 0.5.50 died in its build step with
 * `cp: scripts: No such file or directory`, after the tag was already cut.
 *
 * The dispatcher is the other half of the same contract. It resolves a task
 * type to a path like `src/trajectories/generic/browser_task.mjs`, relative to
 * the install root, and those modules import `../../../dist/...` relative to
 * their own place. An archive that drops that tree installs and then fails per
 * task, on a host, with a module-not-found.
 *
 * Run: node --test tests/release/packaging.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const WORKFLOW = join(REPO, '.github/workflows/release-worker.yml');
const DISPATCH = join(REPO, 'src/worker/dispatch.ts');

/** Every path the packaging copies into the staged archive. */
function staged() {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const paths = [];
  for (const [, list] of workflow.matchAll(/^\s*cp (?:-R )?([^\n]*?) "\$stage\/"$/gm)) {
    for (const path of list.split(/\s+/)) {
      if (path.startsWith('"') || path.startsWith('$')) continue;
      paths.push(path);
    }
  }
  return paths;
}

test('the packaging stages paths this tree has', () => {
  const paths = staged();
  assert.ok(paths.length > 4, `expected the staging list, found ${JSON.stringify(paths)}`);
  const missing = paths.filter((path) => !existsSync(join(REPO, path)));
  assert.deepEqual(missing, [], `the release archive would stage paths that do not exist: ${missing.join(', ')}`);
});

test('every trajectory the dispatcher names is inside a staged directory', () => {
  const dispatch = readFileSync(DISPATCH, 'utf8');
  const referenced = [...dispatch.matchAll(/'((?:src|scripts)\/trajectories\/[^']+\.mjs)'/g)]
    .map(([, path]) => path);
  assert.ok(referenced.length > 20, `expected the dispatcher's trajectory paths, found ${referenced.length}`);

  const directories = staged().filter((path) => !path.includes('.'));
  const outside = [...new Set(referenced)]
    .filter((path) => !directories.some((directory) => path.startsWith(`${directory}/`)))
    .sort();
  assert.deepEqual(
    outside,
    [],
    `the dispatcher resolves paths the archive would not carry:\n${outside.join('\n')}`,
  );

  const absent = [...new Set(referenced)].filter((path) => !existsSync(join(REPO, path))).sort();
  assert.deepEqual(absent, [], `the dispatcher resolves files this tree does not have:\n${absent.join('\n')}`);
});
