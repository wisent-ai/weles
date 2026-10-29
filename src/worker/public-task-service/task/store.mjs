import { EventEmitter, once } from 'node:events';
import { constants as fsMode } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { constants as http } from 'node:http2';
import { join } from 'node:path';

import { PublicTaskError, TERMINAL_STATUSES } from '../wire.mjs';
import { UUID_RE, isObject, sha256 } from '../wire/canonical-json.mjs';
import { atomicJsonWrite, readJson, syncDirectory } from '../durable-write.mjs';

/** Task directories are the service user's alone: read, write and search. */
const PRIVATE_DIRECTORY = fsMode.S_IRWXU;

/** A reservation file is the service user's alone: read and write. */
const PRIVATE_FILE = fsMode.S_IRUSR | fsMode.S_IWUSR;

/** The indentation a reservation document is written with. */
const INDENT = '  ';

const RESERVATION_SCHEMA = 'weles.public-task-reservation.v1';

function safeTaskFilename(taskId) {
  if (!UUID_RE.test(taskId))
    throw new PublicTaskError(
      http.HTTP_STATUS_BAD_REQUEST,
      'invalid-task-id',
      'invalid taskId',
    );
  return `task-${taskId.toLowerCase()}.json`;
}

/**
 * The file at `path` read by `read`, or `{ absent: true }` when no file is
 * there; any other failure to read it is thrown with its cause.
 */
async function present(path, read) {
  const outcome = { absent: false };
  try {
    outcome.value = await read(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    outcome.absent = true;
  }
  return outcome;
}

export function createTaskStore({
  runResultsRoot,
  taskRoot,
  mappingRoot,
  organizationId,
}) {
  const taskLocks = new Map();
  // Every durable task write announces the task id, so a reader can wait for
  // the record to change instead of re-reading it on a timer. Every waiting
  // request listens, so the emitter sets no bound on listeners.
  const changes = new EventEmitter();
  changes.setMaxListeners(Infinity);
  const taskPath = (taskId) => join(taskRoot, safeTaskFilename(taskId));
  const mappingPath = (key) =>
    join(mappingRoot, `${sha256(`${organizationId}\u0000${key}`)}.json`);

  async function ensureRoots() {
    await mkdir(runResultsRoot, { recursive: true, mode: PRIVATE_DIRECTORY });
    await mkdir(taskRoot, { recursive: true, mode: PRIVATE_DIRECTORY });
    await syncDirectory(runResultsRoot);
    await mkdir(mappingRoot, { recursive: true, mode: PRIVATE_DIRECTORY });
    await syncDirectory(taskRoot);
    await syncDirectory(mappingRoot);
  }

  /** `task` as the task `taskId` of this organization, or a thrown refusal. */
  function identified(task, taskId) {
    if (
      !isObject(task) ||
      task.id !== taskId ||
      !isObject(task.request) ||
      task.request.organizationId !== organizationId ||
      typeof task.requestDigest !== 'string' ||
      !isObject(task.spisBinding) ||
      !isObject(task.serviceIdentity)
    ) {
      throw new Error('public task document failed identity validation');
    }
    return task;
  }

  async function loadTask(taskId) {
    const read = await present(taskPath(taskId), readJson);
    if (read.absent)
      throw new PublicTaskError(
        http.HTTP_STATUS_NOT_FOUND,
        'task-not-found',
        'not found',
      );
    return identified(read.value, taskId);
  }

  async function persistTask(task) {
    task.updatedAt = new Date().toISOString();
    await atomicJsonWrite(taskPath(task.id), task);
    changes.emit(task.id);
  }

  /**
   * Stop waiting for a change of the task: abort the wait and settle it. The
   * wait then rejects with the abort it was given; any other rejection is a
   * failure of the change channel and is thrown.
   */
  async function abandon(wait) {
    wait.controller.abort();
    try {
      await wait.changed;
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }

  /**
   * Resolve once the task's durable record holds a terminal status. The
   * listener is registered before each read, so a write that lands between
   * the read and the wait still wakes it.
   */
  async function awaitTerminal(taskId) {
    for (;;) {
      const controller = new AbortController();
      const wait = {
        controller,
        changed: once(changes, taskId, { signal: controller.signal }),
      };
      let task;
      try {
        task = await loadTask(taskId);
      } catch (error) {
        await abandon(wait);
        throw error;
      }
      if (Object.hasOwn(TERMINAL_STATUSES, task.status)) {
        await abandon(wait);
        return;
      }
      await wait.changed;
    }
  }

  async function withTaskLock(taskId, operation) {
    const previous = taskLocks.has(taskId)
      ? taskLocks.get(taskId)
      : Promise.resolve();
    let release;
    const gate = new Promise((resolveGate) => {
      release = resolveGate;
    });
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
    if (
      !isObject(reservation) ||
      reservation.schema !== RESERVATION_SCHEMA ||
      typeof reservation.taskId !== 'string' ||
      !UUID_RE.test(reservation.taskId) ||
      typeof reservation.requestDigest !== 'string' ||
      !isObject(reservation.task) ||
      reservation.task.id !== reservation.taskId ||
      reservation.task.requestDigest !== reservation.requestDigest ||
      !isObject(reservation.task.request) ||
      reservation.task.request.organizationId !== organizationId
    ) {
      throw new Error('public task reservation failed validation');
    }
    return reservation;
  }

  async function materializeReservation(reservation) {
    const read = await present(taskPath(reservation.taskId), readJson);
    if (read.absent) {
      await persistTask(reservation.task);
      return reservation.task;
    }
    const task = identified(read.value, reservation.taskId);
    if (task.requestDigest !== reservation.requestDigest) {
      throw new Error('public task reservation disagrees with task state');
    }
    return task;
  }

  /** The reservation recorded under `key`, or null when none is. */
  async function readReservation(key) {
    const read = await present(mappingPath(key), readJson);
    return read.absent ? null : validateReservation(read.value);
  }

  /**
   * Create the reservation file for `key`; the open handle, or nothing when
   * another request created it first. Any other failure is thrown.
   */
  async function exclusive(path) {
    const outcome = { taken: false };
    try {
      outcome.handle = await open(path, 'wx', PRIVATE_FILE);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      outcome.taken = true;
    }
    return outcome;
  }

  /** Reserve `key` for `task`; false when another request reserved it first. */
  async function createReservation(key, task) {
    await ensureRoots();
    const path = mappingPath(key);
    const opened = await exclusive(path);
    if (opened.taken) return false;
    const { handle } = opened;
    try {
      const reservation = {
        schema: RESERVATION_SCHEMA,
        taskId: task.id,
        requestDigest: task.requestDigest,
        task,
      };
      await handle.writeFile(
        `${JSON.stringify(reservation, null, INDENT)}\n`,
        'utf8',
      );
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
    awaitTerminal,
    withTaskLock,
    validateReservation,
    materializeReservation,
    readReservation,
    createReservation,
  });
}
