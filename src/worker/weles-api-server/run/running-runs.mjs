// The runs this server has a child for, and the one way to end one early.
//
// A browser run has no clock that ends it: it waits until the page answers,
// and a page that never answers keeps it waiting. A coalesced sign-in is worse
// off still, because every later request for the same account joins the run
// already under way, so one run that waits forever holds the account until
// the server restarts. Each runner registers its child here for as long as it
// runs, and `cancelRun` is how an operator ends one: the runner kills the
// run's process group and records the run as cancelled, with who said so.

import { isAbandoned, openRequestOfRun } from '../../../operator/request.mjs';

const running = new Map();

/**
 * Register a run for as long as its child runs. `cancel(detail)` ends it and
 * must make the runner finish the run; `describe()` returns what the run is
 * doing now. Returns the function that removes the registration.
 */
export function registerRunningRun(runId, { action, kind, startedAt, cancel, describe }) {
  running.set(runId, { runId, action, kind, startedAt, cancel, describe, cancelRequested: null });
  return () => { running.delete(runId); };
}

// `operator_request` is the open request the run waits on, read from the
// request store, so every kind of run says when it waits for a person and
// for what; null when it waits on nobody.
function summary(entry) {
  const request = openRequestOfRun(entry.runId);
  return {
    run_id: entry.runId,
    action: entry.action,
    kind: entry.kind,
    started_at: entry.startedAt,
    cancel_requested: entry.cancelRequested,
    ...entry.describe(),
    operator_request: request ? { ...request, abandoned: isAbandoned(request) } : null,
  };
}

/** Every run this server has a live child for, oldest first. */
export function listRunningRuns() {
  return [...running.values()]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .map(summary);
}

/** The run with this id if this server is running it, else null. */
export function runningRun(runId) {
  const entry = running.get(runId);
  return entry ? summary(entry) : null;
}

/**
 * End a run this server is running. `detail` says who ended it and why; it
 * is kept on the run's record. Returns null when no such run is running here.
 */
export function cancelRun(runId, detail) {
  const entry = running.get(runId);
  if (!entry) return null;
  entry.cancelRequested = { at: new Date().toISOString(), detail };
  entry.cancel(detail);
  return summary(entry);
}
