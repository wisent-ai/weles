// POST /run: execute one named trajectory and answer for it.
//
// This is the route the whole server exists for, and it is the only one that
// has to reconcile three different callers at once. An operator wants the raw
// result. A login flow must not have its minted credential echoed back over
// HTTP. A machine that renews a burnt subscription cannot hold a socket open
// for the minutes a browser sign-in takes. So `creds` picks between returning
// the run redacted, returning it verbatim, and persisting the credential and
// returning only a reference to it; and `detached` answers with a run id
// immediately and leaves the outcome on disk to be read afterwards.
//
// The refusals are part of the contract: raw output is refused outright when
// the deployment forbids it, and a fresh browser profile is refused without an
// account to attach it to, because a fresh profile with no account signs in as
// nobody.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  ALLOW_RAW_CREDS,
  ALLOW_UNAUTH,
  RUN_RESULTS_DIR,
  TIMEOUT_MS,
  TOKEN,
} from '../configuration.mjs';
import { authorized, json, readBody } from '../http-exchange.mjs';
import {
  credentialFailure,
  extractCreds,
  isCredentialTrajectory,
  storeCredential,
} from '../run/credential-outcome.mjs';
import { coalesceRun, persistRunResult, runAdmissionKey } from '../run/run-outcome.mjs';

export async function respondToRun(req, res, runTrajectory) {
  if (!authorized(req)) {
    json(res, TOKEN || ALLOW_UNAUTH ? 401 : 500, {
      ok: false,
      error: TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_API_TOKEN',
    });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!action) { json(res, 400, { ok: false, error: 'missing_action' }); return; }
  const credsMode = typeof body.creds === 'string' ? body.creds.trim() : 'redact';
  if (!['redact', 'raw', 'store'].includes(credsMode)) {
    json(res, 400, { ok: false, error: 'creds must be redact|raw|store' });
    return;
  }
  if (credsMode === 'raw' && !ALLOW_RAW_CREDS) {
    json(res, 403, { ok: false, error: 'raw_creds_forbidden' });
    return;
  }
  const params = body.params && typeof body.params === 'object' ? body.params : {};
  const accountId = typeof body.account_id === 'string' ? body.account_id : null;
  const freshProfile = body.fresh_profile === true;
  if (freshProfile && !accountId) {
    json(res, 400, { ok: false, error: 'fresh_profile_requires_account_id' });
    return;
  }
  const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS;
  // A browser login runs for minutes. Every operator transport that can reach
  // this route closes long before that, and a request whose socket goes takes
  // the run with it, so the one action that renews a burnt subscription could
  // only be started by a client willing to wait -- which is to say, not by the
  // software. `detached: true` starts the run, answers with its id, and writes
  // the result where it can be read afterwards.
  if (body.detached === true) {
    const coalesced = isCredentialTrajectory(action);
    const admissionKey = coalesced
      ? runAdmissionKey('trajectory', { action, account_id: accountId, fresh_profile: freshProfile, params })
      : null;
    const detachedId = randomUUID();
    const resultPath = join(RUN_RESULTS_DIR, `${detachedId}.json`);
    const admission = admissionKey
      ? coalesceRun(
        admissionKey,
        () => runTrajectory(action, params, accountId, freshProfile, timeoutMs),
        { detachedId, resultPath },
      )
      : {
        entry: {
          promise: runTrajectory(action, params, accountId, freshProfile, timeoutMs),
          metadata: { detachedId, resultPath },
        },
        joined: false,
      };
    const admittedId = admission.entry.metadata.detachedId;
    const admittedPath = admission.entry.metadata.resultPath;
    if (!admission.joined) {
      persistRunResult(
        admittedPath,
        { ok: null, action, status: 'running', started_at: new Date().toISOString() },
      );
      admission.entry.promise
        .then((result) => {
          persistRunResult(
            admittedPath,
            { ...result, action, status: 'finished', completed_at: new Date().toISOString() },
          );
        })
        .catch((error) => {
          persistRunResult(
            admittedPath,
            {
              ok: false,
              action,
              status: 'failed',
              error: String(error && error.message ? error.message : error).slice(0, 300),
              completed_at: new Date().toISOString(),
            },
          );
        });
    }
    json(res, 202, {
      ok: true,
      action,
      detached_run: admittedId,
      result_path: admittedPath,
      coalesced: admission.joined,
    });
    return;
  }
  const admission = isCredentialTrajectory(action)
    ? coalesceRun(
      runAdmissionKey('trajectory', { action, account_id: accountId, fresh_profile: freshProfile, params }),
      () => runTrajectory(action, params, accountId, freshProfile, timeoutMs),
    )
    : { entry: { promise: runTrajectory(action, params, accountId, freshProfile, timeoutMs) }, joined: false };
  const out = await admission.entry.promise;

  if (out.error === 'no_trajectory') { json(res, 404, out); return; }

  // store mode: persist extracted creds, return only a reference (no raw run).
  if (credsMode === 'store') {
    if (!out.ok) { json(res, 502, { ok: false, exitCode: out.exitCode, action, run_id: out.run_id, error: 'run_failed', stderr_tail: out.stderr_tail }); return; }
    const creds = extractCreds(out.result);
    if (!creds) { json(res, 422, { ok: false, action, run_id: out.run_id, error: 'no_credentials_in_result' }); return; }
    let ref;
    try { ref = await storeCredential(action, params, creds, out.run_id); }
    catch (e) { json(res, 502, { ok: false, action, run_id: out.run_id, error: `store_failed: ${String(e && e.message ? e.message : e).slice(0, 200)}` }); return; }
    json(res, 200, { ok: true, action, run_id: out.run_id, credential: ref, coalesced: admission.joined });
    return;
  }
  // Credential trajectories print the minted credential to stdout so their
  // parent reauth flow can donate it to Skarbiec. Redact mode returns only
  // credential presence and allowlisted failure identifiers parsed from
  // stderr; raw output and arbitrary failure text stay inside Weles.
  if (isCredentialTrajectory(action) && credsMode !== 'raw') {
    const result = { credential_produced: out.ok && out.result !== null };
    if (!out.ok) result.failure = credentialFailure(out);
    json(res, out.ok ? 200 : 502, {
      ok: out.ok,
      exitCode: out.exitCode,
      action,
      run_id: out.run_id,
      result,
      timed_out: out.timed_out,
      coalesced: admission.joined,
    });
    return;
  }


  // raw mode: return unredacted (creds in the response); redact mode: default.
  json(res, out.ok ? 200 : 502, { ...out, coalesced: admission.joined }, { redact: credsMode !== 'raw' });
}
