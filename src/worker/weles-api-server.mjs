// Weles HTTP API — synchronous trajectory runner.
//
// Purpose: run a Weles trajectory synchronously and return its result without
// an external queue roundtrip. It reuses the worker's own resolveTrajectory and
// paramsToEnv implementation so the action is identical to the queued path.
//
// It spawns the same trajectory child the worker spawns. On macOS, when the
// API is a system LaunchDaemon and a GUI login exists, that child enters the
// user's GUI bootstrap before it starts. Trajectory logic stays unchanged.
//
// Credential modes (POST /run field "creds", default "redact"):
//   "redact"  -> result passes through the secret-shape redactor (default;
//                a login/register trajectory cannot exfiltrate a token).
//   "raw"     -> result returned UNREDACTED (raw creds in the response). Gated
//                by WELES_API_ALLOW_RAW_CREDS (default "1"; set "0" to forbid).
//   "store"   -> Weles persists the extracted creds into service_credentials
//                (the entitlements-router source of truth) and returns ONLY a
//                reference { credential_id, provider, login_email, has_password }
//                — no raw run output leaves the process.
//
//   WELES_API_TOKEN  (or WELES_CONSOLE_API_TOKEN) required for the general API
//   BRAMA_WELES_REAUTH_TOKEN required for Brama's POST /reauth admission
//   WELES_API_HOST   default 127.0.0.1  (set 0.0.0.0 to expose on the LAN/Tailscale)
//   WELES_API_PORT   default 8788       (keyword-planner-api already owns 8787)
//   WELES_API_TIMEOUT_MS  default 900000
//   WELES_API_BODY_LIMIT_BYTES default 262144
//   WELES_API_ALLOW_RAW_CREDS  default "1"
//   WELES_API_BASE, WELES_TOKEN, WISENT_ORGANIZATION_ID for destination imports
//   plus the worker browser, proxy, Stado, and Skarbiec configuration
//
// Routes:
//   GET  /healthz                         -> liveness + config summary
//   POST /run                             -> synchronous trajectory execution
//   POST /imports                         -> validate and persist host-bound draft trajectories
//   GET  /diagnostics/:run_id             -> authenticated artifact manifest
//   GET  /diagnostics/:run_id/file?path=  -> authenticated artifact download
//   GET  /worker/status                   -> authenticated launchd worker state
//   POST /worker/start                    -> authenticated idempotent start
//   POST /worker/restart                  -> authenticated forced restart
//
// What this file keeps is the release boundary and the process. It is the only
// module allowed to name a path inside the deployed runtime tree: the six
// compiled modules below are resolved here, in this order, before anything is
// composed, and release/stado-launcher.sh's `runtime_required` list is the
// mirror of exactly these paths — a runtime marked ready without one of them
// must die here rather than on its first request. Everything those modules are
// needed for is handed the resolved function by name, so no descendant has to
// reach into the release tree to get it.
//
// The rest is composition and lifetime: the public task service is assembled
// from the pieces it is not allowed to construct itself, the request handler is
// assembled from the routes, the port is bound, and a termination signal drains
// public tasks before the process exits. `weles-api-server/` holds the
// subjects: what release this is, what the environment configured, who is
// admitted and what an answer may contain, what the launchd worker is doing,
// which published service this host may be, what a run leaves behind and how
// its child is supervised, and which route answers a request.

import http from 'node:http';

import { REPO, RUN_RELEASE_IDENTITY } from './weles-api-server/release-identity.mjs';

const { resolveTrajectory, paramsToEnv } = await import(`${REPO}/dist/worker/dispatch.js`);
const { buildDeploymentVersionValue } = await import(`${REPO}/dist/worker/deployment_version.js`);
// Account selection is one table shared with the queued path and the
// trajectories, so /reauth, /run and a hand-run trajectory all resolve the same
// vault login item id to the same account.
const { LOGIN_ACCOUNTS, selectLoginAccount } = await import(`${REPO}/dist/utils/login-accounts.js`);
const { readPrivateStadoObjectIdentity, uploadArtifacts } = await import(`${REPO}/dist/worker/upload-artifacts.js`);
const { resolveBrowserEvidenceTarget, SPIS_BROWSER_EVIDENCE_POLICY } = await import(`${REPO}/dist/agent/browser-evidence-policy.js`);
const { createPublicTaskService, publicTaskErrorResponse } = await import('./public-task-service.mjs');
const { importWelesTrajectoryDocument } = await import(`${REPO}/dist/import.js`);

const {
  ALLOW_RAW_CREDS,
  ALLOW_UNAUTH,
  HOST,
  PORT,
  PUBLIC_TASK_CONCURRENCY,
  PUBLIC_TASK_TIMEOUT_MS,
  RECORDINGS_ROOT,
  RUN_RESULTS_DIR,
  TOKEN,
} = await import('./weles-api-server/configuration.mjs');
const { redactSecrets } = await import('./weles-api-server/http-exchange.mjs');
const { publicTaskChildEnvironment, readPublicServiceIdentity } = await import('./weles-api-server/public-admission.mjs');
const { createTrajectoryRunner } = await import('./weles-api-server/run/trajectory-process.mjs');
const { createApiRequestHandler } = await import('./weles-api-server/routes/api-request-router.mjs');

const runTrajectory = createTrajectoryRunner({ resolveTrajectory, paramsToEnv });

const publicTaskService = createPublicTaskService({
  environment: process.env,
  policy: SPIS_BROWSER_EVIDENCE_POLICY,
  runResultsRoot: RUN_RESULTS_DIR,
  recordingsRoot: RECORDINGS_ROOT,
  releaseIdentity: RUN_RELEASE_IDENTITY,
  uploadArtifacts,
  readArtifactIdentity: readPrivateStadoObjectIdentity,
  redact: redactSecrets,
  concurrency: PUBLIC_TASK_CONCURRENCY,
  taskTimeoutMs: PUBLIC_TASK_TIMEOUT_MS,
  trajectoryReady: Boolean(resolveTrajectory('generic_browser_task')),
  artifactRetentionReady: Boolean(
    process.env.STADO_API_URL
      && process.env.WELES_STADO_OBJECT_API_TOKEN
      && Buffer.byteLength(process.env.WELES_STADO_OBJECT_API_TOKEN) >= 32
  ),
  readServiceIdentity: readPublicServiceIdentity,
  resolveTarget: resolveBrowserEvidenceTarget,
  runTrajectory: ({ action, params, runId, signal, policy, networkTarget }) => runTrajectory(
    action,
    params,
    null,
    true,
    PUBLIC_TASK_TIMEOUT_MS,
    {
      runId,
      signal,
      childEnvironment: publicTaskChildEnvironment(policy, networkTarget),
    },
  ),
});
await publicTaskService.recover();


const server = http.createServer(createApiRequestHandler({
  buildDeploymentVersionValue,
  importWelesTrajectoryDocument,
  LOGIN_ACCOUNTS,
  publicTaskErrorResponse,
  publicTaskService,
  runTrajectory,
  selectLoginAccount,
}));

server.listen(PORT, HOST, () => {
  console.log(`[weles-api] listening http://${HOST}:${PORT} auth=${Boolean(TOKEN || ALLOW_UNAUTH)} rawCreds=${ALLOW_RAW_CREDS}`);
});

let shutdownStarted = false;
async function shutdownApi(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[weles-api] draining public tasks after ${signal}`);
  server.close();
  const forcedExit = setTimeout(() => process.exit(1), 30_000);
  forcedExit.unref();
  await publicTaskService.shutdown();
  clearTimeout(forcedExit);
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdownApi('SIGTERM'); });
process.on('SIGINT', () => { void shutdownApi('SIGINT'); });
