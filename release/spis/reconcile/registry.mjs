// The registry mode: reconcile the candidate service directory entry for
// this host against the current registry, refusing anything that does not
// name the exact release and source the operator is activating.
import { arrayAt, objectAt, readJson, writeJson } from './documents.mjs';

export function reconcileRegistry(source, destination, expectedHost, version, sourceRevision) {
  const registry = objectAt(readJson(source), 'registry');
  const directory = objectAt(registry.service_directory, 'service_directory');
  if (!Number.isSafeInteger(directory.generation) || directory.generation < 0) {
    throw new Error('service_directory.generation must be a non-negative safe integer');
  }
  const services = objectAt(directory.services, 'service_directory.services');
  const service = objectAt(services['weles-admission'], 'weles-admission service');
  if (service.active_host !== expectedHost) throw new Error(`weles-admission active_host is not ${expectedHost}`);
  const endpoints = objectAt(service.endpoints, 'weles-admission.endpoints');
  const endpoint = objectAt(endpoints[service.active_host], `weles-admission endpoint ${service.active_host}`);
  if (typeof endpoint.url !== 'string') throw new Error('weles-admission endpoint has no URL');
  const endpointUrl = new URL(endpoint.url);
  if (!['http:', 'https:'].includes(endpointUrl.protocol)
      || endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash
      || !['', '/', '/api/v1'].includes(endpointUrl.pathname)) {
    throw new Error('weles-admission endpoint must be an HTTP origin or end exactly in /api/v1');
  }

  let changed = false;
  if (endpoint.url !== endpointUrl.origin) {
    endpoint.url = endpointUrl.origin;
    changed = true;
  }
  if (endpoint.base_path !== '/api/v1') {
    endpoint.base_path = '/api/v1';
    changed = true;
  }
  const releaseId = `weles-worker@${version}`;
  if (endpoint.release_id !== releaseId) {
    endpoint.release_id = releaseId;
    changed = true;
  }
  if (endpoint.source_revision !== sourceRevision) {
    endpoint.source_revision = sourceRevision;
    changed = true;
  }
  for (const obsolete of ['release_id', 'source_revision']) {
    if (Object.hasOwn(service, obsolete)) {
      delete service[obsolete];
      changed = true;
    }
  }
  if (!service.consumers) {
    service.consumers = {};
    changed = true;
  }
  const consumers = objectAt(service.consumers, 'weles-admission.consumers');
  if (!consumers.spis) {
    consumers.spis = { capabilities: [] };
    changed = true;
  }
  const spis = objectAt(consumers.spis, 'weles-admission.consumers.spis');
  if (!spis.capabilities) {
    spis.capabilities = [];
    changed = true;
  }
  const capabilities = arrayAt(spis.capabilities, 'spis capabilities');
  if (capabilities.some((entry) => typeof entry !== 'string')) throw new Error('spis capabilities must contain strings');
  if (!capabilities.includes('browser-evidence')) {
    capabilities.push('browser-evidence');
    capabilities.sort();
    changed = true;
  }

  const targets = arrayAt(registry.targets, 'targets');
  const target = targets.find((entry) => entry?.name === service.active_host);
  if (!target) throw new Error(`active Weles target ${service.active_host} is absent`);
  const weles = objectAt(target.weles, `${service.active_host}.weles`);
  const actions = arrayAt(weles.actions, `${service.active_host}.weles.actions`);
  if (actions.some((entry) => typeof entry !== 'string')) throw new Error('Weles actions must contain strings');
  if (!actions.includes('generic_browser_task')) {
    actions.push('generic_browser_task');
    actions.sort();
    changed = true;
  }

  if (changed) directory.generation += 1;
  writeJson(destination, registry);
  process.stdout.write(`${JSON.stringify({
    changed,
    generation: directory.generation,
    activeHost: service.active_host,
    endpoint: `${endpoint.url}${endpoint.base_path}`,
  })}\n`);
}

