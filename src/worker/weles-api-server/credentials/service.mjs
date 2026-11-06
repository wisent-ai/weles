import { constants as http } from 'node:http2';
import {
  readRequest,
  validateRequest,
} from '@wisent-ai/weles-client/credential/input';
import {
  credentialResponse,
  credentialFailure,
} from '@wisent-ai/weles-client/credential/response';
import {
  createCredentialAuthority,
  CredentialAdmissionError,
} from './authority.mjs';
import {
  advance,
  createCredentialStore,
  requestIdentity,
  unfinished,
} from './store.mjs';
import { finishedCredentialReply } from './outcome.mjs';
import { admittedAcquisition, refusalResponse } from './admission.mjs';

const PATH = '/api/v1/credential-operations';

export function createCredentialOperationService({
  acquireSecret,
  definitionFor,
  resolvedAcquiredSecretContract,
  checkedTokenFile,
  skarbiecEndpoint,
  runResultsRoot,
  releaseIdentity,
  runTrajectory,
}) {
  const authorize = createCredentialAuthority({
    checkedTokenFile,
    skarbiecEndpoint,
  });
  const store = createCredentialStore(runResultsRoot);
  const running = new Map();
  let stopping = false;

  function settleFailure(record, code, message) {
    record.reply = credentialFailure(
      record.request,
      code,
      message,
      record.startedAt ? 'unknown' : 'none',
    );
    record.reply.actionLogId = `credential-${record.request.request_id}`;
    advance(record, 'finished');
    record.finishedAt = new Date().toISOString();
    store.save(record);
  }

  function start(record, task) {
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(async () => {
        try {
          if (stopping) {
            settleFailure(
              record,
              'WELES_CREDENTIAL_NOT_STARTED',
              'Weles stopped before starting the credential operation',
            );
            return;
          }
          advance(record, 'running');
          record.startedAt = new Date().toISOString();
          store.save(record);
          const out = await runTrajectory({
            ...task,
            runId: record.reply.actionLogId,
            signal: controller.signal,
          });
          record.reply = finishedCredentialReply(record, task.action, out);
          advance(record, 'finished');
          record.finishedAt = new Date().toISOString();
          store.save(record);
        } catch (error) {
          settleFailure(
            record,
            'WELES_CREDENTIAL_EXECUTION_FAILED',
            error.message,
          );
        }
      })
      .catch((error) => {
        console.error(
          JSON.stringify({
            code: 'WELES_CREDENTIAL_RESULT_PERSIST_FAILED',
            requestId: record.request.request_id,
            message: credentialFailure(
              record.request,
              'WELES_CREDENTIAL_RESULT_PERSIST_FAILED',
              error.message,
            ).message,
          }),
        );
      })
      .finally(() => running.delete(record.request.request_id));
    running.set(record.request.request_id, { controller, promise });
  }

  // A queued or running operation with no executor here was interrupted; one
  // still admitting is answered by the call admitting it.
  const EXECUTING = new Set(['queued', 'running']);

  function reconcileExecutor(record) {
    if (
      EXECUTING.has(record.phase) &&
      !running.has(record.request.request_id)
    ) {
      settleFailure(
        record,
        'WELES_CREDENTIAL_EXECUTION_INTERRUPTED',
        'Weles has no executor for this unfinished credential operation; it was not replayed',
      );
    }
  }

  async function submit(request, consumer) {
    const previous = store.load(request.request_id);
    if (previous) {
      store.check(previous, request, consumer);
      reconcileExecutor(previous);
      return previous.reply;
    }
    if (stopping)
      throw new CredentialAdmissionError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'WELES_CREDENTIAL_STOPPING',
        'Weles is draining credential operations',
      );
    const acquisition = admittedAcquisition(request, {
      definitionFor,
      resolvedAcquiredSecretContract,
    });
    const actionLogId = `credential-${request.request_id}`;
    const record = {
      schema: 'weles.credential-admission.v1',
      request,
      consumer,
      fingerprint: requestIdentity(request),
      releaseIdentity,
      phase: 'admitting',
      startedAt: null,
      finishedAt: null,
      reply: {
        status: 'operation_queued',
        operation: request.operation,
        provider: request.provider,
        vaultItemId: request.credential_id,
        actionLogId,
        providerEffect: 'none',
        message: 'Weles is admitting the exact credential operation',
      },
    };
    if (!request.dry_run) store.save(record);
    let task;
    try {
      const result = await acquireSecret(
        acquisition,
        (action, accountId, params) => {
          if (task)
            throw new Error(
              'one credential operation cannot enqueue multiple trajectories',
            );
          task = { action, accountId, params };
          return actionLogId;
        },
      );
      record.reply = credentialResponse(
        {
          operation: request.operation,
          provider: request.provider,
          vaultItemId: request.credential_id,
          actionLogId,
          ...result,
        },
        request,
      );
      if (request.dry_run) return record.reply;
      if (record.reply.status === 'operation_queued') {
        if (!task)
          throw new Error(
            'credential acquisition queued no executable trajectory',
          );
        advance(record, 'queued');
        store.save(record);
        start(record, task);
      } else {
        advance(record, 'finished');
        record.finishedAt = new Date().toISOString();
        store.save(record);
      }
      return record.reply;
    } catch (error) {
      if (request.dry_run) throw error;
      settleFailure(record, 'WELES_CREDENTIAL_ADMISSION_FAILED', error.message);
      return record.reply;
    }
  }

  return {
    recover() {
      for (const record of store.records()) {
        if (unfinished(record.phase)) {
          settleFailure(
            record,
            'WELES_CREDENTIAL_EXECUTION_INTERRUPTED',
            'Weles restarted before recording a final credential result; the operation was not replayed',
          );
        }
      }
    },
    async handle(req, url) {
      if (url.pathname !== PATH) return null;
      if (req.method !== 'POST')
        return {
          status: http.HTTP_STATUS_METHOD_NOT_ALLOWED,
          payload: { code: 'WELES_CREDENTIAL_METHOD_REFUSED' },
        };
      let request;
      let parsed = false;
      let validated = false;
      try {
        const consumer = await authorize(req);
        request = await readRequest(req);
        parsed = true;
        validateRequest(request);
        validated = true;
        if (request.mode === 'resume') {
          throw new CredentialAdmissionError(
            http.HTTP_STATUS_CONFLICT,
            'WELES_CREDENTIAL_MODE_REFUSED',
            'self-hosted credential admission accepts submit and status, not resume',
          );
        }
        if (request.mode === 'status') {
          const record = store.load(request.request_id);
          if (!record)
            throw new CredentialAdmissionError(
              http.HTTP_STATUS_NOT_FOUND,
              'WELES_CREDENTIAL_REQUEST_NOT_FOUND',
              'credential request was not admitted here',
            );
          store.check(record, request, consumer);
          reconcileExecutor(record);
          return { status: http.HTTP_STATUS_OK, payload: record.reply };
        }
        return {
          status: http.HTTP_STATUS_OK,
          payload: await submit(request, consumer),
        };
      } catch (error) {
        return refusalResponse(error, request, { parsed, validated });
      }
    },
    async shutdown() {
      stopping = true;
      const entries = [...running.values()];
      for (const entry of entries) entry.controller.abort();
      await Promise.allSettled(entries.map((entry) => entry.promise));
    },
  };
}
