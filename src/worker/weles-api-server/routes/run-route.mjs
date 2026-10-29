// POST /run: execute one named trajectory and answer for it.
//
// This is the route the whole server exists for, and it is the only one that
// has to reconcile three different callers at once. An operator wants the raw
// result. A login flow must not have its credential echoed back over HTTP. A
// machine that renews a burnt subscription cannot hold a socket open for the
// minutes a browser sign-in takes. So `creds` picks between returning the run
// redacted, returning it verbatim, and returning only the account items it
// saved to Skarbiec (run-route/answer.mjs); and `detached` answers with a run
// id immediately and leaves the outcome on disk to be read afterwards.
//
// The refusals are part of the contract (run-route/request.mjs): raw output is
// refused outright when the deployment forbids it, and a fresh browser profile
// is refused without an account to attach it to.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants as http } from 'node:http2';
import { join } from 'node:path';

import { ALLOW_UNAUTH, RUN_RESULTS_DIR, TOKEN } from '../configuration.mjs';
import { authorized, json, readBody } from '../http-exchange.mjs';
import { isCredentialTrajectory } from '../run/credential-outcome.mjs';
import {
  claimRunResult,
  coalesceRun,
  persistRunResult,
  runAdmissionKey,
  SAFE_RUN_ID,
} from '../run/run-outcome.mjs';
import { answerRun } from './run-route/answer.mjs';
import { readRunRequest } from './run-route/request.mjs';

/**
 * How a run is admitted: a credential run at most once at a time per action,
 * account and parameters (a second register would create a second account),
 * joining the one already running; any other run starts at once.
 */
function admit(run, start, metadata) {
  if (!isCredentialTrajectory(run.action))
    return { entry: { promise: start(), metadata }, joined: false };
  const key = runAdmissionKey('trajectory', {
    action: run.action,
    account_id: run.accountId,
    fresh_profile: run.freshProfile,
    params: run.params,
  });
  return coalesceRun(key, start, metadata);
}

/** Start the run detached: answer its id now, and write its outcome to its result file. */
function startDetached(res, body, run, start) {
  const { action, accountId, requestBinding } = run;
  // A caller may name the run. The same run id sent again starts nothing: it
  // answers with the run that id already names, so a caller that lost its
  // answer can ask again without acting on the account twice.
  const namedId = typeof body.run_id === 'string' ? body.run_id.trim() : '';
  if (body.run_id !== undefined && !SAFE_RUN_ID.test(namedId)) {
    json(res, http.HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: 'invalid_run_id',
    });
    return;
  }
  const detachedId = namedId || randomUUID();
  const resultPath = join(RUN_RESULTS_DIR, `${detachedId}.json`);
  const running = {
    ok: null,
    action,
    account_id: accountId,
    ...requestBinding,
    status: 'running',
    started_at: new Date().toISOString(),
  };
  if (namedId && !claimRunResult(resultPath, running)) {
    const named = JSON.parse(readFileSync(resultPath, 'utf8'));
    const existingId =
      named.status === 'joined' ? named.detached_run : detachedId;
    json(res, http.HTTP_STATUS_OK, {
      ok: true,
      action,
      ...requestBinding,
      detached_run: existingId,
      result_path: join(RUN_RESULTS_DIR, `${existingId}.json`),
      existing: true,
    });
    return;
  }
  const admission = admit(run, start, { detachedId, resultPath });
  const admittedId = admission.entry.metadata.detachedId;
  const admittedPath = admission.entry.metadata.resultPath;
  if (admission.joined && namedId) {
    // The named run joined one already running: its file says which, so the
    // same run id sent again answers with the run doing the work.
    persistRunResult(resultPath, {
      ...running,
      status: 'joined',
      detached_run: admittedId,
    });
  }
  if (!admission.joined) {
    persistRunResult(admittedPath, running);
    admission.entry.promise
      .then((result) => {
        persistRunResult(admittedPath, {
          ...result,
          action,
          account_id: accountId,
          ...requestBinding,
          status: 'finished',
          completed_at: new Date().toISOString(),
        });
      })
      .catch((error) => {
        persistRunResult(admittedPath, {
          ok: false,
          action,
          account_id: accountId,
          ...requestBinding,
          status: 'failed',
          error: String(error && error.message ? error.message : error),
          completed_at: new Date().toISOString(),
        });
      });
  }
  json(res, http.HTTP_STATUS_ACCEPTED, {
    ok: true,
    action,
    ...requestBinding,
    detached_run: admittedId,
    result_path: admittedPath,
    coalesced: admission.joined,
  });
}

export async function respondToRun(
  req,
  res,
  runTrajectory,
  validateAccountSecurityParams,
  validateAppPasswordParams,
) {
  if (!authorized(req)) {
    json(
      res,
      TOKEN || ALLOW_UNAUTH
        ? http.HTTP_STATUS_UNAUTHORIZED
        : http.HTTP_STATUS_INTERNAL_SERVER_ERROR,
      {
        ok: false,
        error:
          TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_API_TOKEN',
      },
    );
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    json(res, http.HTTP_STATUS_BAD_REQUEST, { ok: false, error: e.message });
    return;
  }
  const run = readRunRequest(
    body,
    validateAccountSecurityParams,
    validateAppPasswordParams,
  );
  if (run.refusal) {
    json(res, run.refusal.status, run.refusal.body);
    return;
  }
  const start = () =>
    runTrajectory(run.action, run.params, run.accountId, run.freshProfile);
  // A browser login runs for minutes. Every operator transport that can reach
  // this route closes long before that, and a request whose socket goes takes
  // the run with it. `detached: true` starts the run, answers with its id, and
  // writes the result where it can be read afterwards.
  if (body.detached === true) {
    startDetached(res, body, run, start);
    return;
  }
  const admission = admit(run, start, undefined);
  const out = await admission.entry.promise;
  answerRun(res, {
    action: run.action,
    mode: run.mode,
    out,
    joined: admission.joined,
  });
}
