// Every trajectory module is loaded by Node at run time, out of `src`, against
// the compiled `dist` tree. Two things break that load without breaking
// anything a type check or a unit test looks at.
//
// The first is a specifier that points at nothing. The trajectory tree moved
// from `scripts/trajectories` to `src/trajectories`, and every `../../../dist`
// path in hundreds of modules had to move with it. A stale one is invisible
// until the worker runs that single trajectory on a fleet host.
//
// The second is the module format. `dist` is CommonJS (`"module": "Node16"`,
// no `"type": "module"`), and a `.mjs` file importing it by name works only
// while Node's static read of the compiled file finds that name. A re-export
// written as `export { X } from './y.js'` compiles to an
// `Object.defineProperty(exports, "X", { get })` accessor, and when that shape
// stops being detected the run dies on its first line with "does not provide
// an export named". That is what a host saw for `CREDENTIAL_FIELD_ABSENT` from
// `dist/session/wsession-helpers/finalize.js`.
//
// This test reads the real specifiers out of the real files and imports the
// real compiled modules. It measures the tree it walks, so a move that drops
// files fails here instead of on a host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const trajectories = join(root, 'src', 'trajectories');
const dist = join(root, 'dist');

function modules(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...modules(path));
    else if (entry.endsWith('.mjs')) found.push(path);
  }
  return found.sort();
}

// `import a, { b as c } from 'x'` and `import 'x'`, which is what these files
// use. Dynamic `import()` calls are deliberately out of scope: their
// specifiers are expressions, and a guess about one would report a failure
// that does not exist.
const IMPORT = /^[ \t]*import\s+(?:([^'";]+?)\s+from\s+)?['"]([^'"]+)['"]/gm;

function imports(source) {
  const rows = [];
  for (const [, clause, specifier] of source.matchAll(IMPORT)) {
    const names = [];
    const braced = clause?.match(/\{([^}]*)\}/);
    for (const part of braced ? braced[1].split(',') : []) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
    rows.push({ specifier, names });
  }
  return rows;
}

function specifiers() {
  return modules(trajectories).map((file) => ({
    file,
    rows: imports(readFileSync(file, 'utf8')).filter((row) => row.specifier.startsWith('.')),
  }));
}

test('every file a trajectory imports exists', () => {
  assert.ok(existsSync(trajectories), `no trajectory tree at ${trajectories}`);
  const files = specifiers();
  assert.ok(files.length > 400, `expected the whole trajectory tree, walked ${files.length} modules`);

  const missing = [];
  let counted = 0;
  for (const { file, rows } of files) {
    for (const { specifier } of rows) {
      counted += 1;
      const target = resolve(dirname(file), specifier);
      if (!existsSync(target)) missing.push(`${file.slice(root.length + 1)} -> ${specifier}`);
    }
  }
  assert.ok(counted > 500, `expected the tree's own imports, counted ${counted}`);
  assert.deepEqual(missing, [], `trajectory imports that point at nothing:\n${missing.join('\n')}`);
});

test('the compiled modules provide every name a trajectory imports by name', async () => {
  assert.ok(
    existsSync(dist),
    `no compiled tree at ${dist}; a trajectory run loads it, so build before this test`,
  );
  const wanted = new Map();
  for (const { file, rows } of specifiers()) {
    for (const { specifier, names } of rows) {
      if (!names.length) continue;
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(`${dist}/`) || !existsSync(target)) continue;
      const seen = wanted.get(target) ?? new Set();
      for (const name of names) seen.add(name);
      wanted.set(target, seen);
    }
  }
  assert.ok(wanted.size > 10, `expected named imports from the compiled tree, found ${wanted.size} modules`);

  const absent = [];
  for (const [target, names] of [...wanted.entries()].sort()) {
    const namespace = await import(pathToFileURL(target).href);
    for (const name of [...names].sort()) {
      if (namespace[name] === undefined) {
        absent.push(`${target.slice(root.length + 1)} provides no export named '${name}'`);
      }
    }
  }
  assert.deepEqual(absent, [], `named imports Node cannot resolve at run time:\n${absent.join('\n')}`);
});
