import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  isEndpointListening,
  resolveSkarbiecEndpoint,
  formatEndpointErrorMessage,
  EndpointInfo,
} from '../dist/utils/runtime/endpoint-resolution.js';

// The shipped resolver, measured against a real Skarbiec.
//
// These cases used to point at `net.createServer(() => {})` — a socket that
// accepts and answers nothing, standing in for the capability broker. A
// placeholder is alive by construction, so "is the authority there" could only
// ever agree with itself. What answers here is the real `skarbiec` binary over
// a vault this test created with `skarbiec init`, on a kernel-reserved port:
// isolate the data, never the component. A dead port and an unparseable URL
// stay as they were, because absence stands in for nothing.

const ROOT = join(homedir(), '.stado', 'work', 'wl', `dist-endp-${process.pid.toString(16)}`);

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real Skarbiec binary: SKARBIEC_BIN, then PATH, then the Stado install
 * directory. When none holds it this fails by name rather than substituting a
 * listener, because a check that passes for want of a dependency is the defect
 * being removed.
 */
function skarbiecBinary(): string {
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
 * Each resolves to a path below `HOME` when unset, so redirecting `HOME`
 * covers those; dropping the prefix covers the other half. An operator shell
 * exporting `SKARBIEC_UNLOCK` or `SKARBIEC_CAPABILITY_ROUTES_FILE` would
 * otherwise hand this fixture the real passphrase and the real routes table.
 */
function withoutInheritedVault(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SKARBIEC_')) delete environment[key];
  }
  return environment;
}

/**
 * A loopback port the kernel just handed out and immediately released. Naming
 * a port instead is the hazard this removes: Skarbiec's own default port is
 * occupied on any machine running the broker, so a test naming it would talk
 * to the operator's vault instead of its own.
 */
async function reservePort(): Promise<number> {
  const server = createServer();
  const bound = Promise.withResolvers<void>();
  server.once('error', bound.reject);
  server.listen(0, '127.0.0.1', () => bound.resolve());
  await bound.promise;
  const { port } = server.address() as AddressInfo;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

function accepting(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host: '127.0.0.1', port });
  const settle = (state: boolean) => {
    socket.destroy();
    resolve(state);
  };
  socket.setTimeout(200);
  socket.once('connect', () => settle(true));
  socket.once('timeout', () => settle(false));
  socket.once('error', () => settle(false));
  return promise;
}

let brokerProcess: ChildProcess | null = null;
let brokerUrl = '';
// A port the kernel confirmed free and nothing is serving: absence, not a stand-in.
let deadUrl = '';

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
  const initialized = spawnSync(binary, ['init', 'weles-dist-endpoint-tests'], { encoding: 'utf8', env });
  assert.strictEqual(initialized.status, 0,
    `real skarbiec could not create the isolated vault: ${initialized.stderr || initialized.stdout}`);

  const port = await reservePort();
  deadUrl = `http://127.0.0.1:${await reservePort()}`;
  const child = spawn(binary, ['serve', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });

  // Real time is unavoidable: the awaited condition is a socket bound by
  // another process, so there is no in-process clock to advance. This polls
  // the actual condition rather than sleeping for a guessed duration, and a
  // broker that fails to bind still spawns — a test that slept would measure
  // whatever else holds that port.
  const deadline = Date.now() + 20_000;
  while (!(await accepting(port))) {
    assert.strictEqual(child.exitCode, null,
      `the real skarbiec broker exited with ${child.exitCode} before binding: ${output}`);
    assert.ok(Date.now() < deadline, `the real skarbiec broker never bound 127.0.0.1:${port}: ${output}`);
    const tick = Promise.withResolvers<void>();
    setTimeout(() => tick.resolve(), 50);
    await tick.promise;
  }
  brokerProcess = child;
  brokerUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  brokerProcess?.kill('SIGKILL');
  spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: join(ROOT, 'gnupg') } });
  rmSync(ROOT, { recursive: true, force: true });
});

test('isEndpointListening: a real Skarbiec broker is seen as listening', async () => {
  assert.ok(await isEndpointListening(brokerUrl, 2000), 'a real broker was reported dead');
});

test('isEndpointListening: a port nothing serves is not seen as listening', async () => {
  assert.ok(!(await isEndpointListening(deadUrl, 500)), 'an unserved port was reported alive');
});

test('isEndpointListening: an unparseable endpoint is refused rather than dialled', async () => {
  assert.ok(!(await isEndpointListening('not-a-valid-url', 500)), 'an invalid URL was dialled');
});

test('resolveSkarbiecEndpoint: the declared endpoint is resolved and its liveness measured', async () => {
  const previous = process.env.WC_SKARBIEC_URL;
  process.env.WC_SKARBIEC_URL = brokerUrl;
  try {
    const result = await resolveSkarbiecEndpoint();
    assert.ok(result.resolved, 'a declared endpoint was not resolved');
    assert.strictEqual(result.resolved?.url, brokerUrl, 'should use the declared value');
    assert.strictEqual(result.resolved?.source, 'environment', 'should mark as from environment');
    assert.ok(result.resolved?.isListening, 'should detect the real broker');
  } finally {
    if (previous === undefined) delete process.env.WC_SKARBIEC_URL;
    else process.env.WC_SKARBIEC_URL = previous;
  }
});

test('resolveSkarbiecEndpoint: refuses implicit routing when no directory endpoint is exported', async () => {
  const previous = process.env.WC_SKARBIEC_URL;
  delete process.env.WC_SKARBIEC_URL;
  try {
    const result = await resolveSkarbiecEndpoint();
    assert.strictEqual(result.resolved, null);
    assert.deepStrictEqual(result.candidates, []);
    assert.strictEqual(result.wasExplicitOverride, false);
  } finally {
    if (previous !== undefined) process.env.WC_SKARBIEC_URL = previous;
  }
});

test('resolveSkarbiecEndpoint: retains the declared endpoint when it is unavailable', async () => {
  const previous = process.env.WC_SKARBIEC_URL;
  process.env.WC_SKARBIEC_URL = deadUrl;
  try {
    const result = await resolveSkarbiecEndpoint();
    assert.ok(result.resolved, 'should retain the declared endpoint');
    assert.strictEqual(result.resolved?.url, deadUrl, 'should retain the exact directory-derived endpoint');
    assert.ok(!result.resolved?.isListening, 'should indicate that endpoint is not listening');
  } finally {
    if (previous === undefined) delete process.env.WC_SKARBIEC_URL;
    else process.env.WC_SKARBIEC_URL = previous;
  }
});

test('formatEndpointErrorMessage: names the endpoint, its source and its state', () => {
  const dead: EndpointInfo = {
    url: 'http://127.0.0.1:8785',
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: false,
  };
  const message = formatEndpointErrorMessage(dead);
  assert.match(message, /Skarbiec endpoint at http:\/\/127\.0\.0\.1:8785/, 'should include endpoint URL');
  assert.match(message, /environment variable/, 'should indicate environment source');
  assert.match(message, /not listening/, 'should indicate listening status');

  const live: EndpointInfo = { ...dead, isListening: true };
  assert.match(formatEndpointErrorMessage(live), /listening/, 'should indicate listening for a healthy endpoint');
});
