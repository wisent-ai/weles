import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
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
// The runner's cwd is the repository root; `import.meta` would force this file
// to load as ESM, which tap's loader cannot require.
const repoRoot = process.cwd();
const launcherPath = join(repoRoot, 'release/stado-launcher.sh');
const serverPath = join(repoRoot, 'scripts/worker/weles-api-server.mjs');

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
    'scripts/worker/deploy/launch-weles-api-mac.sh',
    'scripts/worker/weles-api-server.mjs',
  ]) {
    assert.ok(guarded.includes(entry), `release/stado-launcher.sh does not require ${entry}`);
  }
});

test('a runtime marked ready without a required module is re-derived', () => {
  // The regression itself: `.ready` present, one required module absent. The
  // launcher must report the missing entry and unpack again rather than exec a
  // tree that cannot serve. Driven through the real script with a payload built
  // here, so the assertion is about the shipped launcher's behaviour.
  const guarded = guardedEntries();
  const script = `
    set -eu
    work="$1"
    launcher="$2"
    root="$work/release"
    mkdir -p "$root/payload"
    # A payload carrying every entry the guard requires.
    build="$work/build"
    mkdir -p "$build"
    for entry in ${guarded.map((entry) => `'${entry}'`).join(' ')}; do
      mkdir -p "$build/$(dirname "$entry")"
      printf '%s\\n' 'x' > "$build/$entry"
    done
    printf '%s\\n' '{"version":"9.9.9"}' > "$build/package.json"
    # The launcher execs this as its final step; make it announce itself and
    # stop rather than start a real API server.
    printf '%s\\n' '#!/bin/bash' 'printf launched\\\\n' \\
      > "$build/scripts/worker/deploy/launch-weles-api-mac.sh"
    tar -czf "$root/payload/weles-worker.tar.gz" -C "$build" .
    # A runtime that is complete, marked ready, and has lost exactly one
    # compiled module: the shape charless-mac-mini was pinned in.
    cp -R "$build" "$root/runtime"
    rm -f "$root/runtime/dist/worker/dispatch.js"
    touch "$root/runtime/.ready"
    cp "$launcher" "$root/weles-api-launcher"
    chmod 0755 "$root/weles-api-launcher"
    HOME="$work/home" NODE_BIN="$(command -v node)" \\
      bash "$root/weles-api-launcher" 2>"$work/err" >"$work/out" || true
    printf 'STDERR<%s>\\n' "$(cat "$work/err")"
    printf 'STDOUT<%s>\\n' "$(cat "$work/out")"
    printf 'DISPATCH<%s>\\n' "$([ -f "$root/runtime/dist/worker/dispatch.js" ] && echo present || echo absent)"
  `;
  const work = execFileSync('mktemp', ['-d', join(repoRoot, '.work', 'runtime-guard.XXXXXX')], {
    encoding: 'utf8',
  }).trim();
  let output = '';
  try {
    execFileSync('mkdir', ['-p', join(work, 'home')]);
    output = execFileSync('bash', ['-c', script, 'runtime-guard', work, launcherPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } finally {
    execFileSync('rm', ['-rf', work]);
  }
  assert.match(
    output,
    /is marked ready but has no dist\/worker\/dispatch\.js/,
    `the launcher did not report the missing module:\n${output}`,
  );
  assert.match(
    output,
    /DISPATCH<present>/,
    `the launcher left the incomplete runtime in place instead of re-deriving it:\n${output}`,
  );
  assert.match(output, /STDOUT<launched>/, `the launcher did not reach the API launcher:\n${output}`);
});
