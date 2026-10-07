import { readFileSync } from 'node:fs';

import { json, readBody, requireTokenAuthorization } from '../http-exchange.mjs';
import { SAFE_RUN_ID, runResultFile } from '../run/run-outcome.mjs';
import { cancelRun, listRunningRuns, runningRun } from '../run/running-runs.mjs';

// The runs this worker is running, and the way to end one.
//
// A run's record says what it reached; it cannot say that the run has stood
// still for an hour on a page that never answers, and nothing ends such a run
// except its server's restart. GET /runs lists every run with a live child
// here, with when it last wrote anything and the tails of what it wrote, and
// POST /runs/:id/cancel ends one: the run's process group is killed and the
// run is recorded as cancelled, with the operator's words.

// A run id is SAFE_RUN_ID: letters, digits, `_` and `-`, so it never needs
// percent-decoding and a path that carries anything else is not a run.
const RUN_PATH = /^\/runs(?:\/([^/]+))?(?:\/(cancel))?$/;

export function isRunsRoute(req, url) {
  const match = RUN_PATH.exec(url.pathname);
  if (!match) return false;
  return match[2] ? req.method === 'POST' : req.method === 'GET';
}

function readRecord(runId) {
  const file = runResultFile(runId);
  return file ? JSON.parse(readFileSync(file.path, 'utf8')) : null;
}

/**
 * GET /runs: every run with a live child on this worker.
 * GET /runs/:id: that run's record, and what it is doing now when it runs here.
 * POST /runs/:id/cancel `{detail}`: end a run this worker is running. A run
 * that is not running here is refused with its record (409) or as unknown (404).
 */
export async function respondToRuns(req, res, url) {
  if (!requireTokenAuthorization(req, res)) return;
  const [, runId, cancel] = RUN_PATH.exec(url.pathname);
  if (!runId) {
    json(res, 200, { ok: true, runs: listRunningRuns() });
    return;
  }
  if (!SAFE_RUN_ID.test(runId)) {
    json(res, 400, { ok: false, error: 'invalid_run_id' });
    return;
  }
  if (!cancel) {
    const record = readRecord(runId);
    const live = runningRun(runId);
    if (!record && !live) {
      json(res, 404, { ok: false, error: 'run_not_found', run_id: runId });
      return;
    }
    json(res, 200, { ok: true, run_id: runId, record, running: live });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (error) { json(res, 400, { ok: false, error: error.message }); return; }
  const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
  if (!detail) {
    json(res, 400, { ok: false, error: 'detail_required', message: 'say who cancels the run and why in detail' });
    return;
  }
  const cancelled = cancelRun(runId, detail);
  if (cancelled) {
    json(res, 200, { ok: true, run_id: runId, running: cancelled });
    return;
  }
  const record = readRecord(runId);
  if (!record) {
    json(res, 404, { ok: false, error: 'run_not_found', run_id: runId });
    return;
  }
  json(res, 409, {
    ok: false,
    error: 'run_not_running_here',
    run_id: runId,
    message: record.status === 'finished'
      ? `the run finished at ${record.completed_at}; there is nothing to cancel`
      : `the run is recorded as ${record.status} but this server has no child for it: the server that ran it has stopped`,
    record,
  });
}
