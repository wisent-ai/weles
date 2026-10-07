// The API owns the durable task dispatcher in this process. Native service
// control belongs to Stado; a worker request must not recreate a second daemon.

import { readFileSync } from 'node:fs';

// Whether each action changes the dispatcher; a change is a POST, a reading
// a GET. The CLI reads the same declaration.
export const workerActions = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL('./worker-control/actions.json', import.meta.url),
      'utf8',
    ),
  ).mutates,
);

export function createWorkerControl(publicTaskService) {
  function workerStatus() {
    const dispatcher = publicTaskService.health.dispatcher;
    const running =
      dispatcher.healthy &&
      !dispatcher.draining &&
      !dispatcher.recovering &&
      !dispatcher.paused;
    return {
      schema: 'weles.worker-status.v1',
      supported: true,
      label: 'weles-task-dispatcher',
      loaded: true,
      running,
      ready: publicTaskService.health.ready,
      pid: process.pid,
      state: dispatcher.draining
        ? 'draining'
        : dispatcher.recovering
          ? 'recovering'
          : dispatcher.paused
            ? 'stopped'
            : running
              ? 'running'
              : 'failed',
      last_exit_status: null,
      dispatcher,
      prerequisites: publicTaskService.health.prerequisites,
    };
  }

  async function controlWorker(action) {
    const before = workerStatus();
    if (workerActions[action] !== true) {
      return {
        ok: false,
        error: 'unsupported_worker_action',
        action,
        before,
        after: before,
      };
    }
    if (action === 'start' && before.running) {
      return { ok: true, action, changed: false, before, after: before };
    }
    if (action === 'stop' && before.dispatcher.paused) {
      return { ok: true, action, changed: false, before, after: before };
    }
    const result =
      action === 'stop'
        ? publicTaskService.stopWorker()
        : action === 'start' && before.dispatcher.paused
          ? await publicTaskService.resumeWorker()
          : await publicTaskService.restartWorker();
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      action,
      changed: result.ok,
      before,
      after: workerStatus(),
    };
  }

  return Object.freeze({ workerStatus, controlWorker });
}
