#!/usr/bin/env node
/**
 * The Weles API's own startup. This is the program the managed unit runs.
 *
 * It used to be a 245-line shell wrapper under a `scripts/` folder, which meant
 * the service's startup contract — which env files it reads, which Skarbiec
 * fields it must hold before it serves, which port decides who is live — lived
 * in a file nobody compiled and everybody could run by hand. It is product
 * code, so it lives here and starts the same two children the unit needs:
 *
 *   1. the Skarbiec capability broker on its unix socket, and
 *   2. the HTTP API server on WELES_API_PORT.
 *
 * A unit whose credential half is dead is down: the first child to exit ends
 * the process, and launchd's KeepAlive starts a fresh pair.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const HOME = process.env.HOME || homedir();
const PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** The env files the deployment owns, in the order they override each other. */
const ENV_FILES = [
  join(HOME, 'weles/var/worker.env'),
  join(HOME, 'weles/var/worker-content.env'),
  join(HOME, '.config/weles/worker.env'),
  join(HOME, '.weles/secrets.env'),
  join(HOME, '.stado/weles-model.env'),
];

/** Startup fields this service must hold before it answers anything. */
const STARTUP_FIELDS = [
  ['WELES_API_TOKEN', 'weles-echo-api-token-bootstrap', 'echo-weles-api', 'token', true],
  ['BRAMA_WELES_REAUTH_TOKEN', 'weles-brama-reauth-token-bootstrap', 'brama-weles-reauth', 'token', true],
  ['WELES_STADO_OBJECT_API_TOKEN', 'weles-object-token-bootstrap', 'weles-object-api', 'token', false],
  ['WELES_STADO_MODEL_ROUTER_TOKEN', 'weles-model-router-token-bootstrap', 'weles-model-router', 'token', false],
  ['WELES_STADO_MODEL_ROUTER_AGENT_ID', 'weles-model-agent-id-bootstrap', 'weles-model-agent-auth', 'id', false],
  ['WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET', 'weles-model-agent-secret-bootstrap', 'weles-model-agent-auth', 'agent_auth_secret', false],
  ['WELES_PUBLIC_API_BEARER', 'weles-spis-public-bearer-bootstrap', 'weles-spis-public-admission', 'token', true],
  ['WELES_PUBLIC_API_ORGANIZATION_ID', 'weles-spis-public-organization-bootstrap', 'weles-spis-public-admission', 'organization_id', true],
  ['WELES_RECEIPT_KEY_ID', 'weles-spis-receipt-key-id-bootstrap', 'weles-spis-public-admission', 'receipt_key_id', true],
  ['WELES_RECEIPT_KEY_SET_VERSION', 'weles-spis-receipt-key-set-version-bootstrap', 'weles-spis-public-admission', 'receipt_key_set_version', true],
  ['WELES_RECEIPT_PRIVATE_KEY', 'weles-spis-receipt-private-key-bootstrap', 'weles-spis-public-admission', 'receipt_private_key', true],
  ['WELES_RECEIPT_PUBLIC_KEYS_JSON', 'weles-spis-receipt-public-keys-bootstrap', 'weles-spis-public-admission', 'receipt_public_keys_json', true],
];

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** `KEY=value` lines the deployment wrote, with the shell quoting it used. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  if (result.error) refuse(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    refuse(`${label} refused (exit ${result.status ?? 'none'}, signal ${result.signal ?? 'none'}): ${(result.stderr || result.stdout || 'no diagnostic output').trim().slice(0, 400)}`);
  }
  return result.stdout.trim();
}

function executable(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The exact action catalog this build may dispatch. */
function actionAllowlist() {
  const path = join(REPO, 'src/worker/deploy/weles-action-allowlist.txt');
  const actions = readFileSync(path, 'utf8').split(/\r?\n/).map((action) => action.trim()).filter(Boolean);
  const invalid = !actions.length
    || new Set(actions).size !== actions.length
    || actions.some((action) => !/^[a-z_]+$/.test(action));
  if (invalid) refuse(`invalid exact Weles action catalog: ${path}`);
  return actions.join(',');
}

/**
 * What this build may run by name: the declared engagements, and the declared
 * observations.
 *
 * One loader per family, and each is the module admission itself uses, so a
 * declaration naming a reviewed trajectory that is not in this tree refuses
 * the unit here — before it serves — instead of failing the first caller who
 * happens to name that engagement or that observation. The names are exported
 * so the desktop console can state what the host is authorized to run.
 */
async function declaredNames(relativeModule, loader) {
  const module = join(REPO, relativeModule);
  let load;
  try {
    ({ [loader]: load } = await import(module));
  } catch (error) {
    refuse(`${loader} is unavailable: ${module}: ${error.message}`);
  }
  try {
    return [...load(REPO).keys()].join(',');
  } catch (error) {
    refuse(error.message);
  }
}

process.env.PATH = `${PATH_PREFIX}:${process.env.PATH ?? ''}`;
const releaseVersion = process.env.WELES_WORKER_RELEASE_VERSION ?? '';
const releaseSha256 = process.env.WELES_WORKER_RELEASE_SHA256 ?? '';
for (const path of ENV_FILES) loadEnvFile(path);
if (releaseVersion && releaseSha256) {
  process.env.WELES_WORKER_RELEASE_VERSION = releaseVersion;
  process.env.WELES_WORKER_RELEASE_SHA256 = releaseSha256;
}

process.env.WELES_API_HOST = process.env.WELES_API_HOST || '0.0.0.0';
process.env.WELES_API_PORT = process.env.WELES_API_PORT || '8788';
const port = process.env.WELES_API_PORT;

// Avoid acquiring credentials when another API already serves this port.
// This observation is not a lock: launchers that race past it must have
// separate broker sockets, so a losing instance cannot disconnect the winner.
//
// What it says matters as much as what it does. On 2026-09-21 Brama's
// sign-in for one of the operator's five accounts died with
// `hyper::Error(IncompleteMessage)` against this port, and this unit's whole
// log was `port 8788 is already served: standing by`, once a minute, for
// hours: no holder, no health, and `stado service status weles-api` reading
// `active` the entire time. So the holder is named, and it is asked whether
// it is a Weles at all. A stranger on this port is not a reason to stand by
// quietly — the unit exits nonzero so the fleet sees a service that is not
// serving.
const lsof = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
const served = spawnSync(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
if (served.status === 0 && served.stdout.trim()) {
  const holder = portHolder(served.stdout);
  const health = await holderHealth(port);
  if (health.weles) {
    process.stderr.write(
      `weles api port ${port} is already served by ${holder}, which answers /healthz as ${health.source}` +
        `${health.version ? ` version ${health.version}` : ''}: standing by without changing broker state\n`,
    );
    setTimeout(() => process.exit(0), 30_000);
  } else {
    refuse(
      `weles api port ${port} is held by ${holder}, which is not a Weles API: ${health.detail}. ` +
        'This unit cannot serve while that process holds the port, and standing by would leave the ' +
        'service reported as active while every caller of /reauth and /run fails. Stop or re-place the ' +
        'holder, then let this unit start: `stado service restart weles-api`.',
    );
  }
} else {
  await startup();
}

/** The first listening process in an `lsof` listing, as `command pid (user)`. */
function portHolder(listing) {
  const row = listing
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!row) return 'an unidentified process';
  const [command, pid, user] = row.split(/\s+/);
  return `${command} pid ${pid} (${user})`;
}

/**
 * What the process on this port says it is. A Weles answers `/healthz` with
 * its own source name; anything else - a forward, a stale build, another
 * product - is a stranger, and the reason is kept for the refusal.
 */
async function holderHealth(apiPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/healthz`);
    if (!response.ok) return { weles: false, detail: `it answered /healthz with HTTP ${response.status}` };
    const body = await response.json();
    const source = typeof body?.source === 'string' ? body.source : '';
    if (!source.startsWith('weles')) {
      return { weles: false, detail: `its /healthz names ${source || 'no source'}` };
    }
    return { weles: true, source, version: typeof body?.version === 'string' ? body.version : '' };
  } catch (error) {
    return { weles: false, detail: `/healthz could not be read: ${error.message}` };
  }
}

async function startup() {
  // Secret acquisition authenticates the workload itself, so the identity is
  // set before the first acquisition, not only before the broker starts.
  process.env.SKARBIEC_WORKLOAD_ID = process.env.SKARBIEC_WORKLOAD_ID || 'weles-credential-worker-local';
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.S2_API_KEY;
  process.env.WELES_REPO = REPO;

  const stadoBin = process.env.STADO_BIN || join(HOME, '.stado/bin/stado');
  process.env.STADO_BIN = stadoBin;
  if (!executable(stadoBin)) refuse(`required Stado binary is unavailable: ${stadoBin}`);
  const nodeBin = process.env.NODE_BIN || process.execPath;

  // Page reading needs the native binaries from this release.
  // A host installation or inherited override must not hide an incomplete payload.
  const jedenBin = join(REPO, 'native/jeden/bin/jeden');
  const requiredNative = ['jeden'];
  if (process.platform === 'darwin') requiredNative.push('jeden-sandbox-helper');
  for (const name of requiredNative) {
    const binary = join(REPO, 'native/jeden/bin', name);
    if (!executable(binary)) refuse(`required Weles native runtime is unavailable: ${binary}`);
    run(binary, ['--version'], `required Weles native runtime ${binary} --version`);
  }
  process.env.WELES_JEDEN_BIN = jedenBin;
  process.stdout.write(`page questions run ${jedenBin}; native runtime ${requiredNative.join(', ')}\n`);

  // The fleet service directory owns the canonical Skarbiec authority. Reading
  // an agent-ingress URL here sent a same-host workload out through Caddy and
  // made startup disagree with every local Stado verifier, so this caller's
  // declared endpoint is resolved instead — the stable release proxy, never a
  // second vault.
  const runtimeResolver = join(REPO, 'src/_shared/skarbiec-runtime.mjs');
  const skarbiecUrl = run(nodeBin, [runtimeResolver, 'endpoint'], 'Skarbiec endpoint resolution');
  if (!skarbiecUrl) refuse('fleet service directory has no Skarbiec endpoint for this host');
  process.env.WC_SKARBIEC_URL = skarbiecUrl;

  // The capability broker must come from the same signed release state Stado
  // committed for this host, never a mutable convenience path that can belong
  // to a different Skarbiec generation.
  const skarbiecBin = run(nodeBin, [runtimeResolver, 'active-binary'], 'Skarbiec binary resolution');
  if (!skarbiecBin) refuse('Stado has no attested active Skarbiec binary for this host');
  process.env.SKARBIEC_BIN = skarbiecBin;
  process.env.WELES_ACTION_ALLOWLIST = actionAllowlist();
  process.env.WELES_ENGAGEMENT_DECLARATION =
    await declaredNames('dist/worker/declared/engagements.js', 'loadDeclaredEngagements');
  process.env.WELES_OBSERVATION_DECLARATION =
    await declaredNames('dist/worker/declared/observations.js', 'loadDeclaredObservations');

  const acquireHelper = join(REPO, 'src/worker/deploy/acquire/skarbiec-acquire.mjs');
  const acquireScopes = join(REPO, 'src/worker/deploy/acquire/skarbiec-acquisition-scopes.conf');
  for (const [variable, consumer, item, field, always] of STARTUP_FIELDS) {
    if (!always && process.env[variable]) continue;
    const value = run(nodeBin, [acquireHelper, acquireScopes, consumer, item, field],
      `Skarbiec field ${item}/${field}`);
    if (!value) refuse(`empty Skarbiec field ${item}/${field} through: ${skarbiecUrl}`);
    process.env[variable] = value;
  }
  for (const [variable] of STARTUP_FIELDS) {
    if (!process.env[variable]) refuse(`required startup secret ${variable} is unavailable`);
  }

  process.env.WELES_PUBLIC_API_ALLOWED_ORIGINS = '*';
  mkdirSync(join(HOME, 'weles/var'), { recursive: true });
  // Set unconditionally: the unit's plist injects this variable, so a default
  // expression would never win. This is the alias Brama serves for Weles; the
  // model behind it is the route table's decision, not this file's.
  process.env.WELES_AGENT_MODEL = 'weles';
  process.env.STADO_MODEL_ROUTER_URL = 'http://127.0.0.1:17601';
  process.env.STADO_API_URL = 'http://127.0.0.1:17603';
  process.env.STADO_API_TOKEN = process.env.WELES_STADO_OBJECT_API_TOKEN;
  process.env.SKARBIEC_VAULT_FILE = join(HOME, '.stado/skarbiec.vault.json');
  process.env.SKARBIEC_CAPABILITY_FILE = join(HOME, '.stado/weles-api-capabilities.json');
  mkdirSync(join(HOME, '.stado/run'), { recursive: true });
  const brokerDirectory = mkdtempSync(join(HOME, '.stado/run/weles-api-'));
  const capabilitySocket = join(brokerDirectory, 'capability.sock');
  process.env.SKARBIEC_CAP_SOCKET = capabilitySocket;
  process.once('exit', () => rmSync(brokerDirectory, { recursive: true, force: true }));

  const capabilityRoutes = join(HOME, '.stado/weles-api-capability-routes.json');
  copyFileSync(join(REPO, 'src/worker/deploy/weles-capability-routes.json'), capabilityRoutes);
  chmodSync(capabilityRoutes, 0o600);
  process.env.SKARBIEC_CAPABILITY_ROUTES_FILE = capabilityRoutes;

  await start(nodeBin, capabilitySocket);
}

async function start(nodeBin, capabilitySocket) {
  const broker = spawn(process.env.SKARBIEC_BIN, ['capability-serve', '--socket', capabilitySocket],
    { stdio: 'inherit', env: process.env });
  let brokerAlive = true;
  broker.on('exit', () => { brokerAlive = false; });

  // Starting the API server before the broker accepts is a race the API loses
  // once, silently, on the first trajectory that asks for a credential.
  let ready = false;
  for (let attempt = 0; attempt < 50 && brokerAlive; attempt += 1) {
    try {
      if (statSync(capabilitySocket).isSocket()) { ready = true; break; }
    } catch { /* not bound yet */ }
    await new Promise((settle) => setTimeout(settle, 200));
  }
  if (!ready) {
    broker.kill();
    refuse(`capability broker never bound ${capabilitySocket}`);
  }
  process.stdout.write(`capability broker listening on ${capabilitySocket}\n`);

  const server = spawn(nodeBin, [join(REPO, 'src/worker/weles-api-server.mjs')],
    { stdio: 'inherit', env: process.env });

  // launchd replaces this job with `launchctl kickstart -k`, which signals the
  // job and immediately starts its successor, so shutting down means ending
  // BOTH children and waiting for them: otherwise the successor finds the API
  // port still held by an orphan and times out its readiness.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of [server, broker]) {
      if (child.exitCode === null) child.kill(signal === 'exit' ? 'SIGTERM' : signal);
    }
  };
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

  // The job used to wait on the API server alone. On 2026-09-05 the broker had
  // exited within two minutes of a clean start, the API kept answering for a
  // day, launchd reported the unit active, and every credential fill read
  // ECONNREFUSED. A unit whose credential half is dead is down, so the first
  // child to exit ends this process and KeepAlive starts a fresh pair.
  const ended = await new Promise((settle) => {
    server.on('exit', (code, signal) => settle({ who: 'weles api server', code, signal }));
    broker.on('exit', (code, signal) => settle({ who: 'capability broker', code, signal }));
  });
  process.stderr.write(`${ended.who} exited with ${ended.signal ?? `status ${ended.code}`};`
    + ' ending the other child so launchd restarts both\n');
  shutdown('SIGTERM');
  process.exit(ended.code ?? 1);
}
