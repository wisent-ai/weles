// Which route answers this request, and what a caller is told when none does.
//
// The chain is ordered, not a table, and the order is load-bearing: liveness is
// answered before anything can refuse it, the public task API is offered the
// request next and its own error shape is preserved untouched, and only then do
// the token-authenticated routes get a look. Anything left over is a 404 from
// one place, and any exception from any route becomes one truncated 500 from
// one place, so no route can invent a second way to fail.
//
// Three small route families stay written out here rather than in files of
// their own, because each is the router repeating what it already knows: what
// this build is (liveness), what its resident task dispatcher is doing, and which
// artifact of a finished run may be downloaded. The routes that order a
// trajectory are the ones that carry real subjects of their own, and they live
// beside this file.
//
// The collaborators arrive as arguments because the entry point is the only
// place allowed to resolve modules out of the deployed runtime tree; this file
// never names a path inside it.

import { createReadStream } from 'node:fs';

import { isKeywordPlannerRoute, respondToKeywordPlanner } from '../../../trajectories/google/ads/keyword_planner/api_server.mjs';

import { ALLOW_RAW_CREDS, ALLOW_UNAUTH, HOST, PORT, TOKEN } from '../configuration.mjs';
import { json, readBody, requireTokenAuthorization } from '../http-exchange.mjs';
import { RUN_RELEASE_IDENTITY } from '../release-identity.mjs';
import {
  decodeRunId,
  diagnosticFile,
  diagnosticsContentType,
  diagnosticsManifest,
} from '../run/run-evidence.mjs';
import { createWorkerControl, workerActions } from '../worker-control.mjs';
import { respondToRun } from './run-route.mjs';
import {
  respondToAuthenticatorEnrolment,
  respondToBuilder,
  respondToDocumentImport,
  respondToReauth,
} from './trajectory-routes.mjs';

export function createApiRequestHandler({
  buildDeploymentVersionValue,
  credentialOperationService,
  importWelesTrajectoryDocument,
  publicTaskErrorResponse,
  publicTaskService,
  runTrajectory,
  selectLoginAccount,
  validateAccountSecurityParams,
}) {
  const { controlWorker, workerStatus } = createWorkerControl(publicTaskService);
  // Recovery changes one durable queue. Concurrent control requests are refused.
  let workerControlBusy = false;
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, {
          ok: true,
          source: 'weles_api',
          authConfigured: Boolean(TOKEN || ALLOW_UNAUTH),
          rawCredsAllowed: ALLOW_RAW_CREDS,
          releaseVersion: process.env.WELES_WORKER_RELEASE_VERSION || null,
          releaseSha256: process.env.WELES_WORKER_RELEASE_SHA256 || null,
          // Which sources answer here. A deployer that moved this host to a
          // revision has no other way to prove the process serving the port
          // is the one it built, and `stado workload run weles-api-runtime`
          // used to report a revision from a launchctl restart alone.
          sourceRevision: RUN_RELEASE_IDENTITY.source_revision,
          routes: ['GET /healthz', 'GET /api/v1/version', 'POST /api/v1/credential-operations', 'POST /api/v1/tasks', 'GET /api/v1/tasks/:task_id', 'POST /api/v1/tasks/:task_id/cancel', 'GET /worker/version', 'GET /worker/status', 'POST /worker/start', 'POST /worker/restart', 'POST /run', 'GET /diagnostics/:run_id', 'GET /diagnostics/:run_id/file?path=', 'POST /weles-builder', 'POST /reauth/resolve', 'POST /reauth', 'POST /reauth/enrol-authenticator', 'POST /google-ads/keyword-volume', 'POST /google-ads/keyword-report'],
          publicTask: publicTaskService.health,
          features: ['subscription_identity', 'fresh_profile'],
          account_source: 'skarbiec',
        });
        return;
      }
      const credentialResponse = await credentialOperationService.handle(req, url);
      if (credentialResponse) {
        json(res, credentialResponse.status, credentialResponse.payload, { redact: false });
        return;
      }
      try {
        const publicResponse = await publicTaskService.handle(req, url, readBody);
        if (publicResponse) {
          json(res, publicResponse.status, publicResponse.payload, { redact: false });
          return;
        }
      } catch (error) {
        const publicError = publicTaskErrorResponse(error);
        json(
          res,
          publicError?.status ?? 500,
          publicError?.payload ?? { error: 'internal-error', message: 'public task operation failed' },
          { redact: false },
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/worker/version') {
        if (!requireTokenAuthorization(req, res)) return;
        json(res, 200, { ok: true, identity: buildDeploymentVersionValue() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/worker/status') {
        if (!requireTokenAuthorization(req, res)) return;
        const status = await workerStatus();
        json(res, 200, { ok: true, worker: status });
        return;
      }
      const workerAction = url.pathname.startsWith('/worker/') ? url.pathname.slice('/worker/'.length) : '';
      if (Object.hasOwn(workerActions, workerAction)
          && workerActions[workerAction].mutation && req.method === workerActions[workerAction].method) {
        if (!requireTokenAuthorization(req, res)) return;
        if (workerControlBusy) {
          json(res, 409, { ok: false, error: 'worker_control_in_progress' });
          return;
        }
        workerControlBusy = true;
        try {
          const action = workerAction;
          const out = await controlWorker(action);
          console.log(JSON.stringify({
            event: 'worker_control',
            action,
            ok: out.ok,
            changed: out.changed ?? false,
            remote: req.socket.remoteAddress || null,
            before: out.before,
            after: out.after,
          }));
          const statusCode = out.ok ? 200 : (out.error === 'worker_busy' ? 409 : 502);
          json(res, statusCode, out);
        } finally {
          workerControlBusy = false;
        }
        return;
      }
      const diagnosticFileMatch = /^\/diagnostics\/([^/]+)\/file$/.exec(url.pathname);
      if (req.method === 'GET' && diagnosticFileMatch) {
        if (!requireTokenAuthorization(req, res)) return;
        const runId = decodeRunId(diagnosticFileMatch[1]);
        if (!runId) { json(res, 400, { ok: false, error: 'invalid_run_id' }); return; }
        const file = diagnosticFile(runId, url.searchParams.get('path'));
        if (!file) { json(res, 404, { ok: false, error: 'diagnostic_file_not_found' }); return; }
        res.writeHead(200, {
          'Content-Type': diagnosticsContentType(file.path),
          'Content-Length': String(file.stat.size),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
        return;
      }
      const diagnosticsMatch = /^\/diagnostics\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && diagnosticsMatch) {
        if (!requireTokenAuthorization(req, res)) return;
        const runId = decodeRunId(diagnosticsMatch[1]);
        if (!runId) { json(res, 400, { ok: false, error: 'invalid_run_id' }); return; }
        const manifest = diagnosticsManifest(runId);
        if (!manifest) { json(res, 404, { ok: false, error: 'diagnostics_not_found' }); return; }
        json(res, 200, manifest);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/imports') {
        await respondToDocumentImport(req, res, importWelesTrajectoryDocument);
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/reauth' || url.pathname === '/reauth/resolve')) {
        await respondToReauth(req, res, selectLoginAccount, url.pathname === '/reauth/resolve');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/reauth/enrol-authenticator') {
        await respondToAuthenticatorEnrolment(req, res, selectLoginAccount, runTrajectory);
        return;
      }
      if (isKeywordPlannerRoute(req, url)) {
        await respondToKeywordPlanner(req, res, url);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/weles-builder') {
        await respondToBuilder(req, res, runTrajectory);
        return;
      }
      if (!(req.method === 'POST' && url.pathname === '/run')) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      await respondToRun(req, res, runTrajectory, validateAccountSecurityParams);
    } catch (error) {
      json(res, 500, { ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
    }
  };
}
