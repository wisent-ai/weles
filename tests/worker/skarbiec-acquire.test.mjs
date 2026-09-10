/**
 * The startup acquisition helper, against a real Skarbiec authority.
 *
 * `src/worker/deploy/acquire/skarbiec-acquire.mjs` is what the API launcher runs
 * twelve times before it serves, and every one of those calls asks a real
 * capability broker for one field. It used to be measured against
 * `net.createServer(() => {})` on a hard-coded port — a socket that accepts
 * and answers nothing — and the only thing asserted was that the helper did
 * not print a usage error. That proved argument parsing and nothing else, and
 * a hard-coded port on an operator's machine reaches the live vault.
 *
 * Here the authority is the real `skarbiec` binary over a vault this test
 * created with `skarbiec init`, on a port the kernel reserved. Isolate the
 * data, never the component. The three paths are the ones the launcher can
 * actually take: a malformed invocation, a scope the catalogue does not
 * declare, and an authority that refuses.
 *
 * Run: node --test tests/worker/skarbiec-acquire.test.mjs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const HELPER = join(REPO, 'src/worker/deploy/acquire/skarbiec-acquire.mjs');
const ROOT = join(homedir(), '.stado', 'work', 'wl', `acq-${process.pid.toString(16)}`);

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real Skarbiec binary: SKARBIEC_BIN, then PATH, then the Stado install
 * directory. When none holds it this fails by name rather than standing
 * something else up in its place.
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
 * Each resolves to a path below `HOME` when unset, so redirecting `HOME`
 * covers those; dropping the prefix covers the other half. An operator shell
 * exporting `SKARBIEC_UNLOCK`, `SKARBIEC_WORKLOAD_ID` or
 * `SKARBIEC_CAPABILITY_ROUTES_FILE` would otherwise hand this fixture the
 * real passphrase, the real workload identity and the real routes table.
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

let broker = null;
let scopeFile = '';
let helperEnv = {};

before(async () => {
  const binary = skarbiecBinary();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'gnupg'), { recursive: true, mode: 0o700 });
  const vaultEnv = {
    ...withoutInheritedVault(),
    HOME: ROOT,
    GNUPGHOME: join(ROOT, 'gnupg'),
    SKARBIEC_VAULT_FILE: join(ROOT, 'vault.json'),
    SKARBIEC_AUDIT_FILE: join(ROOT, 'audit.jsonl'),
  };
  const initialized = spawnSync(binary, ['init', 'weles-acquire-tests'], { encoding: 'utf8', env: vaultEnv });
  assert.equal(initialized.status, 0,
    `real skarbiec could not create the isolated vault: ${initialized.stderr || initialized.stdout}`);

  const port = await reservePort();
  const child = spawn(binary, ['serve', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: vaultEnv,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });

  // Real time is unavoidable: the awaited condition is a socket bound by
  // another process. A broker that fails to bind still spawns, so this polls
  // the condition itself rather than sleeping for a guessed duration.
  const deadline = Date.now() + 20_000;
  while (!(await accepting(port))) {
    assert.equal(child.exitCode, null,
      `the real skarbiec broker exited with ${child.exitCode} before binding: ${output}`);
    assert.ok(Date.now() < deadline, `the real skarbiec broker never bound 127.0.0.1:${port}: ${output}`);
    const tick = Promise.withResolvers();
    setTimeout(() => tick.resolve(), 50);
    await tick.promise;
  }
  broker = { child, url: `http://127.0.0.1:${port}` };

  // The launcher's own catalogue shape: one `consumer|item|field` row per line.
  scopeFile = join(ROOT, 'scopes.conf');
  writeFileSync(scopeFile, 'weles-tests|weles-tests-item|token\n');

  // The workload identity the helper signs its acquisition with. The helper
  // refuses a key file that is group- or other-readable, so this is written
  // the way a deployment writes one.
  const key = join(ROOT, 'workload.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  helperEnv = {
    ...withoutInheritedVault(),
    WC_SKARBIEC_URL: broker.url,
    SKARBIEC_WORKLOAD_ID: 'weles-acquire-tests',
    SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: key,
  };
});

after(() => {
  broker?.child.kill('SIGKILL');
  spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: join(ROOT, 'gnupg') } });
  rmSync(ROOT, { recursive: true, force: true });
});

/** The helper, run the way the launcher runs it. */
function acquire(args, env = helperEnv) {
  return spawnSync(process.execPath, [HELPER, ...args], { cwd: REPO, encoding: 'utf8', env });
}

test('an invocation that is not the four-argument form is refused', () => {
  const result = acquire(['arg1', 'arg2']);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /usage: skarbiec-acquire\.mjs <scope-file> <consumer> <item> <field>/,
    `expected the usage refusal, got: ${result.stderr || result.stdout}`,
  );
});

test('a scope the catalogue does not declare is refused before the authority is asked', () => {
  const result = acquire([scopeFile, 'weles-tests', 'weles-tests-item', 'not-declared']);
  assert.notEqual(result.status, 0);
  // The refusal names the table that was read and how big it is, because when
  // it fires the interesting fact is which copy of the catalogue is in force.
  assert.match(
    result.stderr,
    new RegExp(
      'undeclared Skarbiec acquisition scope for weles-tests on'
      + ' weles-tests-item#not-declared in .*scopes\\.conf \\(1 declared scopes\\)',
    ),
    `expected the undeclared-scope refusal, got: ${result.stderr || result.stdout}`,
  );
});

test('the real authority’s refusal is reported with the endpoint and the asserted workload', () => {
  // The vault holds no grant for this workload, so a real Skarbiec refuses the
  // issue call. The helper must hand that refusal on naming the authority it
  // reached and the identity it asserted — the two halves an operator needs to
  // tell an unregistered consumer from a grant that does not cover the read.
  const result = acquire([scopeFile, 'weles-tests', 'weles-tests-item', 'token']);
  assert.notEqual(result.status, 0, `the authority accepted an ungranted read: ${result.stdout}`);
  assert.match(
    result.stderr,
    new RegExp(
      `Skarbiec acquisition issue at ${broker.url} refused weles-tests for weles-tests-item#token: HTTP \\d{3}`,
    ),
    `expected the authority's refusal, got: ${result.stderr || result.stdout}`,
  );
  assert.match(result.stderr, /asserted workload_id=weles-acquire-tests/);
  // A refusal never carries a field value.
  assert.equal(result.stdout, '');
});

test('a dead endpoint is reported as unreachable rather than as a refusal', async () => {
  const dead = `http://127.0.0.1:${await reservePort()}`;
  const result = acquire([scopeFile, 'weles-tests', 'weles-tests-item', 'token'],
    { ...helperEnv, WC_SKARBIEC_URL: dead });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`Skarbiec endpoint at ${dead} \\(from Stado service directory via WC_SKARBIEC_URL\\) is not listening`),
    `expected the unreachable-endpoint refusal, got: ${result.stderr || result.stdout}`,
  );
});
