import { readFileSync } from 'node:fs';

import { OPERATOR_ANSWERS, answerOperatorRequest, openRequestOfRun } from '../../../operator/request.mjs';
import { json, readBody, requireTokenAuthorization } from '../http-exchange.mjs';
import { SAFE_RUN_ID, runResultFile } from '../run/run-outcome.mjs';
import { cancelRun, listRunningRuns, runningRun } from '../run/running-runs.mjs';

// The runs this worker is running, what each waits for, and the ways to act
// on one.
//
// A run's record says what it reached; it cannot say that the run has stood
// still for an hour on a page that never answers, and nothing ends such a run
// except its server's restart. GET /runs lists every run with a live child
// here, with when it last wrote anything, the tails of what it wrote and the
// request it waits on when it waits for a person. POST /runs/:id/answer tells
// such a run what the person did, and POST /runs/:id/cancel ends a run: its
// process group is killed and the run is recorded as cancelled, with the
// operator's words.

// A run id is SAFE_RUN_ID: letters, digits, `_` and `-`, so it never needs
// percent-decoding and a path that carries anything else is not a run.
const RUN_PATH = /^\/runs(?:\/([^/]+))?(?:\/(cancel|answer))?$/;

export function isRunsRoute(req, url) {
  const match = RUN_PATH.exec(url.pathname);
  if (!match) return false;
  return match[2] ? req.method === 'POST' : req.method === 'GET';
}

function readRecord(runId) {
  const file = runResultFile(runId);
  return file ? JSON.parse(readFileSync(file.path, 'utf8')) : null;
}

// A run that is not running here: refused with its record (409) or as
// unknown (404).
function notRunningHere(res, runId, verb) {
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
      ? `the run finished at ${record.completed_at}; there is nothing to ${verb}`
      : `the run is recorded as ${record.status} but this server has no child for it: the server that ran it has stopped`,
    record,
  });
}

/**
 * POST /runs/:id/answer `{answer, detail}`: tell a run that waits for a person
 * what the person did — `approved` or `not_received`. The answer is written on
 * the request the run watches, here, where the run reads it. A run that waits
 * on nobody is refused (409) with the stage it stands at.
 */
async function answerRun(req, res, runId) {
  let body;
  try { body = await readBody(req); }
  catch (error) { json(res, 400, { ok: false, error: error.message }); return; }
  const answer = typeof body.answer === 'string' ? body.answer : '';
  if (!OPERATOR_ANSWERS.includes(answer)) {
    json(res, 400, { ok: false, error: 'invalid_answer', message: `answer must be one of ${OPERATOR_ANSWERS.join(', ')}; ending the wait is POST /runs/${runId}/cancel` });
    return;
  }
  const live = runningRun(runId);
  if (!live) { notRunningHere(res, runId, 'answer'); return; }
  const request = openRequestOfRun(runId);
  if (!request) {
    json(res, 409, {
      ok: false,
      error: 'run_not_waiting',
      run_id: runId,
      message: `the run waits for no answer from a person; it stands at ${live.stage?.stage ?? 'no reported stage'}`,
      running: live,
    });
    return;
  }
  answerOperatorRequest(request.id, answer, typeof body.detail === 'string' ? body.detail : '');
  json(res, 200, { ok: true, run_id: runId, running: runningRun(runId) });
}

/**
 * GET /runs: every run with a live child on this worker.
 * GET /runs/:id: that run's record, and what it is doing now when it runs here.
 * POST /runs/:id/answer: see answerRun.
 * POST /runs/:id/cancel `{detail}`: end a run this worker is running.
 */
export async function respondToRuns(req, res, url) {
  if (!requireTokenAuthorization(req, res)) return;
  const [, runId, action] = RUN_PATH.exec(url.pathname);
  if (!runId) {
    json(res, 200, { ok: true, runs: listRunningRuns() });
    return;
  }
  if (!SAFE_RUN_ID.test(runId)) {
    json(res, 400, { ok: false, error: 'invalid_run_id' });
    return;
  }
  if (!action) {
    const record = readRecord(runId);
    const live = runningRun(runId);
    if (!record && !live) {
      json(res, 404, { ok: false, error: 'run_not_found', run_id: runId });
      return;
    }
    json(res, 200, { ok: true, run_id: runId, record, running: live });
    return;
  }
  if (action === 'answer') {
    await answerRun(req, res, runId);
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
  notRunningHere(res, runId, 'cancel');
}
