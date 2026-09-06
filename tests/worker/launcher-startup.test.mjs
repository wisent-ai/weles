/**
 * The Weles API launcher's startup contract, through the real program.
 *
 * Both paths here took a production host down. A launcher that starts without
 * its Stado binary or without a Skarbiec endpoint used to reach the point of
 * spawning children and then serve an API with no credential half, and a
 * launcher that cleared the capability socket while another instance owned the
 * port left every trajectory reading ECONNREFUSED with no restart able to
 * repair it. So: an unmet prerequisite refuses before anything is spawned, and
 * an already-served port stands by having touched nothing.
 *
 * Run: node --test tests/worker
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, statSync } from 'node:fs';

import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const LAUNCHER = join(REPO, 'src/worker/weles-api-launcher.mjs');

// The launcher derives the broker socket from HOME, and a unix socket path may
// not exceed 104 bytes on macOS — the platform's own limit, which the default
// `/var/folders/...` temporary root already spends most of. So the isolated
// home for these tests is short by construction.
function isolatedHome(tag) {
  const home = mkdtempSync(join('/tmp', `wl-${tag}-`));
  mkdirSync(join(home, '.stado', 'run'), { recursive: true });
  return home;
}

function launcherEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    NODE_BIN: process.execPath,
    ...extra,
  };
}

test('startup refuses before spawning anything when Stado is unavailable', () => {
  const home = isolatedHome('no-stado');
  const absent = join(home, 'no-stado-here');
  const result = spawnSync(process.execPath, [LAUNCHER], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: launcherEnv(home, { STADO_BIN: absent, WELES_API_PORT: '18781' }),
  });
  assert.equal(result.status, 1, `expected a refusal, got ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr.trim(), `required Stado binary is unavailable: ${absent}`);
  assert.equal(
    existsSync(join(home, '.stado/run/weles-api-capability.sock')),
    false,
    'a refused startup must not have created the broker socket',
  );
});

test('startup refuses when the fleet cannot name a Skarbiec endpoint', () => {
  const home = isolatedHome('no-endpoint');
  const stado = join(home, 'stado');
  writeFileSync(stado, '#!/bin/sh\nexit 1\n');
  chmodSync(stado, 0o755);
  const result = spawnSync(process.execPath, [LAUNCHER], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: launcherEnv(home, { STADO_BIN: stado, WELES_API_PORT: '18782' }),
  });
  assert.equal(result.status, 1, `expected a refusal, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /Skarbiec endpoint resolution refused/);
  assert.equal(
    existsSync(join(home, '.stado/run/weles-api-capability.sock')),
    false,
    'a refused startup must not have created the broker socket',
  );
});

test('a launcher that loses the port stands by and leaves the broker socket alone', async () => {
  const home = isolatedHome('port-taken');
  const stado = join(home, 'stado');
  writeFileSync(stado, '#!/bin/sh\nexit 1\n');
  chmodSync(stado, 0o755);

  // The socket the live instance owns. The losing launcher must not remove it,
  // which is the whole reason the port is claimed before anything shared is
  // touched.
  const socketPath = join(home, '.stado/run/weles-api-capability.sock');
  const liveBroker = createServer();
  await new Promise((ready, failed) => {
    liveBroker.once('error', failed);
    liveBroker.listen(socketPath, ready);
  });

  const port = 18783;
  const liveApi = createServer();
  await new Promise((ready, failed) => {
    liveApi.once('error', failed);
    liveApi.listen(port, '127.0.0.1', ready);
  });

  try {
    const child = spawn(process.execPath, [LAUNCHER], {
      cwd: REPO,
      env: launcherEnv(home, { STADO_BIN: stado, WELES_API_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // It stands by for thirty seconds rather than exiting immediately, so the
    // check is on what it says and on the socket surviving, not on its exit.
    await new Promise((settle) => setTimeout(settle, 3_000));
    assert.match(stderr, new RegExp(`weles api port ${port} is already served`));
    assert.equal(statSync(socketPath).isSocket(), true, 'the live broker socket was removed');
    child.kill('SIGKILL');
  } finally {
    liveApi.close();
    liveBroker.close();
  }
});
