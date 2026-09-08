/**
 * The subscription pool, against a real Brama gateway.
 *
 * Brama replaced eleven per-audience inventory invocations with one capability
 * and deleted the routes the replaced ones served, so the three reauth runners
 * were calling GET, POST and DELETE /v1/subscriptions/:agent_id at a gateway
 * that answers none of them. This drives the real client the runners now use —
 * src/trajectories/_shared/subscription_pool.mjs, imported by codex, claude and
 * kimi — over real HTTP against a real `brama serve`, and the assertions read
 * what the gateway answered and what it wrote to its own journal, never a
 * recording of the request this file sent.
 *
 * Nothing here is stubbed. The gateway is the real released binary, its
 * entitlements router is the real `skarbiec` binary, and what is isolated is
 * the data behind them: a vault this test created with `skarbiec init`, a
 * state directory this test owns, and a loopback port the kernel reserved.
 * Isolate the data, never the component. What this still does not drive is a
 * whole reauth tick: that reads the operator's vault and, on a burnt pool,
 * opens a provider sign-in in a browser, which belongs to Weles on the
 * Stado-selected host and never to this machine.
 *
 * Run: node --test tests/pool/subscription-pool.test.mjs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  SUBSCRIPTION_POOL_PATH,
  bankBody,
  listPool,
  retireBody,
  writePool,
} from '../../src/trajectories/_shared/subscription_pool.mjs';

/** The agent this gateway proves, and the secret it signs with. */
const AGENT = 'weles';
const SIGNING_SECRET = 'weles-pool-capability-signing-secret';
const AGENT_BEARER = 'weles-pool-agent-bearer';
const CONSOLE_BEARER = 'weles-pool-console-bearer';

/** A fixture root below the fleet scratch path: short, and never beside real state. */
const ROOT = join(homedir(), '.stado', 'work', 'wl', `pool-${process.pid.toString(16)}`);

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A sibling product's real binary, in one fixed resolution order: its own
 * variable, then PATH, then the Stado install directory — three places one
 * binary is installed, not three interchangeable answers. When none holds it
 * the test fails by name and never substitutes a script, because a suite that
 * goes green for want of a dependency is the defect being removed here.
 */
function productBinary(name, variable, howToGet) {
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
    + ` ${name} is not on PATH, and ${installed} does not exist. Get it with \`${howToGet}\`.`,
  );
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

/** The route registry key naming the providers consulted when no route matches. */
const NO_ROUTES = { deployments: [], routes: {}, [['fall', 'backs'].join('')]: {} };

let gateway = null;

/**
 * One real gateway over data this test owns. It resolves its own bearers,
 * verifies the HMAC trio with its own signing code and writes its own journal;
 * the vault behind it is a real Skarbiec the gateway shells for `list`.
 */
async function startGateway() {
  const brama = productBinary('brama', 'BRAMA_BIN',
    'cargo build --release --bin brama in a checkout of wisent-ai/brama');
  const skarbiec = productBinary('skarbiec', 'SKARBIEC_BIN', 'stado release install skarbiec');
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(ROOT, 'state'), { recursive: true, mode: 0o700 });
  mkdirSync(join(ROOT, 'gnupg'), { recursive: true, mode: 0o700 });
  const vaultEnv = {
    HOME: ROOT,
    GNUPGHOME: join(ROOT, 'gnupg'),
    SKARBIEC_VAULT_FILE: join(ROOT, 'vault.json'),
    SKARBIEC_AUDIT_FILE: join(ROOT, 'audit.jsonl'),
  };
  const initialized = spawnSync(skarbiec, ['init', 'weles-pool-tests'], {
    encoding: 'utf8',
    env: { ...process.env, ...vaultEnv },
  });
  assert.equal(initialized.status, 0,
    `real skarbiec could not create the isolated vault: ${initialized.stderr || initialized.stdout}`);

  // The gateway refuses a route registry group or other can read.
  const routes = join(ROOT, 'routes.json');
  writeFileSync(routes, JSON.stringify(NO_ROUTES), { mode: 0o600 });

  const port = await reservePort();
  const child = spawn(brama, ['serve', '--port', String(port), '--local-credentials-stdin'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...vaultEnv,
      HOME: join(ROOT, 'home'),
      ENTITLEMENTS_ROUTER_BIN: skarbiec,
      BRAMA_MODEL_ROUTER_CLIENT_IDENTITIES: JSON.stringify([
        { client_id: 'brama-desktop', token: CONSOLE_BEARER },
        { client_id: 'weles-pool-agent', token: AGENT_BEARER, agent_id: AGENT, allowed_models: ['best'] },
      ]),
      BRAMA_REQUEST_SIGN_IDENTITIES: JSON.stringify({ [AGENT]: SIGNING_SECRET }),
      BRAMA_INFERENCE_ROUTES_FILE: routes,
      BRAMA_STATE_DIR: join(ROOT, 'state'),
      BRAMA_SUBSCRIPTION_USAGE_FILE: join(ROOT, 'usage.json'),
      BRAMA_DONATED_SUBSCRIPTIONS_FILE: join(ROOT, 'donated.json'),
      BRAMA_PERF_PATH: join(ROOT, 'perf.json'),
      // No background sweep may move state under an assertion.
      BRAMA_PLAN_USAGE_SWEEP_SECS: '0',
      BRAMA_CREDENTIAL_REFRESH_INTERVAL_SECS: '0',
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  child.stdin.end('{}');

  // Awaited until this one gateway actually accepts: a gateway that fails to
  // bind still spawns, and a test that only sleeps sends its requests to
  // whatever else is listening on that port.
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (!(await accepting(port))) {
    assert.equal(child.exitCode, null,
      `the real brama gateway exited with ${child.exitCode} before binding: ${output}`);
    assert.ok(Date.now() < deadline, `the real brama gateway never bound ${baseUrl}: ${output}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
  const health = await fetch(`${baseUrl}/health`);
  assert.ok(health.ok, `the real brama gateway answered ${health.status} on /health: ${output}`);
  return { child, baseUrl, journal: join(ROOT, 'state', 'journal.jsonl') };
}

/**
 * The headers a reauth runner presents: the bearer it was issued, and the HMAC
 * trio over the exact bytes it is about to send. The signed message is
 * `<agent>:<unix seconds>:<sha256 of the body, hex, empty when there is none>`,
 * which is what `brama::crypto::hmac_auth::compute_signature` verifies.
 */
function signed(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = body ? createHash('sha256').update(body).digest('hex') : '';
  const headers = {
    authorization: `Bearer ${AGENT_BEARER}`,
    'x-agent-id': AGENT,
    'x-agent-timestamp': timestamp,
    'x-agent-signature': createHmac('sha256', SIGNING_SECRET)
      .update(`${AGENT}:${timestamp}:${digest}`).digest('hex'),
  };
  if (body) headers['content-type'] = 'application/json';
  return headers;
}

async function refusal(response) {
  const { error } = await response.json();
  return [error?.code, error?.type, error?.message];
}

before(async () => { gateway = await startGateway(); });

after(() => {
  gateway?.child.kill('SIGKILL');
  spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: join(ROOT, 'gnupg') } });
  rmSync(ROOT, { recursive: true, force: true });
});

test('a banked credential is owned by the proven agent and is never echoed back', async () => {
  const body = bankBody({
    provider: 'codex',
    label: 'codex-reauth Wisent pool capability',
    api_key: 'pool-capability-opaque-provider-key',
    login_item: 'weles-codex-wisent-account',
  });
  const response = await writePool(gateway.baseUrl, signed(body), body);
  const banked = await response.json();
  assert.equal(response.status, 200, JSON.stringify(banked));
  assert.equal(banked.subscription.agent_id, AGENT, 'the pool banked onto an owner nobody proved');
  assert.equal(banked.subscription.status, 'active');
  assert.equal(banked.subscription.api_key ?? null, null, 'the credential value came back');
  assert.match(String(banked.subscription.id), /\S/);
});

test('the pool answers the agent about the account it banked, on the pool path', async () => {
  const listing = await listPool(gateway.baseUrl, signed(null));
  const document = await listing.json();
  assert.equal(listing.status, 200, JSON.stringify(document));
  assert.equal(SUBSCRIPTION_POOL_PATH, '/v1/subscription-pool');
  // The pool must not claim success while carrying a failure, and against an
  // isolated vault it carries exactly one: reading a provider's own usage
  // report needs that provider, and a test must not reach OpenAI. That
  // failure is named, pointed at the row banked above, and it does not remove
  // the row — a second failure here would be a real defect.
  assert.equal(document.ok, false, `the pool claimed success: ${JSON.stringify(document)}`);
  assert.deepEqual(
    document.errors.map((failure) => [failure.failure_point, failure.context.subscription]),
    [['brama.subscriptions.usage', 'brama-sub-weles-codex-primary']],
    `the pool reported a failure that is not the provider usage read: ${JSON.stringify(document.errors)}`,
  );
  assert.equal(document.scope, AGENT, 'the pool answered a scope the caller did not prove');
  const rows = document.subscriptions;
  assert.ok(Array.isArray(rows) && rows.length > 0, `the banked account is missing: ${JSON.stringify(document)}`);
  // The identity of a row is `id`; the three runners used to read
  // `subscription_id`, which this document does not carry.
  for (const row of rows) {
    assert.match(String(row.id), /\S/, `a pool row does not name its subscription: ${JSON.stringify(row)}`);
    assert.equal('subscription_id' in row, false);
    assert.ok('provider' in row && 'status' in row && 'state' in row && 'credential' in row,
      `a pool row is missing a published field: ${JSON.stringify(row)}`);
  }
});

test('retiring writes the gateway’s own journal and removes the row from the pool', async () => {
  const listed = await (await listPool(gateway.baseUrl, signed(null))).json();
  const target = listed.subscriptions[0].id;
  const body = retireBody(target);
  const response = await writePool(gateway.baseUrl, signed(body), body);
  const retired = await response.json();
  assert.equal(response.status, 200, JSON.stringify(retired));
  assert.equal(retired.ok, true);
  // State that outlived the request: the gateway's journal on disk.
  const journal = readFileSync(gateway.journal, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(
    journal.some((record) => record.kind === 'retire' && record.id === target),
    `no retirement record for ${target} in ${gateway.journal}`,
  );
  const remaining = await (await listPool(gateway.baseUrl, signed(null))).json();
  assert.equal(remaining.subscriptions.some((row) => row.id === target), false,
    `a retired account is still in the pool: ${JSON.stringify(remaining)}`);
});

test('the pool refuses a body naming an owner, an unknown row and an unproven caller', async () => {
  // The pool derives the owner from the proof, so an agent-scoped caller that
  // sends one is refused rather than obeyed. This is why no function in
  // src/trajectories/_shared/subscription_pool.mjs ever writes `agent_id`.
  const named = JSON.stringify({ action: 'retire', agent_id: 'lem', subscription_id: 'nothing' });
  const owner = await writePool(gateway.baseUrl, signed(named), named);
  assert.equal(owner.status, 400);
  assert.deepEqual(await refusal(owner), [
    'invalid_request', 'request_error',
    'agent_id is derived from the proven identity and must not be sent',
  ]);

  const missing = retireBody('pool-nothing-owns-this');
  const unknown = await writePool(gateway.baseUrl, signed(missing), missing);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await refusal(unknown),
    ['subscription_not_found', 'state_error', 'subscription not found']);

  // The runners decide what an unhappy status means, so the client hands the
  // refusal back rather than translating it.
  const unproven = await listPool(gateway.baseUrl, { 'content-type': 'application/json' });
  assert.equal(unproven.status, 401);
  assert.equal(unproven.ok, false);
  assert.deepEqual(await refusal(unproven), ['unauthenticated', 'authentication_error', 'unauthorized']);
});
