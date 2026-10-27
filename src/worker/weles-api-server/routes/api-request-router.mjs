// Which route answers this request, and what a caller is told when none does.
//
// The chain is ordered, not a table, and the order is load-bearing: liveness is
// answered before anything can refuse it, the public task API is offered the
// request next and its own error shape is preserved untouched, and only then do
// the token-authenticated routes get a look. Anything left over is a Not Found
// from one place, and any exception from any route becomes one Internal Server
// Error naming its cause, from one place, so no route can invent a second way
// to fail.
//
// The collaborators arrive as arguments because the entry point is the only
// place allowed to resolve modules out of the deployed runtime tree; this file
// never names a path inside it.

import { constants as http } from 'node:http2';

import {
  isKeywordPlannerRoute,
  respondToKeywordPlanner,
} from '../../../trajectories/google/ads/keyword_planner/api_server.mjs';

import { HOST, PORT } from '../configuration.mjs';
import { json, readBody } from '../http-exchange.mjs';
import { isPageRoute, respondToPage } from './pages/index.mjs';
import { isRecordRoute, respondToRecord } from './records/index.mjs';
import { isKeeperRoute, respondToKeeper } from './keepers/index.mjs';
import {
  isCaptchaAnswerRoute,
  respondToCaptchaAnswer,
} from './captcha/answers.mjs';
import { respondToRun } from './run-route.mjs';
import { isRunsRoute, respondToRuns } from './runs.mjs';
import {
  respondToDocumentImport,
  respondToReauth,
} from './trajectory-routes.mjs';
import { respondToAuthenticatorEnrolment } from './trajectory/authenticator-enrolment.mjs';
import { respondToBuilder } from './trajectory/builder.mjs';
import {
  respondToAccounts,
  respondToAcquire,
  respondToAuthorize,
} from './subscriptions/account-routes.mjs';
import { isHealthRoute, respondToHealth } from './service/health.mjs';
import {
  isDiagnosticsRoute,
  respondToDiagnostics,
} from './service/diagnostics.mjs';
import { createWorkerRoutes } from './service/worker.mjs';

/** The message of a failure, whatever was thrown. */
function failure(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createApiRequestHandler({
  buildDeploymentVersionValue,
  credentialOperationService,
  importWelesTrajectoryDocument,
  publicTaskErrorResponse,
  pageBrowser,
  accountRecords,
  publicTaskService,
  runTrajectory,
  listLoginAccounts,
  selectLoginAccount,
  validateAccountSecurityParams,
  validateAppPasswordParams,
}) {
  const { isWorkerRoute, respondToWorker } = createWorkerRoutes(
    publicTaskService,
    buildDeploymentVersionValue,
  );
  // Only the address's path and query are read; the origin is this worker's.
  const origin = `http://${HOST}:${PORT}`;

  /** Whether a token-authenticated route answered the request. */
  async function answeredByRoute(req, res, url) {
    const post = req.method === 'POST';
    if (isCaptchaAnswerRoute(req, url))
      await respondToCaptchaAnswer(req, res, url);
    else if (isWorkerRoute(req, url)) await respondToWorker(req, res, url);
    else if (isKeeperRoute(url.pathname)) await respondToKeeper(req, res, url);
    else if (isDiagnosticsRoute(req, url))
      await respondToDiagnostics(req, res, url);
    else if (isRunsRoute(req, url)) await respondToRuns(req, res, url);
    else if (post && url.pathname === '/imports')
      await respondToDocumentImport(req, res, importWelesTrajectoryDocument);
    else if (post && url.pathname === '/reauth')
      await respondToReauth(req, res, selectLoginAccount, false);
    else if (post && url.pathname === '/reauth/resolve')
      await respondToReauth(req, res, selectLoginAccount, true);
    else if (post && url.pathname === '/reauth/enrol-authenticator')
      await respondToAuthenticatorEnrolment(
        req,
        res,
        selectLoginAccount,
        runTrajectory,
      );
    else if (post && url.pathname === '/subscriptions/acquire')
      await respondToAcquire(req, res);
    else if (post && url.pathname === '/reauth/authorize')
      await respondToAuthorize(req, res, selectLoginAccount);
    else if (post && url.pathname === '/reauth/accounts')
      await respondToAccounts(req, res, listLoginAccounts);
    else if (isPageRoute(req, url))
      await respondToPage(req, res, url, pageBrowser);
    else if (isRecordRoute(req, url))
      await respondToRecord(req, res, url, accountRecords);
    else if (isKeywordPlannerRoute(req, url))
      await respondToKeywordPlanner(req, res, url);
    else if (post && url.pathname === '/weles-builder')
      await respondToBuilder(req, res, runTrajectory);
    else if (post && url.pathname === '/run')
      await respondToRun(
        req,
        res,
        runTrajectory,
        validateAccountSecurityParams,
        validateAppPasswordParams,
      );
    else return false;
    return true;
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (isHealthRoute(req, url)) {
        respondToHealth(res, publicTaskService.health);
        return;
      }
      const credentialResponse = await credentialOperationService.handle(
        req,
        url,
      );
      if (credentialResponse) {
        json(res, credentialResponse.status, credentialResponse.payload, {
          redact: false,
        });
        return;
      }
      let publicResponse;
      try {
        publicResponse = await publicTaskService.handle(req, url, readBody);
      } catch (error) {
        // The public task API's own refusals keep its error shape; any other
        // failure is this worker's and answered below with its cause.
        const publicError = publicTaskErrorResponse(error);
        if (!publicError) throw error;
        json(res, publicError.status, publicError.payload, { redact: false });
        return;
      }
      if (publicResponse) {
        json(res, publicResponse.status, publicResponse.payload, {
          redact: false,
        });
        return;
      }
      if (await answeredByRoute(req, res, url)) return;
      json(res, http.HTTP_STATUS_NOT_FOUND, { ok: false, error: 'not_found' });
    } catch (error) {
      json(res, http.HTTP_STATUS_INTERNAL_SERVER_ERROR, {
        ok: false,
        error: failure(error),
      });
    }
  };
}
