/**
 * The launcher's Skarbiec endpoint resolution, against a real Skarbiec.
 *
 * This module decides whether the authority the fleet named is actually there,
 * and the whole point of the check is that it answers about a real listener.
 * It used to be measured against `net.createServer(() => {})` — a socket that
 * accepts and answers nothing, standing in for the capability broker. A
 * placeholder always looks alive, so the check could only ever agree with
 * itself.
 *
 * What runs here is the real `skarbiec` binary serving a vault this test
 * created with `skarbiec init`, on a port the kernel reserved. Isolate the
 * data, never the component. A dead endpoint and an unparseable URL stay as
 * they were: absence is not a stand-in for anything.
 *
 * Run: node --test tests/worker/endpoint-resolution.test.mjs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  isEndpointListening,
  resolveSkarbiecEndpoint,
  formatEndpointErrorMessage,
} from '../../src/worker/deploy/acquire/endpoint-resolution.mjs';

const ROOT = join(homedir(), '.stado', 'work', 'wl', `endp-${process.pid.toString(16)}`);

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real Skarbiec binary, in one fixed resolution order: SKARBIEC_BIN, then
 * PATH, then the Stado install directory. When none holds it this fails by
 * name rather than substituting a listener, because a check that passes for
 * want of a dependency is exactly the defect being removed.
 */
function skarbiecBinary() {
  const configured = String(process.env.SKARBIEC_BIN ?? '').trim();
  if (configured) {
    assert.ok(isExecutable(configured), `SKARBIEC_BIN names ${configured}, which is not executable`);
    return configured;
  }
  const located = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v skarbiec'], { encoding: 'utf8' });
  const onPath = located.status === 0 ? located.stdout.trim() : '';
  if (onPath) return onPath;
  const installed = join(homedir(), '.stado', 'bin', 'skarbiec');
  if (isExecutable(installed)) return installed;
  throw new Error(
    'the real skarbiec binary is required and was not found: SKARBIEC_BIN is unset,'
    + ' skarbiec is not on PATH, and ~/.stado/bin/skarbiec does not exist.'
    + ' Install it with `stado release install skarbiec`.',
  );
}

/**
 * The parent environment with every inherited `SKARBIEC_` variable removed.
 *
 * Each one resolves to a path below `HOME` when unset, so redirecting `HOME`
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

/** A loopback port the kernel just handed out and immediately released. */
async function reservePort() {
  const server = createServer();
  await new Promise((listening, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', listening);
  });
  const { port } = server.address();
  await new Promise((closed) => server.close(closed));
  return port;
}

function accepting(port) {
  const { promise, resolve } = Promise.withResolvers();
  const socket = connect({ host: '127.0.0.1', port });
  const settle = (state) => {
    socket.destroy();
    resolve(state);
  };
  socket.setTimeout(200);
  socket.once('connect', () => settle(true));
  socket.once('timeout', () => settle(false));
  socket.once('error', () => settle(false));
  return promise;
}

let broker = null;
/** A port the kernel confirmed free and nothing is serving: absence, not a stand-in. */
let deadPort = 0;

before(async () => {
  const binary = skarbiecBinary();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'gnupg'), { recursive: true, mode: 0o700 });
  const env = {
    ...withoutInheritedVault(),
    HOME: ROOT,
    GNUPGHOME: join(ROOT, 'gnupg'),
    SKARBIEC_VAULT_FILE: join(ROOT, 'vault.json'),
    SKARBIEC_AUDIT_FILE: join(ROOT, 'audit.jsonl'),
  };
  const initialized = spawnSync(binary, ['init', 'weles-endpoint-tests'], { encoding: 'utf8', env });
  assert.equal(initialized.status, 0,
    `real skarbiec could not create the isolated vault: ${initialized.stderr || initialized.stdout}`);

  const port = await reservePort();
  deadPort = await reservePort();
  const child = spawn(binary, ['serve', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });

  // Awaited until the real broker actually accepts. A broker that fails to
  // bind still spawns, so a test that only sleeps would measure whatever else
  // holds that port — on an operator's machine, the live vault.
  const deadline = Date.now() + 20_000;
  while (!(await accepting(port))) {
    assert.equal(child.exitCode, null,
      `the real skarbiec broker exited with ${child.exitCode} before binding: ${output}`);
    assert.ok(Date.now() < deadline, `the real skarbiec broker never bound 127.0.0.1:${port}: ${output}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
  broker = { child, url: `http://127.0.0.1:${port}` };
});

after(() => {
  broker?.child.kill('SIGKILL');
  spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: join(ROOT, 'gnupg') } });
  rmSync(ROOT, { recursive: true, force: true });
});

test('a real Skarbiec broker is seen as listening', async () => {
  assert.equal(await isEndpointListening(broker.url, 2000), true);
});

test('a port nothing serves is not seen as listening', async () => {
  assert.equal(await isEndpointListening(`http://127.0.0.1:${deadPort}`, 500), false);
});

test('an unparseable endpoint is refused rather than dialled', async () => {
  assert.equal(await isEndpointListening('not-a-valid-url', 500), false);
});

test('the directory endpoint is the one resolved, and its liveness is measured', async () => {
  const previous = process.env.WC_SKARBIEC_URL;
  process.env.WC_SKARBIEC_URL = broker.url;
  try {
    const { resolved } = await resolveSkarbiecEndpoint();
    assert.ok(resolved, 'a declared endpoint was not resolved');
    // The exact directory-supplied value is the only candidate: no marker
    // scan, no built-in address, no second authority.
    assert.equal(resolved.url, broker.url);
    assert.equal(resolved.isListening, true, 'a real broker was reported dead');
  } finally {
    if (previous === undefined) delete process.env.WC_SKARBIEC_URL;
    else process.env.WC_SKARBIEC_URL = previous;
  }
});

test('a dead directory endpoint is retained rather than redirected', async () => {
  const previous = process.env.WC_SKARBIEC_URL;
  const dead = `http://127.0.0.1:${deadPort}`;
  process.env.WC_SKARBIEC_URL = dead;
  try {
    const { resolved } = await resolveSkarbiecEndpoint();
    assert.ok(resolved, 'a declared endpoint was dropped because it was dead');
    assert.equal(resolved.url, dead);
    assert.equal(resolved.isListening, false);
  } finally {
    if (previous === undefined) delete process.env.WC_SKARBIEC_URL;
    else process.env.WC_SKARBIEC_URL = previous;
  }
});

test('a missing directory endpoint refuses implicit routing', async () => {
  const previous = process.env.WC_SKARBIEC_URL;
  delete process.env.WC_SKARBIEC_URL;
  try {
    const { resolved } = await resolveSkarbiecEndpoint();
    assert.equal(resolved, null);
  } finally {
    if (previous !== undefined) process.env.WC_SKARBIEC_URL = previous;
  }
});

test('the refusal names the endpoint, where it came from and what it did', () => {
  const message = formatEndpointErrorMessage({ url: 'http://127.0.0.1:8785', isListening: false });
  assert.equal(
    message,
    'Skarbiec endpoint at http://127.0.0.1:8785 (from Stado service directory via WC_SKARBIEC_URL)'
    + ' is not listening',
  );
});
