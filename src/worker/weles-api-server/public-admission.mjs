// Which published public service this host is authorized to be, and what a
// public task's child process is allowed to inherit from it.
//
// Both answers come from outside the request: Stado publishes a placement
// policy and a service-directory snapshot on the local filesystem, and this
// module refuses to admit public work unless exactly one host in that policy
// carries the action, unless the directory names this host as the active one,
// and unless the local transport address agrees with the published endpoint.
// A host that merely holds the port is not the service; the operator's
// published record is.
//
// The child environment is the same admission seen from the other end: a public
// task inherits an explicitly named set of variables and nothing else, so a
// secret this server holds for its own routes cannot reach a browser run
// started by an anonymous caller.

import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { RUN_RELEASE_IDENTITY } from './release-identity.mjs';

const PUBLIC_PLACEMENT_POLICY_FILE = process.env.WELES_PLACEMENT_POLICY_FILE
  || join(homedir(), '.config', 'weles', 'placement-policy.json');
const PUBLIC_SERVICE_DIRECTORY_FILE = process.env.WELES_PUBLIC_SERVICE_DIRECTORY_FILE
  || join(homedir(), '.stado', 'forwards', 'weles-admission.directory.json');
const PUBLIC_ADMISSION_ENDPOINT_FILE = process.env.WELES_ADMISSION_ENDPOINT_FILE
  || join(homedir(), '.stado', 'forwards', 'weles-admission.local');

function readBoundedRegularText(path, maximumBytes) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`Stado-published local document is unsafe: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

export function readPublicServiceIdentity() {
  const placement = JSON.parse(readBoundedRegularText(PUBLIC_PLACEMENT_POLICY_FILE, 64 * 1024));
  const placementGeneration = placement?._source?.registry_generation;
  if (placement?.schema_version !== 1
      || (typeof placementGeneration !== 'string'
        && !Number.isSafeInteger(placementGeneration))
      || String(placementGeneration).length === 0
      || placement?._source?.by !== 'stado host publish-placement-policy'
      || !Array.isArray(placement.hosts)) {
    throw new Error('Stado-published Weles placement policy has an unsupported identity');
  }
  const admittedHosts = placement.hosts.filter((host) => (
    host && typeof host === 'object'
      && host.enabled === true
      && typeof host.hostname === 'string'
      && Array.isArray(host.actions)
      && host.actions.includes('generic_browser_task')
  ));
  if (admittedHosts.length !== 1) {
    throw new Error('Stado-published Weles placement policy does not authorize one exact public host');
  }

  const published = JSON.parse(readBoundedRegularText(PUBLIC_SERVICE_DIRECTORY_FILE, 64 * 1024));
  const service = published?.service;
  if (published?.schema !== 'weles.public-service-directory.v1'
      || Object.keys(published).length !== 3
      || !Number.isSafeInteger(published?.directory_generation)
      || !service || typeof service !== 'object' || Array.isArray(service)
      || Object.keys(service).length !== 6
      || service.name !== 'weles-admission'
      || service.active_host !== admittedHosts[0].hostname
      || service.action !== 'generic_browser_task'
      || service.release_id !== `weles-worker@${RUN_RELEASE_IDENTITY.release_version}`
      || service.source_revision !== RUN_RELEASE_IDENTITY.source_revision
      || typeof service.endpoint !== 'string') {
    throw new Error('published Weles service-directory snapshot has an unsupported identity');
  }
  const publishedEndpoint = new URL(service.endpoint);
  if (!['http:', 'https:'].includes(publishedEndpoint.protocol)
      || publishedEndpoint.username || publishedEndpoint.password
      || publishedEndpoint.search || publishedEndpoint.hash
      || publishedEndpoint.pathname !== '/api/v1'
      || publishedEndpoint.toString() !== service.endpoint) {
    throw new Error('published Weles service-directory endpoint is invalid');
  }
  const transportText = readBoundedRegularText(PUBLIC_ADMISSION_ENDPOINT_FILE, 2 * 1024).trim();
  const transportEndpoint = new URL(transportText);
  if (transportEndpoint.toString() !== service.endpoint) {
    throw new Error('local Weles admission transport differs from the published service directory');
  }
  return {
    name: service.name,
    generation: published.directory_generation,
    consumer: 'spis',
    capability: 'browser-evidence',
    active_host: service.active_host,
    endpoint: service.endpoint,
    action: service.action,
    release_id: service.release_id,
    source_revision: service.source_revision,
  };
}

const PUBLIC_TASK_ENV_ALLOWLIST = Object.freeze([
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH',
  'SSL_CERT_DIR', 'SSL_CERT_FILE', 'STADO_BIN', 'STADO_MODEL_ROUTER_URL',
  'TMPDIR', 'WELES_CHROMIUM_DIR', 'WELES_CHROMIUM_RELEASE_SHA256',
  'WELES_CHROMIUM_RELEASE_VERSION', 'WELES_JEDEN_BIN', 'WELES_RECORDINGS_ROOT',
  'WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET', 'WELES_STADO_MODEL_ROUTER_AGENT_ID',
  'WELES_STADO_MODEL_ROUTER_TOKEN', 'XDG_CONFIG_HOME',
]);

export function publicTaskChildEnvironment(policy, networkTarget) {
  const environment = {};
  for (const name of PUBLIC_TASK_ENV_ALLOWLIST) {
    if (typeof process.env[name] === 'string' && process.env[name].length > 0) environment[name] = process.env[name];
  }
  return {
    ...environment,
    WELES_AGENT_MODEL: 'weles',
    WELES_BROWSER_EVIDENCE_POLICY: policy.version,
    WELES_BROWSER_EVIDENCE_POLICY_JSON: JSON.stringify(policy),
    WELES_BROWSER_EVIDENCE_TARGET_ORIGIN: networkTarget.origin,
    WELES_BROWSER_EVIDENCE_TARGET_HOST: networkTarget.hostname,
    WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON: JSON.stringify(networkTarget.addresses),
    WELES_DISABLE_RECORDING: '1',
    WELES_NO_INSTRUMENT: '1',
    GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY: '1',
  };
}
