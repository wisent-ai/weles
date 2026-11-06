// The routes that order one named trajectory rather than one the caller
// names itself.
//
// POST /run takes an action and its parameters and is elsewhere. These each
// decide the action on the caller's behalf, and each has its own idea of
// who may ask. /imports does not run anything at all: it validates a trajectory
// document and persists it against a host, so a draft becomes an action /run
// can later name. /reauth is admitted by Brama's own token and never by the
// general API token, because it spends a real browser sign-in on exactly one
// vault row and the broker -- not the operator -- decides which.
// /reauth/enrol-authenticator (trajectory/authenticator-enrolment.mjs) is
// admitted the same way, through the same account admission
// (trajectory/reauth-account.mjs). /weles-builder (trajectory/builder.mjs)
// takes prose instead of parameters and its answer is a new reusable
// trajectory.
//
// They share one refusal: a request that names an account it is not entitled
// to, or a provider Weles does not run on the host, is answered before any
// child is spawned.

import { constants as http } from 'node:http2';
import {
  json,
  readBody,
  requireTokenAuthorization,
} from '../http-exchange.mjs';
import { runAdmissionKey } from '../run/run-outcome.mjs';
import { runReauth } from '../run/process/reauth-process.mjs';
import { admittedReauthAccount } from './trajectory/reauth-account.mjs';
import { answerRefusal } from './trajectory/refusal.mjs';
import { streamRun } from './trajectory/progress.mjs';

/** The message of a failure, whatever was thrown. */
function failure(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function respondToDocumentImport(
  req,
  res,
  importWelesTrajectoryDocument,
) {
  if (!requireTokenAuthorization(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    json(res, http.HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: failure(error),
    });
    return;
  }
  let report;
  try {
    report = await importWelesTrajectoryDocument(body.source, body.target_host);
  } catch (error) {
    json(res, http.HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: failure(error),
    });
    return;
  }
  // A report that imported any document created it; one that imported
  // none answers what it found unchanged or refused.
  json(
    res,
    report.imported ? http.HTTP_STATUS_CREATED : http.HTTP_STATUS_OK,
    report,
  );
}

// Resolve a Skarbiec subscription first; /reauth/resolve never starts a browser.
export async function respondToReauth(
  req,
  res,
  selectLoginAccount,
  resolveOnly,
) {
  let admitted;
  try {
    admitted = await admittedReauthAccount(
      req,
      selectLoginAccount,
      'authentication',
    );
  } catch (error) {
    answerRefusal(res, error);
    return;
  }
  const { account, identity, provider } = admitted;
  if (resolveOnly) {
    json(res, http.HTTP_STATUS_OK, {
      ok: true,
      source: 'skarbiec',
      ...identity,
    });
    return;
  }
  // An admitted sign-in answers as it goes (trajectory/progress.mjs); its
  // result is the run's own outcome, refreshed when it succeeded.
  await streamRun(res, {
    key: runAdmissionKey('reauth', {
      provider,
      login_item: account.loginItem,
      subscription_id: account.subscriptionId,
      account_revision: account.accountRevision,
    }),
    identity,
    start: (publish) => runReauth(provider, account, publish),
    failed: (error) => ({
      ok: false,
      error: 'reauth_run_failed',
      message: failure(error),
    }),
    result: (out) => ({ ...out, refreshed: out.ok }),
  });
}
