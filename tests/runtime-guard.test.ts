import { test } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The release launcher unpacks the payload into a runtime tree once and marks
// it `.ready`. Before this was covered, the marker was believed on its own and
// the unpack guard behind it checked `package.json` and the API launcher only -
// nothing under `dist/`. charless-mac-mini ended up with a runtime that had
// been marked ready without the compiled modules, so `weles-api-server.mjs`
// died on its first import on every KeepAlive cycle, port 8788 never bound,
// and every later release was rolled back for failed readiness while the
// marker kept asserting the runtime was fine. The guard and the server's own
// startup imports have to stay the same set, so an import added to the server
// cannot silently fall outside what the launcher verifies.
//
// A third case used to live here and it was a fake: it built a payload out of
// `printf 'x'` placeholder files and overwrote the API launcher with a script
// that printed `launched`, so the launcher execed a stand-in for the product
// and the placeholders stood in for the compiled modules whose absence is the
// entire regression. It is deleted rather than converted. The real form —
// build the payload from this repository's own `npm run build` output and let
// the launcher exec the real API launcher — cannot be written today, because
// no payload this repository can produce satisfies the guard: `runtime_required`
// names `scripts/worker/deploy/launch-weles-api-mac.sh` and
// `scripts/worker/weles-api-server.mjs`, `.github/workflows/release-worker.yml`
// copies `scripts` into the payload, and this repository has no `scripts/`
// directory at all. That is release work with its own owner. The two cases
// below are the detectors of exactly that drift, and they are expected to fail
// until it is repaired.
//
// The runner's cwd is the repository root; `import.meta` would force this file
// to load as ESM, which tap's loader cannot require.
const repoRoot = process.cwd();
const launcherPath = join(repoRoot, 'release/stado-launcher.sh');
const serverPath = join(repoRoot, 'src/worker/weles-api-server.mjs');

// The entries listed in the launcher's `runtime_required` array.
function guardedEntries(): string[] {
  const launcher = readFileSync(launcherPath, 'utf8');
  const block = /\nruntime_required=\(\n([\s\S]*?)\n\)\n/.exec(launcher);
  assert.ok(block, `${launcherPath} declares no runtime_required array`);
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// Every path the API server imports from the runtime root at startup, written
// in the source as `${REPO}/dist/...`.
function serverStartupImports(): string[] {
  const server = readFileSync(serverPath, 'utf8');
  const found = new Set<string>();
  for (const match of server.matchAll(/\$\{REPO\}\/([A-Za-z0-9_./-]+\.js)/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

test('the launcher verifies every runtime module the API server imports', () => {
  const guarded = guardedEntries();
  const imported = serverStartupImports();
  assert.ok(imported.length > 0, 'expected the API server to import from the runtime root');
  const unguarded = imported.filter((entry) => !guarded.includes(entry));
  assert.deepEqual(
    unguarded,
    [],
    `the API server imports these at startup but release/stado-launcher.sh does not require them, so an incomplete runtime would still be marked ready:\n${unguarded.join('\n')}`,
  );
});

test('the launcher requires the payload entries it execs and reads', () => {
  const guarded = guardedEntries();
  for (const entry of [
    'package.json',
    'src/worker/deploy/launch-weles-api-mac.sh',
    'src/worker/weles-api-server.mjs',
  ]) {
    assert.ok(guarded.includes(entry), `release/stado-launcher.sh does not require ${entry}`);
  }
});
