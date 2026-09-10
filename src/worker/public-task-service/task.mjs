import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PublicTaskError, TERMINAL_STATUSES, publicStatus } from './wire.mjs';
import { UUID_RE, canonicalJson } from './wire/canonical-json.mjs';
import { idempotencyKey, parseCancellation, parseTaskRequest } from './admission.mjs';
import { cleanInterruptedTemporaryFiles, readJson } from './durable-write.mjs';
import { terminalCompletion } from './task/dispatch.mjs';

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
    ensureRoots,
    loadTask,
    persistTask,
    withTaskLock,
    validateReservation,
    materializeReservation,
    readReservation,
    createReservation,
  } = store;
  const { active, queue, queued, dispatcherStatus, enqueue, removeQueued, dispatchQueue } = dispatcher;
  const { staticReady, currentServiceIdentity, bindingServiceIdentity, serviceIdentityReadiness } = deployedIdentity;

  async function existingSubmission(key, requestDigest) {
    const reservation = await readReservation(key);
    if (!reservation) return null;
    if (reservation.requestDigest !== requestDigest) {
      throw new PublicTaskError(409, 'idempotency-conflict', 'Idempotency-Key is already bound to a different request');
    }
    return materializeReservation(reservation);
  }

  async function submit(request, body) {
    if (!staticReady) throw new PublicTaskError(503, 'service-not-ready', 'public task prerequisites are not ready');
    if (dispatcher.draining()) throw new PublicTaskError(503, 'service-draining', 'service is draining');
    const key = idempotencyKey(request);
    const parsed = parseTaskRequest(body, config);
    const existing = await existingSubmission(key, parsed.requestDigest);
    let serviceIdentity;
    try {
      serviceIdentity = await currentServiceIdentity();
    } catch {
      throw new PublicTaskError(503, 'service-not-ready', 'deployed service identity is unavailable or mismatched');
    }
    if (canonicalJson(parsed.spisBinding.service) !== canonicalJson(bindingServiceIdentity(serviceIdentity))) {
      throw new PublicTaskError(403, 'service-identity-mismatch', 'spisBinding.service does not match the deployed Weles service identity');
    }
    let networkTarget;
    try {
      networkTarget = await resolveTarget(parsed.executionInput.url);
    } catch {
      throw new PublicTaskError(403, 'network-target-denied', 'target did not resolve exclusively to stable public addresses');
    }
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
    if (!await createReservation(key, task)) {
      const raced = await existingSubmission(key, parsed.requestDigest);
      if (!raced) throw new Error('idempotency reservation disappeared after a concurrent claim');
      return { status: 200, payload: publicStatus(raced, dispatcherStatus()) };
    }
    await persistTask(task);
    await enqueue(task.id);
    const accepted = await loadTask(task.id);
    return { status: 202, payload: publicStatus(accepted, dispatcherStatus()) };
  }

  async function getTask(taskId) {
    return withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (task.completion && !task.receipt) await retainCompletion(task);
      return { status: 200, payload: publicStatus(task, dispatcherStatus()) };
    });
  }

  async function cancel(request, taskId, body) {
    const key = idempotencyKey(request);
    const cancellation = parseCancellation(body, config);
    let controller = null;
    const response = await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (Object.hasOwn(TERMINAL_STATUSES, task.status)) {
        return { status: 200, payload: publicStatus(task, dispatcherStatus()) };
      }
      if (task.cancellation
          && (task.cancellation.idempotencyKey !== key || task.cancellation.reason !== cancellation.reason)) {
        throw new PublicTaskError(409, 'cancellation-conflict', 'task already has a different cancellation operation');
      }
      if (!task.cancellation) {
        task.cancellation = {
          idempotencyKey: key,
          reason: cancellation.reason,
          requestedAt: new Date().toISOString(),
        };
      }
      const running = active.get(task.id);
      if (running) {
        controller = running.controller;
        await persistTask(task);
        return { status: 202, payload: publicStatus(task, dispatcherStatus()) };
      }
      removeQueued(task.id);
      task.completion = {
        ...terminalCompletion(null, true, redact, task.executionInput.url),
        completedAt: new Date().toISOString(),
      };
      await persistTask(task);
      await retainCompletion(task);
      return {
        status: Object.hasOwn(TERMINAL_STATUSES, task.status) ? 200 : 202,
        payload: publicStatus(task, dispatcherStatus()),
      };
    });
    controller?.abort();
    return response;
  }

  async function recover() {
    await ensureRoots();
    // Restart recovery asks the deployed identity for its named answer instead
    // of discarding the read error: an unreadable identity is the state
    // `/api/v1/version` already publishes as `ready: false` with
    // `deployed-service-identity-mismatch`, and every later submission asks
    // again and answers 503 on its own. Recovery of what is already on disk
    // does not depend on that answer, so it records the refusal and restores
    // the persisted tasks.
    const identityAtRecovery = await serviceIdentityReadiness();
    if (!identityAtRecovery.ok) {
      console.error(`[weles-public-task] restart recovery ran with no validated deployed service identity: ${identityAtRecovery.reason}`);
    }
    const mappingEntries = await readdir(mappingRoot, { withFileTypes: true });
    await cleanInterruptedTemporaryFiles(mappingRoot, mappingEntries);
    for (const entry of mappingEntries) {
      if (entry.name.endsWith('.tmp')) continue;
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
        throw new Error(`unexpected public task reservation entry: ${entry.name}`);
      }
      await materializeReservation(validateReservation(await readJson(join(mappingRoot, entry.name))));
    }

    const taskEntries = await readdir(taskRoot, { withFileTypes: true });
    await cleanInterruptedTemporaryFiles(taskRoot, taskEntries);
    const taskIds = [];
    for (const entry of taskEntries) {
      if (entry.name === 'idempotency' || entry.name.endsWith('.tmp')) continue;
      const match = /^task-([0-9a-f-]+)\.json$/.exec(entry.name);
      if (!entry.isFile() || !match || !UUID_RE.test(match[1])) {
        throw new Error(`unexpected public task state entry: ${entry.name}`);
      }
      taskIds.push(match[1]);
    }
    const recoveredQueue = [];
    for (const taskId of taskIds) {
      await withTaskLock(taskId, async () => {
        const task = await loadTask(taskId);
        if (task.receipt) return;
        if (task.completion) {
          await retainCompletion(task);
          return;
        }
        if (task.cancellation) {
          task.completion = {
            ...terminalCompletion(null, true, redact, task.executionInput.url),
            completedAt: new Date().toISOString(),
          };
          await persistTask(task);
          await retainCompletion(task);
          return;
        }
        if (task.status === 'running') {
          task.completion = {
            ...terminalCompletion({ ok: false, run_id: task.id }, false, redact, task.executionInput.url),
            error: 'browser evidence execution was interrupted by service restart',
            completedAt: new Date().toISOString(),
          };
          await persistTask(task);
          await retainCompletion(task);
        }
      });
      const recovered = await loadTask(taskId);
      if (recovered.status === 'queued' && !recovered.completion && !recovered.cancellation) {
        recoveredQueue.push({ taskId, createdAt: recovered.createdAt });
      }
    }
    recoveredQueue.sort((left, right) => {
      const byCreatedAt = String(left.createdAt).localeCompare(String(right.createdAt));
      return byCreatedAt || left.taskId.localeCompare(right.taskId);
    });
    for (const entry of recoveredQueue) {
      queue.push(entry.taskId);
      queued.add(entry.taskId);
    }
    await dispatchQueue();
  }

  return Object.freeze({ submit, getTask, cancel, recover });
}
