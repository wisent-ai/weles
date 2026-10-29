import { terminalCompletion } from './completion.mjs';

// A promise's outcome as a value: the error stays whole for whoever reports it.
function settled(promise) {
  return promise.then(
    (value) => ({ failed: false, value }),
    (error) => ({ failed: true, error }),
  );
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function emptyList(list) {
  while (list.length) list.pop();
}

// Public tasks run one at a time: a browser evidence capture owns the host's
// browser while it runs, so the next queued task starts only when no task is
// active. There is no concurrency setting to state.
export function createDispatcher({
  redact,
  config,
  store,
  retainCompletion,
  runTrajectory,
}) {
  const { loadTask, persistTask, withTaskLock } = store;
  const active = new Map();
  const queue = [];
  const queued = new Set();
  let dispatching = false;
  let dispatcherHealthy = true;
  let draining = false;
  let recovering = false;
  // Stopped by the operator: no queued task starts, running ones finish, and
  // submissions still queue. `resume` or a recovery ends it.
  let paused = false;
  let failure = null;

  function dispatcherStatus() {
    return {
      active: active.size,
      queued: queue.length,
      healthy: dispatcherHealthy,
      dispatching,
      draining,
      recovering,
      paused,
      failure,
    };
  }

  async function executeTask(taskId, controller) {
    const run = await settled(
      loadTask(taskId).then((task) =>
        runTrajectory({
          action: task.request.action,
          params: task.executionInput,
          runId: task.id,
          signal: controller.signal,
          policy: config.policy,
          networkTarget: task.networkTarget,
        }),
      ),
    );
    // The completion keeps its fixed public error; the service log names the
    // load or run failure behind it.
    if (run.failed)
      console.error(
        `[public-task] task ${taskId} run failed: ${messageOf(run.error)}`,
      );
    const output = run.failed
      ? { ok: false, run_id: taskId, result: null }
      : run.value;
    await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (task.receipt) return;
      const cancellationWins =
        Boolean(task.cancellation) || controller.signal.aborted;
      task.completion = {
        ...terminalCompletion(
          output,
          cancellationWins,
          redact,
          task.executionInput.url,
        ),
        completedAt: new Date().toISOString(),
      };
      await persistTask(task);
      await retainCompletion(task);
    });
  }

  async function startTask(taskId) {
    let controller = null;
    await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (draining || recovering || paused || task.receipt || task.completion)
        return;
      if (task.cancellation) {
        task.completion = {
          ...terminalCompletion(null, true, redact, task.executionInput.url),
          completedAt: new Date().toISOString(),
        };
        await persistTask(task);
        await retainCompletion(task);
        return;
      }
      if (task.status !== 'queued' || active.has(task.id)) return;
      controller = new AbortController();
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      await persistTask(task);
      if (draining || recovering) {
        controller = null;
        return;
      }
      active.set(task.id, { controller, promise: Promise.resolve() });
    });
    if (!controller) return;
    const running = active.get(taskId);
    const promise = executeTask(taskId, controller).finally(() => {
      if (active.get(taskId)?.controller === controller) active.delete(taskId);
      void dispatchQueue();
    });
    running.promise = promise;
  }

  async function dispatchQueue() {
    if (dispatching || draining || recovering || paused) return;
    dispatching = true;
    while (
      !draining &&
      !recovering &&
      !paused &&
      !active.size &&
      queue.length
    ) {
      const taskId = queue.shift();
      queued.delete(taskId);
      const start = await settled(startTask(taskId));
      if (start.failed) {
        queue.unshift(taskId);
        queued.add(taskId);
        dispatcherHealthy = false;
        failure = {
          operation: 'start-task',
          taskId,
          message: redact(messageOf(start.error)),
        };
        break;
      }
      dispatcherHealthy = true;
      failure = null;
    }
    dispatching = false;
  }

  async function enqueue(taskId) {
    if (!queued.has(taskId) && !active.has(taskId)) {
      queue.push(taskId);
      queued.add(taskId);
    }
    await dispatchQueue();
  }

  function removeQueued(taskId) {
    if (!queued.delete(taskId)) return;
    const kept = queue.filter((queuedId) => queuedId !== taskId);
    emptyList(queue);
    queue.push(...kept);
  }

  function beginRecovery() {
    if (draining || dispatching || active.size || (recovering && !failure))
      return false;
    recovering = true;
    paused = false;
    failure = null;
    emptyList(queue);
    queued.clear();
    return true;
  }

  function pause() {
    paused = true;
  }

  async function resume() {
    paused = false;
    await dispatchQueue();
  }

  async function finishRecovery(error) {
    const failed = error !== undefined;
    failure = failed
      ? { operation: 'recover-tasks', message: redact(messageOf(error)) }
      : null;
    dispatcherHealthy = !failed;
    recovering = failed;
    if (!failed) await dispatchQueue();
  }

  async function shutdown() {
    draining = true;
    emptyList(queue);
    queued.clear();
    for (const running of active.values()) running.controller.abort();
    await Promise.allSettled(
      [...active.values()].map((running) => running.promise),
    );
  }

  return Object.freeze({
    active,
    queue,
    queued,
    draining: () => draining,
    dispatcherStatus,
    enqueue,
    removeQueued,
    dispatchQueue,
    beginRecovery,
    finishRecovery,
    pause,
    resume,
    shutdown,
  });
}
