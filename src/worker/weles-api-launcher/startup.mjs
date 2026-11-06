/**
 * Bringing the service up: the workload identity it acquires secrets as, the
 * fields it must hold before it answers anything, and the HTTP API hosted in
 * this same process.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  HOME,
  REPO,
  STARTUP_FIELDS,
  actionAllowlist,
  declaredNames,
} from './configuration.mjs';
import { notAFile, refuse, run, runAsync, runCommand } from './running.mjs';

/**
 * The address Stado's service directory published for `service` on this host
 * (`~/.stado/forwards/<service>.local`). No port is written here: the
 * resolver adapter's bind is the host's declaration, and a guessed one reaches
 * whatever listens there. With `optional`, a host the directory publishes no
 * such service on (no marker at all) answers `undefined`; a marker that exists
 * but cannot be read, or is empty, is refused either way.
 */
function forwardedAddress(service, { optional = false } = {}) {
  const marker = join(HOME, '.stado/forwards', `${service}.local`);
  let address = '';
  try {
    address = readFileSync(marker, 'utf8').trim();
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    refuse(
      `no ${service} address: ${marker} cannot be read (${error.message}); let \`stado service directory publish\` write it`,
    );
  }
  if (!address) refuse(`no ${service} address: ${marker} is empty`);
  return address;
}

export async function startup() {
  // Secret acquisition authenticates the workload itself, so the identity is
  // checked before the first acquisition, not only before the broker starts.
  // It is the name Skarbiec's workload registry knows this service by, which
  // the service unit declares; a name chosen here would sign as a workload
  // the registry may not hold.
  if (!process.env.SKARBIEC_WORKLOAD_ID?.trim())
    refuse(
      "SKARBIEC_WORKLOAD_ID is not set: the service unit names the workload Skarbiec's registry knows Weles by",
    );
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.S2_API_KEY;
  process.env.WELES_REPO = REPO;

  const stadoBin = process.env.STADO_BIN || join(HOME, '.stado/bin/stado');
  process.env.STADO_BIN = stadoBin;
  const stadoProblem = notAFile(stadoBin);
  if (stadoProblem) refuse(`required Stado binary ${stadoBin} ${stadoProblem}`);
  const nodeBin = process.env.NODE_BIN || process.execPath;

  // Page reading needs the native binaries from this release.
  // A host installation or inherited override must not hide an incomplete payload.
  const jedenBin = join(REPO, 'native/jeden/bin/jeden');
  const requiredNative = ['jeden'];
  if (process.platform === 'darwin')
    requiredNative.push('jeden-sandbox-helper');
  for (const name of requiredNative) {
    const binary = join(REPO, 'native/jeden/bin', name);
    const binaryProblem = notAFile(binary);
    if (binaryProblem)
      refuse(`required Weles native runtime ${binary} ${binaryProblem}`);
    run(
      binary,
      ['--version'],
      `required Weles native runtime ${binary} --version`,
    );
  }
  process.env.WELES_JEDEN_BIN = jedenBin;
  process.stdout.write(
    `page questions run ${jedenBin}; native runtime ${requiredNative.join(', ')}\n`,
  );

  // The fleet service directory owns the canonical Skarbiec authority. Reading
  // an agent-ingress URL here sent a same-host workload out through Caddy and
  // made startup disagree with every local Stado verifier, so this caller's
  // declared endpoint is resolved instead — the stable release proxy, never a
  // second vault.
  const runtimeResolver = join(REPO, 'src/_shared/skarbiec-runtime.mjs');
  const skarbiecUrl = run(
    nodeBin,
    [runtimeResolver, 'endpoint'],
    'Skarbiec endpoint resolution',
  );
  if (!skarbiecUrl)
    refuse('fleet service directory has no Skarbiec endpoint for this host');
  process.env.WC_SKARBIEC_URL = skarbiecUrl;

  // Finite credential commands use the same signed release Stado committed
  // for this host. Weles does not start another Skarbiec service.
  const skarbiecBin = run(
    nodeBin,
    [runtimeResolver, 'active-binary'],
    'Skarbiec binary resolution',
  );
  if (!skarbiecBin)
    refuse('Stado has no attested active Skarbiec binary for this host');
  process.env.SKARBIEC_BIN = skarbiecBin;
  process.env.WELES_ACTION_ALLOWLIST = actionAllowlist();
  process.env.WELES_ENGAGEMENT_DECLARATION = await runAsync(
    'load engagement declaration',
    () =>
      declaredNames(
        'dist/worker/declared/engagements.js',
        'loadDeclaredEngagements',
      ),
  );
  process.env.WELES_OBSERVATION_DECLARATION = await runAsync(
    'load observation declaration',
    () =>
      declaredNames(
        'dist/worker/declared/observations.js',
        'loadDeclaredObservations',
      ),
  );

  const acquireHelper = join(
    REPO,
    'src/worker/deploy/acquire/skarbiec-acquire.mjs',
  );
  const acquireScopes =
    process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE?.trim() ||
    join(REPO, 'src/worker/deploy/acquire/skarbiec-acquisition-scopes.conf');
  for (const [variable, consumer, item, field, always] of STARTUP_FIELDS) {
    if (!always && process.env[variable]) continue;
    const value = run(
      nodeBin,
      [acquireHelper, acquireScopes, consumer, item, field],
      `Skarbiec field ${item}/${field}`,
    );
    if (!value)
      refuse(`empty Skarbiec field ${item}/${field} through: ${skarbiecUrl}`);
    process.env[variable] = value;
  }
  for (const [variable] of STARTUP_FIELDS) {
    if (!process.env[variable])
      refuse(`required startup secret ${variable} is unavailable`);
  }

  process.env.WELES_PUBLIC_API_ALLOWED_ORIGINS = '*';
  mkdirSync(join(HOME, 'weles/var'), { recursive: true });
  // Set unconditionally: the unit's plist injects this variable, so a default
  // expression would never win. This is the alias Brama serves for Weles; the
  // model behind it is the route table's decision, not this file's.
  process.env.WELES_AGENT_MODEL = 'weles';
  // Brama is one model route among Stado's alternatives, not a dependency:
  // a host the directory publishes no Brama on leaves STADO_MODEL_ROUTER_URL
  // unset, and the agent asks Stado's inference alternatives
  // (agent/model/router-config.ts). Requiring the marker kept Weles down on
  // every host without a Brama.
  const brama = forwardedAddress('brama', { optional: true });
  if (brama) process.env.STADO_MODEL_ROUTER_URL = brama;
  else delete process.env.STADO_MODEL_ROUTER_URL;
  process.env.STADO_API_URL = forwardedAddress('stado-object-api');
  process.env.STADO_API_TOKEN = process.env.WELES_STADO_OBJECT_API_TOKEN;
  // Which vault serves Weles is Skarbiec's to choose: the one Stado declares
  // for this machine, or the fleet owner it forwards to. Naming the account's
  // ~/.stado vault file here turned that forwarding off and tied the API to
  // whichever host held the file.
  delete process.env.SKARBIEC_VAULT_FILE;
  delete process.env.SKARBIEC_CAPABILITY_FILE;
  delete process.env.SKARBIEC_CAPABILITY_ROUTES_FILE;
  // The shared broker is the one Stado declares for the Skarbiec unit on this
  // host. A value inherited from an env file named the per-Weles broker that
  // was retired, a socket nothing serves, and every start died on it.
  const declaredSocket = run(
    nodeBin,
    [runtimeResolver, 'capability-socket'],
    'shared Skarbiec capability socket resolution',
  );
  if (!declaredSocket)
    refuse("Stado declares no capability socket for this host's Skarbiec unit");
  const inheritedSocket = process.env.SKARBIEC_CAP_SOCKET;
  if (inheritedSocket && inheritedSocket !== declaredSocket) {
    process.stdout.write(
      `ignoring SKARBIEC_CAP_SOCKET=${inheritedSocket} from the environment; ` +
        `the shared broker Stado declares for this host's Skarbiec is ${declaredSocket}\n`,
    );
  }
  process.env.SKARBIEC_CAP_SOCKET = declaredSocket;
  const brokerStatus = run(
    skarbiecBin,
    ['capability', 'status', '--socket', process.env.SKARBIEC_CAP_SOCKET],
    'shared Skarbiec capability broker inspection',
  );
  process.stdout.write(`shared capability broker: ${brokerStatus}\n`);

  // Declare only Weles's origin routes. Copying its table over the shared
  // authority would erase every route another consumer already declared.
  // Each route names the role tag its credential carries, never an item.
  // A route Skarbiec refuses is reported and the rest of Weles starts: the
  // table keeps the row it already holds for that origin, and one sign-in
  // origin whose role nobody has settled must not take every other origin
  // and the whole API down with it.
  const routes = JSON.parse(
    readFileSync(
      join(REPO, 'src/worker/deploy/weles-capability-routes.json'),
      'utf8',
    ),
  );
  for (const [resource, { tag, field }] of Object.entries(routes)) {
    const declared = runCommand(
      skarbiecBin,
      [
        'route',
        'declare',
        '--resource',
        resource,
        '--tag',
        tag,
        '--field',
        field,
        '--reason',
        'Weles declares the credential field used by this sign-in origin.',
      ],
      `Skarbiec route declaration ${resource}`,
    );
    // A run failed when it could not start, exited with a status, or was
    // ended by a signal; success is none of the three.
    if (declared.error || declared.status || declared.signal) {
      // Everything the run said about why, in its own words.
      const why = JSON.stringify(
        [
          declared.error?.message,
          declared.signal && `ended by signal ${declared.signal}`,
          declared.status && `exited with status ${declared.status}`,
          declared.stderr,
          declared.stdout,
        ]
          .filter((said) => typeof said === 'string' && said.trim())
          .map((said) => said.trim()),
      );
      process.stdout.write(
        `route ${resource} not declared as ${tag}#${field}: ${why}; ` +
          'sign-ins on that origin use the row the shared table already holds, if any, ' +
          `until an item carrying ${tag} answers it\n`,
      );
    }
  }

  // Acquisition configures the environment before the API module reads it.
  // The server owns its listener and draining in this process, not a child Node.
  await runAsync(
    'import Weles HTTP API',
    () =>
      import(pathToFileURL(join(REPO, 'src/worker/weles-api-server.mjs')).href),
  );
}
