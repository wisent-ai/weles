import { join } from 'node:path';

import { PublicTaskError, STATUS_SCHEMA, publicTaskErrorResponse } from './public-task-service/wire.mjs';
import {
  CANCELLATION_SCHEMA,
  PUBLIC_ACTION,
  TASK_SCHEMA,
  bearerAuthorized,
  createDeployedIdentity,
  loadConfig,
} from './public-task-service/admission.mjs';
import { RECEIPT_SCHEMA, createEvidenceRetention } from './public-task-service/retention.mjs';
import { createTaskOperations } from './public-task-service/task.mjs';
import { createDispatcher } from './public-task-service/task/dispatch.mjs';
import { createTaskStore } from './public-task-service/task/store.mjs';

export { publicTaskErrorResponse };

const VERSION_SCHEMA = 'weles.version.v1';

export function createPublicTaskService(options) {
  const config = loadConfig(options.environment ?? process.env, options.policy);
  const taskRoot = join(options.runResultsRoot, 'public-tasks');
  const mappingRoot = join(taskRoot, 'idempotency');
  const identity = options.releaseIdentity;
  const expectedReleaseId = `weles-worker@${identity.release_version ?? ''}`;
  if (options.concurrency !== 1) {
    throw new Error('public task concurrency must be exactly 1');
  }
  if (!Number.isSafeInteger(options.taskTimeoutMs)
      || options.taskTimeoutMs < 15 * 60 * 1_000
      || options.taskTimeoutMs > 6 * 60 * 60 * 1_000) {
    throw new Error('public task timeout must be between 15 minutes and 6 hours');
  }

  const deployedIdentity = createDeployedIdentity({
    identity,
    expectedReleaseId,
    trajectoryReady: options.trajectoryReady,
    artifactRetentionReady: options.artifactRetentionReady,
    readServiceIdentity: options.readServiceIdentity,
  });
  const store = createTaskStore({
    runResultsRoot: options.runResultsRoot,
    taskRoot,
    mappingRoot,
    organizationId: config.organizationId,
  });
  const { retainCompletion } = createEvidenceRetention({
    config,
    recordingsRoot: options.recordingsRoot,
    persistTask: store.persistTask,
    uploadArtifacts: options.uploadArtifacts,
    readArtifactIdentity: options.readArtifactIdentity,
  });
  const dispatcher = createDispatcher({
    concurrency: options.concurrency,
    taskTimeoutMs: options.taskTimeoutMs,
    redact: options.redact,
    config,
    store,
    retainCompletion,
    runTrajectory: options.runTrajectory,
  });
  const operations = createTaskOperations({
    config,
    redact: options.redact,
    taskRoot,
    mappingRoot,
    deployedIdentity,
    store,
    dispatcher,
    retainCompletion,
    resolveTarget: options.resolveTarget,
  });

  const health = Object.freeze({
    get ready() { return deployedIdentity.staticReady && deployedIdentity.identityReady(); },
    get prerequisites() { return deployedIdentity.readinessStatus(); },
    get serviceIdentity() { return deployedIdentity.lastServiceIdentity(); },
    get dispatcher() { return dispatcher.dispatcherStatus(); },
    basePath: '/api/v1',
    action: PUBLIC_ACTION,
    consumer: 'spis',
    capability: 'browser-evidence',
    releaseId: expectedReleaseId,
    releaseSha256: identity.release_sha256,
    sourceRevision: identity.source_revision,
    taskTimeoutMs: options.taskTimeoutMs,
    receiptKeyId: config.keyId,
    receiptKeySetVersion: config.keySetVersion,
    browserEvidencePolicy: config.policy.version,
    browserEvidencePolicyDigest: config.policyDigest,
  });

  async function handle(request, url, readBody) {
    if (request.method === 'GET' && url.pathname === '/api/v1/version') {
      let serviceIdentity;
      try { serviceIdentity = await deployedIdentity.currentServiceIdentity(); } catch {
        return {
          status: 503,
          payload: {
            schema: VERSION_SCHEMA,
            service: 'weles-admission',
            ready: false,
            releaseId: expectedReleaseId,
            sourceRevision: identity.source_revision,
            deploymentManifestSha256: identity.release_sha256,
            error: 'deployed-service-identity-mismatch',
          },
        };
      }
      const admissionReady = deployedIdentity.staticReady && deployedIdentity.identityReady();
      return {
        status: admissionReady ? 200 : 503,
        payload: {
          schema: VERSION_SCHEMA,
          service: 'weles-admission',
          release: identity.release_version,
          releaseId: expectedReleaseId,
          sourceRevision: identity.source_revision,
          deploymentManifestSha256: identity.release_sha256,
          serviceIdentity,
          ready: admissionReady,
          prerequisites: deployedIdentity.readinessStatus(),
          dispatcher: dispatcher.dispatcherStatus(),
          taskTimeoutMs: options.taskTimeoutMs,
          client: { currentVersion: '0.1.0', minimumVersion: '0.1.0', supportedGenerations: 2 },
          apiSchemas: [TASK_SCHEMA, CANCELLATION_SCHEMA, STATUS_SCHEMA, RECEIPT_SCHEMA, VERSION_SCHEMA],
          publicTask: { ...health, serviceIdentity, ready: admissionReady },
        },
      };
    }

    const taskMatch = /^\/api\/v1\/tasks\/([0-9a-f-]+)$/.exec(url.pathname);
    const cancelMatch = /^\/api\/v1\/tasks\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
    const isSubmit = request.method === 'POST' && url.pathname === '/api/v1/tasks';
    const isGet = request.method === 'GET' && Boolean(taskMatch);
    const isCancel = request.method === 'POST' && Boolean(cancelMatch);
    if (!isSubmit && !isGet && !isCancel) return null;
    if ((isSubmit || isCancel)
        && String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      throw new PublicTaskError(415, 'unsupported-media-type', 'public task bodies require Content-Type: application/json');
    }
    if (!bearerAuthorized(request, config.bearer)) {
      throw new PublicTaskError(401, 'unauthorized', 'unauthorized');
    }
    if (isSubmit) return operations.submit(request, await readBody(request));
    if (isGet) return operations.getTask(taskMatch[1]);
    return operations.cancel(request, cancelMatch[1], await readBody(request));
  }

  return Object.freeze({
    health,
    handle,
    recover: operations.recover,
    shutdown: dispatcher.shutdown,
  });
}
