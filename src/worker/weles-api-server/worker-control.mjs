// The API owns the durable task dispatcher in this process. Native service
// control belongs to Stado; a worker request must not recreate a second daemon.

import { readFileSync } from 'node:fs';

export const workerActions = Object.freeze(JSON.parse(
  readFileSync(new URL('./worker-control/actions.json', import.meta.url), 'utf8'),
).actions);

export function createWorkerControl(publicTaskService) {
  function workerStatus() {
    const dispatcher = publicTaskService.health.dispatcher;
    const running = dispatcher.healthy && !dispatcher.draining && !dispatcher.recovering;
    return {
      schema: 'weles.worker-status.v1',
      supported: true,
      label: 'weles-task-dispatcher',
      loaded: true,
      running,
      ready: publicTaskService.health.ready,
      pid: process.pid,
      state: dispatcher.draining ? 'draining'
        : dispatcher.recovering ? 'recovering'
          : running ? 'running' : 'failed',
      last_exit_status: null,
      dispatcher,
      prerequisites: publicTaskService.health.prerequisites,
    };
  }

  async function controlWorker(action) {
    const before = workerStatus();
    if (!Object.hasOwn(workerActions, action) || !workerActions[action].mutation) {
      return { ok: false, error: 'unsupported_worker_action', action, before, after: before };
    }
    if (action === 'start' && before.running) {
      return { ok: true, action, changed: false, before, after: before };
    }
    const result = await publicTaskService.restartWorker();
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
