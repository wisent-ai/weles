import { canonicalJson, digest, isObject } from '../wire/canonical-json.mjs';

export function terminalCompletion(output, aborted, _redact, requestedUrl = null) {
  let completion;
  if (aborted || output?.cancelled) {
    completion = { status: 'cancelled', result: { state: 'cancelled' }, error: null, capture: null };
  } else if (output?.ok) {
    const captureResult = isObject(output.result) ? output.result : null;
    let effectiveUrl = null;
    let finalUrl = null;
    try {
      effectiveUrl = typeof captureResult?.url === 'string' ? new URL(captureResult.url).toString() : null;
      finalUrl = typeof captureResult?.final_url === 'string' ? new URL(captureResult.final_url).toString() : null;
    } catch {}
    const captureValid = typeof requestedUrl === 'string'
      && effectiveUrl === requestedUrl
      && typeof finalUrl === 'string'
      && new URL(finalUrl).origin === new URL(requestedUrl).origin;
    if (!captureValid) {
      completion = {
        status: 'failed',
        result: { state: 'failed', executionRunId: output.run_id ?? null },
        error: 'browser evidence capture identity is missing or inconsistent',
        capture: { requestedUrl, effectiveUrl, finalUrl },
      };
    } else {
      const value = { requestedUrl, effectiveUrl, finalUrl };
      completion = {
        status: 'succeeded',
        result: { state: 'succeeded', value, executionRunId: output.run_id },
        error: null,
        capture: value,
      };
    }
  } else {
    const failure = output?.timed_out ? 'browser evidence task timed out' : 'browser evidence task failed';
    completion = {
      status: 'failed',
      result: { state: 'failed', executionRunId: output?.run_id ?? null },
      error: failure,
      capture: { requestedUrl, effectiveUrl: null, finalUrl: null },
    };
  }
  return { ...completion, resultDigest: digest(canonicalJson(completion.result)) };
}

export function createDispatcher({
  concurrency,
  taskTimeoutMs,
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

  function dispatcherStatus() {
    return {
      configuredConcurrency: concurrency,
      taskTimeoutMs,
      active: active.size,
      queued: queue.length,
      healthy: dispatcherHealthy,
    };
  }

  async function executeTask(taskId, controller) {
    let output;
    try {
      const task = await loadTask(taskId);
      output = await runTrajectory({
        action: task.request.action,
        params: task.executionInput,
        runId: task.id,
        signal: controller.signal,
        policy: config.policy,
        networkTarget: task.networkTarget,
      });
    } catch {
      output = { ok: false, run_id: taskId, result: null, timed_out: false };
    }
    await withTaskLock(taskId, async () => {
      const task = await loadTask(taskId);
      if (task.receipt) return;
      const cancellationWins = Boolean(task.cancellation) || controller.signal.aborted;
      task.completion = {
        ...terminalCompletion(output, cancellationWins, redact, task.executionInput.url),
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
      if (draining || task.receipt || task.completion) return;
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
      active.set(task.id, { controller, promise: Promise.resolve() });
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      await persistTask(task);
    });
    if (!controller) return;
    const running = active.get(taskId);
    const promise = executeTask(taskId, controller)
      .finally(() => {
        if (active.get(taskId)?.controller === controller) active.delete(taskId);
        void dispatchQueue();
      });
    running.promise = promise;
  }

  async function dispatchQueue() {
    if (dispatching || draining) return;
    dispatching = true;
    try {
      while (!draining && active.size < concurrency && queue.length > 0) {
        const taskId = queue.shift();
        queued.delete(taskId);
        try {
          await startTask(taskId);
          dispatcherHealthy = true;
        } catch {
          queue.unshift(taskId);
          queued.add(taskId);
          dispatcherHealthy = false;
          break;
        }
      }
    } finally {
      dispatching = false;
    }
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
    const index = queue.indexOf(taskId);
    if (index >= 0) queue.splice(index, 1);
  }

  async function shutdown() {
    draining = true;
    queue.length = 0;
    queued.clear();
    for (const running of active.values()) running.controller.abort();
    await Promise.allSettled([...active.values()].map((running) => running.promise));
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
    shutdown,
  });
}
