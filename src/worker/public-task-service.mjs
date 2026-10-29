import { constants as http } from 'node:http2';
import { join } from 'node:path';

import {
  PublicTaskError,
  STATUS_SCHEMA,
  publicTaskErrorResponse,
} from './public-task-service/wire.mjs';
import {
  CANCELLATION_SCHEMA,
  PUBLIC_ACTION,
  TASK_SCHEMA,
  bearerAuthorized,
  createDeployedIdentity,
  loadConfig,
} from './public-task-service/admission.mjs';
import { declaredClientWindow } from './public-task-service/admission/client-window.mjs';
import {
  RECEIPT_SCHEMA,
  createEvidenceRetention,
} from './public-task-service/retention.mjs';
import { createTaskOperations } from './public-task-service/task.mjs';
import { createDispatcher } from './public-task-service/task/dispatch.mjs';
import { createTaskStore } from './public-task-service/task/store.mjs';

export { publicTaskErrorResponse };

const VERSION_SCHEMA = 'weles.version.v1';

// A promise's outcome as a value: the error stays whole for whoever reports it.
function settled(promise) {
  return promise.then(
    (value) => ({ failed: false, value }),
    (error) => ({ failed: true, error }),
  );
}

export function createPublicTaskService(options) {
  const config = loadConfig(options.environment, options.policy);
  const clientWindow = declaredClientWindow(options.environment);
  const taskRoot = join(options.runResultsRoot, 'public-tasks');
  const mappingRoot = join(taskRoot, 'idempotency');
  const identity = options.releaseIdentity;
  // An unreleased tree has no version; the readiness check refuses it
  // (admission/identity.mjs releaseVersion), so the id is not dressed up.
  const expectedReleaseId = `weles-worker@${identity.release_version}`;
  const causeOf = (error) =>
    options.redact(error instanceof Error ? error.message : String(error));

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
    get ready() {
      const state = dispatcher.dispatcherStatus();
      return (
        !state.draining &&
        !state.recovering &&
        state.healthy &&
        deployedIdentity.staticReady &&
        deployedIdentity.identityReady()
      );
    },
    get prerequisites() {
      return deployedIdentity.readinessStatus();
    },
    get serviceIdentity() {
      return deployedIdentity.lastServiceIdentity();
    },
    get dispatcher() {
      return dispatcher.dispatcherStatus();
    },
    basePath: '/api/v1',
    action: PUBLIC_ACTION,
    consumer: 'spis',
    capability: 'browser-evidence',
    releaseId: expectedReleaseId,
    releaseSha256: identity.release_sha256,
    sourceRevision: identity.source_revision,
    receiptKeyId: config.keyId,
    receiptKeySetVersion: config.keySetVersion,
    browserEvidencePolicy: config.policy.version,
    browserEvidencePolicyDigest: config.policyDigest,
  });

  async function handle(request, url, readBody) {
    if (request.method === 'GET' && url.pathname === '/api/v1/version') {
      const read = await settled(deployedIdentity.currentServiceIdentity());
      if (read.failed) {
        // The anonymous answer stays the fixed code (the cause can carry local
        // paths); the operator's log carries what actually failed, and the
        // authenticated /worker/status reports it as serviceIdentityFailure.
        console.error(
          `[weles-admission] /api/v1/version: deployed service identity: ${causeOf(read.error)}`,
        );
        return {
          status: http.HTTP_STATUS_SERVICE_UNAVAILABLE,
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
      const serviceIdentity = read.value;
      const admissionReady = health.ready;
      return {
        status: admissionReady
          ? http.HTTP_STATUS_OK
          : http.HTTP_STATUS_SERVICE_UNAVAILABLE,
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
          client: clientWindow,
          apiSchemas: [
            TASK_SCHEMA,
            CANCELLATION_SCHEMA,
            STATUS_SCHEMA,
            RECEIPT_SCHEMA,
            VERSION_SCHEMA,
          ],
          publicTask: { ...health, serviceIdentity, ready: admissionReady },
        },
      };
    }

    const taskMatch = /^\/api\/v1\/tasks\/([\da-f-]+)$/.exec(url.pathname);
    const cancelMatch = /^\/api\/v1\/tasks\/([\da-f-]+)\/cancel$/.exec(
      url.pathname,
    );
    const isSubmit =
      request.method === 'POST' && url.pathname === '/api/v1/tasks';
    const isGet = request.method === 'GET' && Boolean(taskMatch);
    const isCancel = request.method === 'POST' && Boolean(cancelMatch);
    if (!isSubmit && !isGet && !isCancel) return null;
    const stated = request.headers['content-type'];
    const mediaType =
      stated === undefined ? null : stated.split(';')[0].trim().toLowerCase();
    if ((isSubmit || isCancel) && mediaType !== 'application/json') {
      throw new PublicTaskError(
        http.HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
        'unsupported-media-type',
        mediaType === null
          ? 'public task bodies require Content-Type: application/json; the request sent no Content-Type'
          : `public task bodies require Content-Type: application/json; the request sent ${mediaType}`,
      );
    }
    if (!bearerAuthorized(request, config.bearer)) {
      throw new PublicTaskError(
        http.HTTP_STATUS_UNAUTHORIZED,
        'unauthorized',
        'unauthorized',
      );
    }
    if (isSubmit && dispatcher.dispatcherStatus().recovering) {
      throw new PublicTaskError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'worker-recovering',
        'task admission is paused while the worker recovers its durable state',
      );
    }
    if (isSubmit) return operations.submit(request, await readBody(request));
    if (isGet) {
      const [, taskId] = taskMatch;
      const wait = url.searchParams.get('wait');
      if (wait === null) return operations.getTask(taskId);
      if (wait !== 'terminal') {
        throw new PublicTaskError(
          http.HTTP_STATUS_BAD_REQUEST,
          'invalid-wait',
          'wait accepts only "terminal"',
        );
      }
      return operations.awaitTask(taskId);
    }
    const [, cancelId] = cancelMatch;
    return operations.cancel(request, cancelId, await readBody(request));
  }

  async function restartWorker() {
    if (!dispatcher.beginRecovery()) {
      return {
        ok: false,
        error: 'worker_busy',
        dispatcher: dispatcher.dispatcherStatus(),
      };
    }
    const recovery = await settled(operations.recover());
    if (recovery.failed) {
      await dispatcher.finishRecovery(recovery.error);
      return {
        ok: false,
        error: 'worker_recovery_failed',
        detail: causeOf(recovery.error),
        dispatcher: dispatcher.dispatcherStatus(),
      };
    }
    await dispatcher.finishRecovery();
    const state = dispatcher.dispatcherStatus();
    return {
      ok: state.healthy && !state.draining,
      ...(state.healthy && !state.draining
        ? {}
        : { error: 'worker_not_running_after_control_action' }),
      dispatcher: state,
    };
  }

  /** Stop starting queued tasks; running ones finish. Idempotent. */
  function stopWorker() {
    dispatcher.pause();
    return { ok: true, dispatcher: dispatcher.dispatcherStatus() };
  }

  /** Start a stopped dispatcher again on the queue it kept. */
  async function resumeWorker() {
    await dispatcher.resume();
    const state = dispatcher.dispatcherStatus();
    return {
      ok: state.healthy && !state.draining && !state.paused,
      ...(state.healthy && !state.draining && !state.paused
        ? {}
        : { error: 'worker_not_running_after_control_action' }),
      dispatcher: state,
    };
  }

  return Object.freeze({
    health,
    get serviceIdentityFailure() {
      const failure = deployedIdentity.serviceIdentityFailure();
      return failure === null
        ? null
        : { ...failure, message: options.redact(failure.message) };
    },
    handle,
    recover: operations.recover,
    shutdown: dispatcher.shutdown,
    restartWorker,
    stopWorker,
    resumeWorker,
  });
}
