import { randomUUID } from 'node:crypto';
import { constants as http } from 'node:http2';
import { dirname } from 'node:path';

import { DeclaredError } from '../../errors/index.cjs';
import { causes } from '../../errors/operations/admission.cjs';
import { TERMINAL_STATUSES, publicStatus } from './wire.mjs';
import { canonicalJson } from './wire/canonical-json.mjs';
import {
  idempotencyKey,
  parseCancellation,
  parseTaskRequest,
} from './admission.mjs';
import { terminalCompletion } from './task/completion.mjs';
import { createRecovery } from './task/recover.mjs';

/** The message of a failure, whatever was thrown. */
function failure(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createTaskOperations({
  config,
  redact,
  taskRoot,
  mappingRoot,
  deployedIdentity,
  store,
  dispatcher,
  retainCompletion,
  resolveTarget,
}) {
  const {
    loadTask,
    persistTask,
    withTaskLock,
    materializeReservation,
    readReservation,
    createReservation,
  } = store;
  const { active, dispatcherStatus, enqueue, removeQueued } = dispatcher;
  const { staticReady, currentServiceIdentity, bindingServiceIdentity } =
    deployedIdentity;

  /** The task's public answer with `status`. */
  function answer(status, task) {
    return { status, payload: publicStatus(task, dispatcherStatus(), redact) };
  }

  /** A terminal task answers OK; one still settling answers Accepted. */
  function settledAnswer(task) {
    return answer(
      Object.hasOwn(TERMINAL_STATUSES, task.status)
        ? http.HTTP_STATUS_OK
        : http.HTTP_STATUS_ACCEPTED,
      task,
    );
  }

  async function existingSubmission(key, requestDigest) {
    const reservation = await readReservation(key);
    if (!reservation) return null;
    if (reservation.requestDigest !== requestDigest)
      throw new DeclaredError(causes.IDEMPOTENCY_CONFLICT, {
        key,
        bound: reservation.requestDigest,
        digest: requestDigest,
      });
    return materializeReservation(reservation);
  }

  /** The deployed service identity, refused publicly with the cause logged. */
  async function serviceIdentityFor(parsed) {
    let serviceIdentity;
    try {
      serviceIdentity = await currentServiceIdentity();
    } catch (error) {
      // The caller holds the admission bearer, so it is told what failed
      // with the paths redacted the way every answer is.
      throw new DeclaredError(
        causes.IDENTITY_UNREADABLE,
        { answer: redact(failure(error)) },
        { cause: error },
      );
    }
    const deployed = bindingServiceIdentity(serviceIdentity);
    if (canonicalJson(parsed.spisBinding.service) !== canonicalJson(deployed))
      throw new DeclaredError(causes.IDENTITY_MISMATCH, {
        bound: canonicalJson(parsed.spisBinding.service),
        deployed: canonicalJson(deployed),
      });
    return serviceIdentity;
  }

  /**
   * The network target the URL resolves to, or the declared cause: a host
   * with no DNS answer, a host on an address that is not public, or address
   * registries that could not be read to judge it.
   */
  async function networkTargetFor(url) {
    const host = new URL(url).hostname;
    try {
      return await resolveTarget(url);
    } catch (error) {
      const answer = failure(error);
      let cause = causes.TARGET_REGISTRY;
      if (/^non-public network address denied/.test(answer))
        cause = causes.TARGET_NOT_PUBLIC;
      else if (
        ['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ESERVFAIL'].includes(
          error?.code,
        ) ||
        /^network hostname has no addresses/.test(answer)
      )
        cause = causes.TARGET_UNRESOLVED;
      throw new DeclaredError(cause, { host, answer }, { cause: error });
    }
  }

  /** `write`, or the declared cause when the task state cannot be written. */
  async function recorded(write) {
    try {
      return await write();
    } catch (error) {
      if (error instanceof DeclaredError) throw error;
      throw new DeclaredError(
        causes.STATE_UNWRITABLE,
        { root: dirname(mappingRoot), answer: redact(failure(error)) },
        { cause: error },
      );
    }
  }

  async function submit(request, body) {
    if (!staticReady)
      throw new DeclaredError(causes.NOT_READY, {
        prerequisites: JSON.stringify(deployedIdentity.readinessStatus()),
      });
    if (dispatcher.draining()) throw new DeclaredError(causes.DRAINING);
    const key = idempotencyKey(request, '/api/v1/tasks');
    const parsed = parseTaskRequest(await body(), config);
    await existingSubmission(key, parsed.requestDigest);
    const serviceIdentity = await serviceIdentityFor(parsed);
    const networkTarget = await networkTargetFor(parsed.executionInput.url);
    const now = new Date().toISOString();
    const task = {
      schema: 'weles.public-task-record.v1',
      id: randomUUID(),
      requestDigest: parsed.requestDigest,
      request: parsed.request,
      spisBinding: parsed.spisBinding,
      serviceIdentity,
      executionInput: parsed.executionInput,
      networkTarget,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      result: null,
      resultDigest: null,
      error: null,
      receipt: null,
      cancellation: null,
    };
    if (!(await recorded(() => createReservation(key, task)))) {
      const raced = await existingSubmission(key, parsed.requestDigest);
      if (!raced)
        throw new Error(
          `the Idempotency-Key reservation another request created for this key disappeared under ${mappingRoot} before it could be read: something other than this worker removed it`,
        );
      return answer(http.HTTP_STATUS_OK, raced);
    }
    await recorded(() => persistTask(task));
    await enqueue(task.id);
    return answer(http.HTTP_STATUS_ACCEPTED, await loadTask(task.id));
  }

  async function getTask(taskId) {
    return withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (task.completion && !task.receipt) await retainCompletion(task);
      return answer(http.HTTP_STATUS_OK, task);
    });
  }

  /** The task's status once it is terminal: the response is held until then. */
  async function awaitTask(taskId) {
    await store.awaitTerminal(taskId);
    return getTask(taskId);
  }

  async function cancel(request, taskId, body) {
    const key = idempotencyKey(request, `/api/v1/tasks/${taskId}/cancel`);
    const cancellation = parseCancellation(await body(), config);
    let controller = null;
    const response = await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (Object.hasOwn(TERMINAL_STATUSES, task.status))
        return answer(http.HTTP_STATUS_OK, task);
      if (
        task.cancellation &&
        (task.cancellation.idempotencyKey !== key ||
          task.cancellation.reason !== cancellation.reason)
      )
        throw new DeclaredError(causes.CANCELLATION_CONFLICT, {
          task_id: taskId,
          recorded_key: task.cancellation.idempotencyKey,
          recorded_reason: JSON.stringify(task.cancellation.reason),
        });
      if (!task.cancellation)
        task.cancellation = {
          idempotencyKey: key,
          reason: cancellation.reason,
          requestedAt: new Date().toISOString(),
        };
      const running = active.get(task.id);
      if (running) {
        controller = running.controller;
        await persistTask(task);
        return answer(http.HTTP_STATUS_ACCEPTED, task);
      }
      removeQueued(task.id);
      task.completion = {
        ...terminalCompletion(null, true, redact, task.executionInput.url),
        completedAt: new Date().toISOString(),
      };
      await persistTask(task);
      await retainCompletion(task);
      return settledAnswer(task);
    });
    if (controller) controller.abort();
    return response;
  }

  const recover = createRecovery({
    store,
    dispatcher,
    deployedIdentity,
    taskRoot,
    mappingRoot,
    redact,
    retainCompletion,
  });

  return Object.freeze({ submit, getTask, awaitTask, cancel, recover });
}
