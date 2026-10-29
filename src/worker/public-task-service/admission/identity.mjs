// The deployed identity a public task is admitted against: the release this
// process runs, the service identity Stado publishes for it, and the last
// failure reading that identity, kept for authenticated worker status. The
// Spis binding a task carries is parsed in ./spis-binding.mjs.
import { isObject } from '../wire/canonical-json.mjs';
import { PUBLIC_ACTION } from './deployment.mjs';

export function createDeployedIdentity({
  identity,
  expectedReleaseId,
  trajectoryReady,
  artifactRetentionReady,
  readServiceIdentity,
}) {
  function validatedServiceIdentity(value) {
    if (
      !isObject(value) ||
      Object.keys(value).length !== 9 ||
      value.name !== 'weles-admission' ||
      value.consumer !== 'spis' ||
      value.capability !== 'browser-evidence' ||
      value.action !== PUBLIC_ACTION ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      typeof value.active_host !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(value.active_host) ||
      typeof value.endpoint !== 'string' ||
      value.release_id !== expectedReleaseId ||
      value.source_revision !== identity.source_revision
    ) {
      throw new Error(
        'deployed public service identity does not match the immutable Weles release',
      );
    }
    const endpoint = new URL(value.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/api/v1' ||
      endpoint.toString() !== value.endpoint
    ) {
      throw new Error('deployed public service endpoint is invalid');
    }
    return {
      name: value.name,
      generation: value.generation,
      consumer: value.consumer,
      capability: value.capability,
      active_host: value.active_host,
      endpoint: value.endpoint,
      action: value.action,
      release_id: value.release_id,
      source_revision: value.source_revision,
    };
  }

  const staticReadiness = Object.freeze({
    releaseVersion:
      typeof identity.release_version === 'string' &&
      /^\d+\.\d+\.\d+$/.test(identity.release_version),
    releaseDigest:
      typeof identity.release_sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(identity.release_sha256),
    sourceRevision:
      typeof identity.source_revision === 'string' &&
      /^[0-9a-f]{40}$/.test(identity.source_revision),
    trajectory: trajectoryReady === true,
    artifactRetention: artifactRetentionReady === true,
  });
  const staticReady = Object.values(staticReadiness).every(Boolean);
  let identityReady = false;
  let lastServiceIdentity = null;
  let serviceIdentityFailure = null;
  const readinessStatus = () => ({
    ...staticReadiness,
    serviceIdentity: identityReady,
  });

  function bindingServiceIdentity(serviceIdentity) {
    return {
      name: serviceIdentity.name,
      consumer: serviceIdentity.consumer,
      capability: serviceIdentity.capability,
      directory_generation: serviceIdentity.generation,
      host: serviceIdentity.active_host,
      endpoint: serviceIdentity.endpoint,
      action: serviceIdentity.action,
      release_id: serviceIdentity.release_id,
      source_revision: serviceIdentity.source_revision,
    };
  }

  // A read that did not yield the exact deployed identity leaves no identity
  // behind: readiness drops and the retained copy is discarded before the
  // error travels on to the caller. Kept out of the catch clause below so the
  // clause holds nothing but the propagation.
  function forgetServiceIdentity() {
    identityReady = false;
    lastServiceIdentity = null;
  }

  async function currentServiceIdentity() {
    let operation = 'read-deployed-service-identity';
    try {
      const observed = await readServiceIdentity();
      operation = 'validate-deployed-service-identity';
      lastServiceIdentity = validatedServiceIdentity(observed);
      identityReady = true;
      serviceIdentityFailure = null;
      return lastServiceIdentity;
    } catch (error) {
      forgetServiceIdentity();
      serviceIdentityFailure = {
        operation,
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  // The named answer to "is the deployed identity readable right now": either
  // the exact identity, or a refusal carrying the sentence that explains it.
  // `/api/v1/version` publishes the same state as `ready: false` with
  // `deployed-service-identity-mismatch`, so a caller that must keep going
  // branches on `ok` and says why instead of holding an unreadable identity.
  async function serviceIdentityReadiness() {
    try {
      return { ok: true, serviceIdentity: await currentServiceIdentity() };
    } catch (error) {
      return {
        ok: false,
        reason: `deployed service identity is unreadable: ${error.message}`,
      };
    }
  }

  return Object.freeze({
    staticReady,
    readinessStatus,
    identityReady: () => identityReady,
    lastServiceIdentity: () => lastServiceIdentity,
    serviceIdentityFailure: () => serviceIdentityFailure,
    bindingServiceIdentity,
    currentServiceIdentity,
    serviceIdentityReadiness,
  });
}
