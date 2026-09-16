/**
 * The Weles API launcher's startup contract, through the real program.
 *
 * Missing Stado refuses before anything is spawned. Native dependency and
 * missing-directory refusals live in tests/release/packaging.test.mjs, where
 * the real signed native pair is available. An already-served port stands by
 * without clearing the capability socket that its incumbent owns.
 *
 * The incumbent that owns the port and capability socket is real Skarbiec,
 * not a listener or script imitating the service.
 *
 * Run: node --test tests/worker/launcher-startup.test.mjs
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const LAUNCHER = join(REPO, 'src/worker/weles-api-launcher.mjs');

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A sibling product's real binary: its own variable, then PATH, then the Stado
 * install directory. When none holds it this fails by name rather than writing
 * a script that answers in its place.
 */
function productBinary(name, variable) {
  const configured = String(process.env[variable] ?? '').trim();
  if (configured) {
    assert.ok(isExecutable(configured), `${variable} names ${configured}, which is not executable`);
    return configured;
  }
  const located = spawnSync('/usr/bin/env', ['sh', '-c', `command -v ${name}`], { encoding: 'utf8' });
  const onPath = located.status === 0 ? located.stdout.trim() : '';
  if (onPath) return onPath;
  const installed = join(homedir(), '.stado', 'bin', name);
  if (isExecutable(installed)) return installed;
  throw new Error(
    `the real ${name} binary is required and was not found: ${variable} is unset,`
    + ` ${name} is not on PATH, and ${installed} does not exist.`
    + ` Install it with \`stado release install ${name}\`.`,
  );
}

/**
 * The parent environment with every inherited `SKARBIEC_` variable removed.
 * Each resolves to a path below `HOME` when unset, so redirecting `HOME`
 * covers those; dropping the prefix covers the other half. An operator shell
 * exporting `SKARBIEC_UNLOCK` or `SKARBIEC_CAPABILITY_ROUTES_FILE` would
 * otherwise hand this fixture the real passphrase and the real routes table.
 */
function withoutInheritedVault() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SKARBIEC_')) delete environment[key];
  }
  return environment;
}

async function reservePort() {
  const server = createServer();
  const bound = Promise.withResolvers();
  server.once('error', bound.reject);
  server.listen(0, '127.0.0.1', () => bound.resolve());
  await bound.promise;
  const { port } = server.address();
  const closed = Promise.withResolvers();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

function accepting(port) {
  const { promise, resolve: settled } = Promise.withResolvers();
  const socket = connect({ host: '127.0.0.1', port });
  const settle = (state) => {
    socket.destroy();
    settled(state);
  };
  socket.setTimeout(200);
  socket.once('connect', () => settle(true));
  socket.once('timeout', () => settle(false));
  socket.once('error', () => settle(false));
  return promise;
}

/**
 * State stays inside the checkout's ignored build directory. The capability
 * broker binds a relative socket from that directory: an absolute path under
 * a long checkout would exceed macOS's Unix socket path limit.
 */
const homes = [];
function isolatedHome() {
  const root = join(REPO, 'build');
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, 'w-'));
  mkdirSync(join(home, '.stado', 'run'), { recursive: true });
  homes.push(home);
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

const running = [];
after(() => {
  for (const child of running) child.kill('SIGKILL');
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test('startup refuses before spawning anything when Stado is unavailable', async () => {
  const home = isolatedHome();
  const absent = join(home, 'no-stado-here');
  const result = spawnSync(process.execPath, [LAUNCHER], {
    cwd: REPO,
    encoding: 'utf8',
    env: launcherEnv(home, { STADO_BIN: absent, WELES_API_PORT: String(await reservePort()) }),
  });
  assert.equal(result.status, 1, `expected a refusal, got ${result.status}: ${result.stderr}`);
  assert.ok(result.stderr.includes(absent), result.stderr);
  assert.deepEqual(readdirSync(join(home, '.stado/run')), [],
    'a refused startup must not have created capability broker state');
});

test('a launcher that loses the port stands by and leaves the broker socket alone', async () => {
  const home = isolatedHome();
  const skarbiec = productBinary('skarbiec', 'SKARBIEC_BIN');
  const gnupg = join(home, 'gnupg');
  mkdirSync(gnupg, { recursive: true, mode: 0o700 });
  const brokerEnv = {
    ...withoutInheritedVault(),
    HOME: home,
    GNUPGHOME: gnupg,
    SKARBIEC_VAULT_FILE: join(home, 'vault.json'),
    SKARBIEC_AUDIT_FILE: join(home, 'audit.jsonl'),
  };
  const initialized = spawnSync(skarbiec, ['init', 'weles-launcher-tests'], {
    encoding: 'utf8',
    env: brokerEnv,
  });
  assert.equal(initialized.status, 0,
    `real skarbiec could not create the isolated vault: ${initialized.stderr || initialized.stdout}`);

  // The incumbent may still use the former shared socket path. A new launcher
  // must leave that real broker alone when another process serves the API port.
  const socketPath = join(home, '.stado/run/weles-api-capability.sock');
  const liveBroker = spawn(skarbiec, ['capability-serve', '--socket', '.stado/run/weles-api-capability.sock'],
    { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], env: brokerEnv });
  running.push(liveBroker);
  let brokerOutput = '';
  liveBroker.stdout.on('data', (chunk) => { brokerOutput += String(chunk); });
  liveBroker.stderr.on('data', (chunk) => { brokerOutput += String(chunk); });

  // Real time is unavoidable: the awaited condition is a socket bound by
  // another process, so this polls the condition rather than guessing at it.
  const socketDeadline = Date.now() + 20_000;
  while (!existsSync(socketPath)) {
    assert.equal(liveBroker.exitCode, null,
      `the real capability broker exited with ${liveBroker.exitCode} before binding: ${brokerOutput}`);
    assert.ok(Date.now() < socketDeadline, `the real capability broker never bound ${socketPath}: ${brokerOutput}`);
    const tick = Promise.withResolvers();
    setTimeout(() => tick.resolve(), 50);
    await tick.promise;
  }
  assert.equal(statSync(socketPath).isSocket(), true, 'the capability broker did not bind a socket');

  // The port the live instance owns. What the launcher measures is whether the
  // port is served at all — it never speaks to the holder — so the holder here
  // is a second real Skarbiec rather than anything imitating a Weles API.
  const port = await reservePort();
  const liveApi = spawn(skarbiec, ['serve', '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: brokerEnv });
  running.push(liveApi);
  const portDeadline = Date.now() + 20_000;
  while (!(await accepting(port))) {
    assert.equal(liveApi.exitCode, null, `the port holder exited with ${liveApi.exitCode}`);
    assert.ok(Date.now() < portDeadline, `the port holder never bound 127.0.0.1:${port}`);
    const tick = Promise.withResolvers();
    setTimeout(() => tick.resolve(), 50);
    await tick.promise;
  }

  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: home,
    env: launcherEnv('.', { STADO_BIN: productBinary('stado', 'STADO_BIN'), WELES_API_PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  // It stands by for thirty seconds rather than exiting immediately, so the
  // check is on what it says and on the socket surviving, not on its exit.
  const observed = Promise.withResolvers();
  setTimeout(() => observed.resolve(), 3_000);
  await observed.promise;
  assert.match(stderr, new RegExp(`weles api port ${port} is already served`));
  assert.equal(statSync(socketPath).isSocket(), true, 'the live broker socket was removed');
  child.kill('SIGKILL');
  liveApi.kill('SIGKILL');
  liveBroker.kill('SIGKILL');
  spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: gnupg } });
});
