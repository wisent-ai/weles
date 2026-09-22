/**
 * Bringing the service up: the workload identity it acquires secrets as, the
 * fields it must hold before it answers anything, and the HTTP API hosted in
 * this same process.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HOME, REPO, STARTUP_FIELDS, actionAllowlist, declaredNames } from './configuration.mjs';
import { executable, refuse, run } from './running.mjs';

export async function startup() {
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

  // Finite credential commands use the same signed release Stado committed
  // for this host. Weles does not start another Skarbiec service.
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
  delete process.env.SKARBIEC_CAPABILITY_FILE;
  delete process.env.SKARBIEC_CAPABILITY_ROUTES_FILE;
  process.env.SKARBIEC_CAP_SOCKET ||= join(HOME, '.stado/skarbiec.vault.sock');
  const brokerStatus = run(skarbiecBin,
    ['capability-status', '--socket', process.env.SKARBIEC_CAP_SOCKET],
    'shared Skarbiec capability broker inspection');
  process.stdout.write(`shared capability broker: ${brokerStatus}\n`);

  // Declare only Weles's origin routes. Copying its table over the shared
  // authority would erase every route another consumer already declared.
  const routes = JSON.parse(readFileSync(
    join(REPO, 'src/worker/deploy/weles-capability-routes.json'), 'utf8'));
  for (const [resource, { item, field }] of Object.entries(routes)) {
    run(skarbiecBin, [
      'route', 'declare', '--resource', resource, '--item', item, '--field', field,
      '--reason', 'Weles declares the credential field used by this sign-in origin.',
    ], `shared Skarbiec route ${resource}`);
  }

  // Acquisition configures the environment before the API module reads it.
  // The server owns its listener and draining in this process, not a child Node.
  await import(pathToFileURL(join(REPO, 'src/worker/weles-api-server.mjs')).href);
}
