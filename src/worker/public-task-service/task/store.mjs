import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { PublicTaskError } from '../wire.mjs';
import { UUID_RE, isObject, sha256 } from '../wire/canonical-json.mjs';
import { atomicJsonWrite, readJson, syncDirectory } from '../durable-write.mjs';

function safeTaskFilename(taskId) {
  if (!UUID_RE.test(taskId)) throw new PublicTaskError(400, 'invalid-task-id', 'invalid taskId');
  return `task-${taskId.toLowerCase()}.json`;
}

export function createTaskStore({ runResultsRoot, taskRoot, mappingRoot, organizationId }) {
  const taskLocks = new Map();
  const taskPath = (taskId) => join(taskRoot, safeTaskFilename(taskId));
  const mappingPath = (key) => join(mappingRoot, `${sha256(`${organizationId}\0${key}`)}.json`);

  async function ensureRoots() {
    await mkdir(runResultsRoot, { recursive: true, mode: 0o700 });
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(runResultsRoot);
    await mkdir(mappingRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(taskRoot);
    await syncDirectory(mappingRoot);
  }

  async function loadTask(taskId) {
    try {
      const task = await readJson(taskPath(taskId));
      if (!isObject(task)
          || task.id !== taskId
          || task.request?.organizationId !== organizationId
          || typeof task.requestDigest !== 'string'
          || !isObject(task.spisBinding)
          || !isObject(task.serviceIdentity)) {
        throw new Error('public task document failed identity validation');
      }
      return task;
    } catch (error) {
      if (error?.code === 'ENOENT') throw new PublicTaskError(404, 'task-not-found', 'not found');
      throw error;
    }
  }

  async function persistTask(task) {
    task.updatedAt = new Date().toISOString();
    await atomicJsonWrite(taskPath(task.id), task);
  }

  async function withTaskLock(taskId, operation) {
    const previous = taskLocks.get(taskId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    const current = previous.then(() => gate);
    taskLocks.set(taskId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (taskLocks.get(taskId) === current) taskLocks.delete(taskId);
    }
  }

  function validateReservation(reservation) {
    if (!isObject(reservation)
        || reservation.schema !== 'weles.public-task-reservation.v1'
        || !UUID_RE.test(reservation.taskId ?? '')
        || typeof reservation.requestDigest !== 'string'
        || !isObject(reservation.task)
        || reservation.task.id !== reservation.taskId
        || reservation.task.requestDigest !== reservation.requestDigest
        || reservation.task.request?.organizationId !== organizationId) {
      throw new Error('public task reservation failed validation');
    }
    return reservation;
  }

  async function materializeReservation(reservation) {
    try {
      const task = await loadTask(reservation.taskId);
      if (task.requestDigest !== reservation.requestDigest) {
        throw new Error('public task reservation disagrees with task state');
      }
      return task;
    } catch (error) {
      if (!(error instanceof PublicTaskError) || error.status !== 404) throw error;
      await persistTask(reservation.task);
      return reservation.task;
    }
  }

  async function readReservation(key) {
    try {
      return validateReservation(await readJson(mappingPath(key)));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function createReservation(key, task) {
    await ensureRoots();
    const path = mappingPath(key);
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    try {
      const reservation = {
        schema: 'weles.public-task-reservation.v1',
        taskId: task.id,
        requestDigest: task.requestDigest,
        task,
      };
      await handle.writeFile(`${JSON.stringify(reservation, null, 2)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        await rm(path, { force: true });
        await syncDirectory(mappingRoot);
        throw new Error(
          `public task reservation write failed: ${error.message}; and its open file handle could not be closed: ${closeError.message}`,
          { cause: error },
        );
      }
      await rm(path, { force: true });
      await syncDirectory(mappingRoot);
      throw error;
    }
    await handle.close();
    await syncDirectory(mappingRoot);
    return true;
  }

  return Object.freeze({
    ensureRoots,
    loadTask,
    persistTask,
    withTaskLock,
    validateReservation,
    materializeReservation,
    readReservation,
    createReservation,
  });
}
