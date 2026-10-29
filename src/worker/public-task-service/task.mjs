import { randomUUID } from 'node:crypto';
import { constants as http } from 'node:http2';

import { PublicTaskError, TERMINAL_STATUSES, publicStatus } from './wire.mjs';
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
      throw new PublicTaskError(
        http.HTTP_STATUS_CONFLICT,
        'idempotency-conflict',
        'Idempotency-Key is already bound to a different request',
      );
    return materializeReservation(reservation);
  }

  /** The deployed service identity, refused publicly with the cause logged. */
  async function serviceIdentityFor(parsed) {
    let serviceIdentity;
    try {
      serviceIdentity = await currentServiceIdentity();
    } catch (error) {
      // The public answer stays fixed; the service log carries the cause.
      console.error(
        `[public-task] service identity unavailable: ${failure(error)}`,
      );
      throw new PublicTaskError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'service-not-ready',
        'deployed service identity is unavailable or mismatched',
      );
    }
    if (
      canonicalJson(parsed.spisBinding.service) !==
      canonicalJson(bindingServiceIdentity(serviceIdentity))
    )
      throw new PublicTaskError(
        http.HTTP_STATUS_FORBIDDEN,
        'service-identity-mismatch',
        'spisBinding.service does not match the deployed Weles service identity',
      );
    return serviceIdentity;
  }

  /** The network target the URL resolves to, refused publicly with the cause logged. */
  async function networkTargetFor(url) {
    try {
      return await resolveTarget(url);
    } catch (error) {
      console.error(`[public-task] target refused: ${failure(error)}`);
      throw new PublicTaskError(
        http.HTTP_STATUS_FORBIDDEN,
        'network-target-denied',
        'target did not resolve exclusively to stable public addresses',
      );
    }
  }

  async function submit(request, body) {
    if (!staticReady)
      throw new PublicTaskError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'service-not-ready',
        'public task prerequisites are not ready',
      );
    if (dispatcher.draining())
      throw new PublicTaskError(
        http.HTTP_STATUS_SERVICE_UNAVAILABLE,
        'service-draining',
        'service is draining',
      );
    const key = idempotencyKey(request);
    const parsed = parseTaskRequest(body, config);
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
    if (!(await createReservation(key, task))) {
      const raced = await existingSubmission(key, parsed.requestDigest);
      if (!raced)
        throw new Error(
          'idempotency reservation disappeared after a concurrent claim',
        );
      return answer(http.HTTP_STATUS_OK, raced);
    }
    await persistTask(task);
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
    const key = idempotencyKey(request);
    const cancellation = parseCancellation(body, config);
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
        throw new PublicTaskError(
          http.HTTP_STATUS_CONFLICT,
          'cancellation-conflict',
          'task already has a different cancellation operation',
        );
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
