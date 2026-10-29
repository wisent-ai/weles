// Restart recovery of the public task service: every reservation and task the
// service persisted is read back, an interrupted run is settled as failed, a
// cancelled one as cancelled, and every task still queued returns to the
// queue in the order it was created.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { UUID_RE } from '../wire/canonical-json.mjs';
import { cleanInterruptedTemporaryFiles, readJson } from '../durable-write.mjs';
import { terminalCompletion } from './completion.mjs';

/** A reservation is stored under the SHA-256 of its idempotency key, in hex. */
const RESERVATION_FILE = new RegExp(
  `^[\\da-f]{${createHash('sha256').digest('hex').length}}\\.json$`,
);
const TASK_FILE = /^task-(?<id>[\da-f-]+)\.json$/;

/** The task ids persisted under `taskRoot`, refused naming an entry that is no task. */
async function persistedTaskIds(taskRoot) {
  const entries = await readdir(taskRoot, { withFileTypes: true });
  await cleanInterruptedTemporaryFiles(taskRoot, entries);
  const ids = [];
  for (const entry of entries) {
    if (entry.name === 'idempotency' || entry.name.endsWith('.tmp')) continue;
    const named = TASK_FILE.exec(entry.name);
    if (!entry.isFile() || !named || !UUID_RE.test(named.groups.id))
      throw new Error(`unexpected public task state entry: ${entry.name}`);
    ids.push(named.groups.id);
  }
  return ids;
}

export function createRecovery({
  store,
  dispatcher,
  deployedIdentity,
  taskRoot,
  mappingRoot,
  redact,
  retainCompletion,
}) {
  const {
    ensureRoots,
    loadTask,
    persistTask,
    withTaskLock,
    validateReservation,
    materializeReservation,
  } = store;
  const { queue, queued, dispatchQueue } = dispatcher;

  async function restoreReservations() {
    const entries = await readdir(mappingRoot, { withFileTypes: true });
    await cleanInterruptedTemporaryFiles(mappingRoot, entries);
    for (const entry of entries) {
      if (entry.name.endsWith('.tmp')) continue;
      if (!entry.isFile() || !RESERVATION_FILE.test(entry.name))
        throw new Error(
          `unexpected public task reservation entry: ${entry.name}`,
        );
      await materializeReservation(
        validateReservation(await readJson(join(mappingRoot, entry.name))),
      );
    }
  }

  /** Settle a task a restart left unfinished: cancelled, or interrupted while running. */
  async function settle(task) {
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
    } else if (task.status === 'running') {
      task.completion = {
        ...terminalCompletion(
          { ok: false, run_id: task.id },
          false,
          redact,
          task.executionInput.url,
        ),
        error: 'browser evidence execution was interrupted by service restart',
        completedAt: new Date().toISOString(),
      };
    } else return;
    await persistTask(task);
    await retainCompletion(task);
  }

  return async function recover() {
    await ensureRoots();
    // Restart recovery asks the deployed identity for its named answer instead
    // of discarding the read error: an unreadable identity is the state
    // `/api/v1/version` already publishes as `ready: false` with
    // `deployed-service-identity-mismatch`, and every later submission asks
    // again and is refused on its own. Recovery of what is already on disk
    // does not depend on that answer, so it records the refusal and restores
    // the persisted tasks.
    const identityAtRecovery =
      await deployedIdentity.serviceIdentityReadiness();
    if (!identityAtRecovery.ok)
      console.error(
        `[weles-public-task] restart recovery ran with no validated deployed service identity: ${identityAtRecovery.reason}`,
      );
    await restoreReservations();
    const recoveredQueue = [];
    for (const taskId of await persistedTaskIds(taskRoot)) {
      await withTaskLock(taskId, async () => settle(await loadTask(taskId)));
      const recovered = await loadTask(taskId);
      if (
        recovered.status === 'queued' &&
        !recovered.completion &&
        !recovered.cancellation
      )
        recoveredQueue.push({ taskId, createdAt: recovered.createdAt });
    }
    recoveredQueue.sort(
      (left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt)) ||
        left.taskId.localeCompare(right.taskId),
    );
    for (const entry of recoveredQueue) {
      if (queued.has(entry.taskId)) continue;
      queue.push(entry.taskId);
      queued.add(entry.taskId);
    }
    await dispatchQueue();
  };
}
