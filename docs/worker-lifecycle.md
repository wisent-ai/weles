# Execution model

How does admitted work reach a host and execute now? There is no polling
worker anymore: the queue-and-creds merge deleted the database-polled loop
(see [What was removed](#what-was-removed)). Current main has exactly two
execution paths — a **Stado job queue** for asynchronous work and a
**localhost HTTP API** for synchronous work — and both converge on the same
two functions, `resolveTrajectory` and `paramsToEnv`
(`src/worker/dispatch.ts`), so a job runs byte-identically either way. State
(accounts, settings, run records) lives in Skarbiec vault items
(`src/state/skarbiec-records.ts`), not a database.

## Queued execution: Stado jobs

Enqueueing is one `stado submit`. Both enqueue helpers —
`enqueueAction` (`src/state/skarbiec-records.ts`) and `enqueueWelesAction`
(`scripts/_shared/stado-action-queue.mjs`) — encode `{action, accountItem,
params}` as one base64url JSON argument and submit
`node ~/weles/scripts/worker/stado-action-runner.mjs <payload>` through the
Stado CLI (`~/.stado/bin/stado`, override `WELES_STADO_BIN`). The shared
helper also accepts `--priority` and `--pinned-host`. Both refuse a malformed
action name (`invalid Weles action: <action>`) and a malformed account item
(`invalid Weles account item` / `accountItem must be an exact Weles Skarbiec
item id`); the shared helper additionally refuses non-object params (`params
must be an object`). Both require a job id back: a submission whose stdout
carries no 8-hex job id fails with `Stado returned no job id for <action>` /
`Stado accepted <action> but returned no job id`, and a non-zero
`stado submit` fails with `Stado refused <action>: <stderr>` /
`Stado refused Weles action <action>: <stderr>`.

On the host, Stado runs `scripts/worker/stado-action-runner.mjs`, which
re-validates the payload from scratch and refuses with these exact errors
(each exits 1):

| Check | Error |
|---|---|
| argv[2] is one base64url token | `one base64url action payload is required` |
| `action` matches `^[a-z][a-z0-9_]{0,127}$` | `invalid Weles action` |
| `accountItem`, when set, matches `^weles-[a-z0-9][a-z0-9-]{0,126}$` | `invalid Weles account item` |
| `params` is a plain object (not an array) | `invalid Weles action params` |
| `resolveTrajectory(action)` returns a path | `no Weles trajectory for <action>` |

A valid payload resolves through `dist/worker/dispatch.js`; `accountItem` is
merged into params as `login_item`, and a `delay_ms` param sleeps before the
spawn (capped at 24 hours). The runner then spawns `node <trajectory>` from
the repo root with inherited stdio and this environment: the runner's own
env, plus `paramsToEnv(params, action, trajectory)`, plus
`WSESSION_LABEL=<action>` and `ACTION_LOG_ID` taken from `WC_JOB_ID` or
`STADO_JOB_ID` (empty when neither is set) — so the run's recordings tree is
keyed to the Stado job id.

Termination is honest by construction: `SIGINT`/`SIGTERM` sent to the runner
are forwarded to the trajectory subprocess; a child killed by a signal makes
the runner re-raise that same signal on itself; otherwise the runner's exit
code is the child's exit code (`?? 1`). The Stado job's terminal status is
therefore the trajectory's own.

## Synchronous execution: the Weles HTTP API

`scripts/worker/weles-api-server.mjs` is a transport wrapper that runs a
trajectory and returns the result in the HTTP response — no queue roundtrip.
It listens on `WELES_API_HOST` (default `127.0.0.1`) and `WELES_API_PORT`
(default `8788`), and reuses the worker's own `resolveTrajectory` +
`paramsToEnv` from `dist/`.

Auth: every route except `GET /healthz` requires `WELES_API_TOKEN` (or
`WELES_CONSOLE_API_TOKEN`) as `Authorization: Bearer <token>` or
`x-api-key`. With no token configured, guarded routes answer HTTP 500
`missing_WELES_API_TOKEN`; a wrong token answers 401 `unauthorized`.
`WELES_API_ALLOW_UNAUTH=1` waives auth for `/run`, `/reauth`, and
`/weles-builder` only — the `/worker/*` and `/diagnostics/*` routes always
demand the token (`requireTokenAuthorization`).

| Route | Purpose |
|---|---|
| `GET /healthz` | liveness + config summary (routes, features, login items) |
| `POST /run` | synchronous trajectory execution |
| `GET /diagnostics/:run_id` | artifact manifest of `recordings/<run_id>/` |
| `GET /diagnostics/:run_id/file?path=` | artifact download (symlink-refusing, root-confined) |
| `GET /worker/version` | running deployment identity (below) |
| `GET /worker/status` | launchd worker state |
| `POST /worker/start` | idempotent launchd worker start |
| `POST /worker/restart` | forced launchd worker restart |
| `POST /weles-builder` | instructions-only generic browser task |
| `POST /reauth` | run a provider reauth trajectory on the host (`codex`\|`claude`\|`kimi`) |

`POST /run` takes `{action, params?, account_id?, creds?, timeout_ms?,
detached?}` (body limit `WELES_API_BODY_LIMIT_BYTES`, default 262144 bytes).
The run times out after `timeout_ms`, default `WELES_API_TIMEOUT_MS`
(900000 ms = 15 minutes): SIGTERM, then SIGKILL 8 seconds later, reported as
`exitCode: 137, timed_out: true`. An unresolvable action answers 404
`no_trajectory`. `detached: true` answers 202 immediately and writes the
finished result to `~/.stado/weles-detached-runs/<id>.json`, so a run that
outlives the caller's socket still records its answer.

The `creds` field picks one of three result modes (default `redact`):

| Mode | Behavior |
|---|---|
| `redact` | response passes through the secret-shape redactor (`redactSecrets`) |
| `raw` | response returned unredacted; gated by `WELES_API_ALLOW_RAW_CREDS` (default `1`; `raw` with it off answers 403 `raw_creds_forbidden`) |
| `store` | extracted credentials are persisted (`scripts/lib/service_credentials.mjs`) and only `{credential_id, provider, login_email, has_password}` is returned |

Anything else answers 400 `creds must be redact|raw|store`. How the result
document is assembled is in [workflows](workflows.md#result-assembly).

The worker-control routes drive a launchd agent on macOS only (elsewhere:
501 `worker_control_requires_macos`): label
`com.wisent.weles-worker` (`WELES_WORKER_LAUNCHD_LABEL`), plist
`~/Library/LaunchAgents/<label>.plist` (`WELES_WORKER_LAUNCHD_PLIST`). An
unloaded agent is `launchctl bootstrap`ped from the plist (missing plist:
`worker_launchagent_plist_missing`); a loaded one is `kickstart`ed (`-k` for
restart). One control action runs at a time (409
`worker_control_in_progress`), and success requires observing the agent
running within 5 seconds, else `worker_not_running_after_control_action`.

## Deployment-version identity

`buildDeploymentVersionValue` (`src/worker/deployment_version.ts`) is the
running release identity, served at `GET /worker/version`. It always reports
`source: 'weles-worker'`, an `instance_id` (`WELES_INSTANCE_ID`,
`INSTANCE_ID`, or `weles-<hostname>-<pid>`), a `deployment` block (package
version, commit, branch, dirty flag, dist SHA-256, trajectories-tree SHA-256,
runner-entry SHA-256, start time — from `src/diagnostics/versions.ts`), and a
`runner` block (host, user, Node version, pid, platform, arch). When the
twelve `WELES_WORKER_VERSION` … `WELES_API_SCHEMAS` release env vars are set,
it adds a `release` block (`weles.release-identity.v2`) — all twelve or none
(`immutable release identity is partially configured`), a real ring name
(`WELES_DEPLOYMENT_RING must name a release ring`), `WELES_CLAIMS_ENABLED`
of `0`/`1`, and `only the production release ring may claim queued work`.
`startDeploymentVersionHeartbeat` writes this value to the Skarbiec setting
`weles_deployment_version` (non-production rings write
`weles_deployment_version_<ring>_<instance>`) every 60 s by default
(`WELES_DEPLOYMENT_VERSION_HEARTBEAT_MS`).

## Artifact upload and delivery

`uploadArtifacts` (`src/worker/upload-artifacts.ts`) mirrors the entire
`recordings/<run-id>/` tree — no extension allowlist, no per-kind cap — to
private Stado objects at `stado://weles/recordings/<run-id>/…` through
`PUT /api/object` on `STADO_API_URL`, authenticated by
`WELES_STADO_OBJECT_API_TOKEN` (at least 32 bytes, distinct from every
sibling token). Locators are bucketed as `screenshots`, `videos`, `dom`, and
`logs`, and a locator may be published only after Stado acknowledges the
exact canonical URI of every object. A completed mirror writes an
`.uploaded.json` proof into the run directory; the Stado recordings cleaner
requires that proof before deleting the local tree.

Reading evidence back is a separate signed-URL service
(`src/worker/artifact-delivery.ts`, client:
`src/worker/artifact-delivery-client.ts`): `POST /v1/artifacts/sign`
exchanges canonical `stado://weles/recordings/…` locators for
HMAC-SHA256-signed `GET /v1/artifacts/object` URLs with a bounded TTL
(`WELES_ARTIFACT_URL_TTL_SECONDS`, 30–300 s), verified in constant time.
Its config fails closed: every token must be present, at least 32 bytes,
and pairwise distinct (`Weles artifact, subscription, and Stado credentials
must be distinct`).

## What was removed

The queue-and-creds merge deleted the database-polled worker and all its
gates: `scripts/worker/run.mjs`, the launchers, and
`src/worker/{claim,poll,verification,stale,schema_compatibility,identity,placement-policy,credential-completion}.ts`
went in commit `f792637b` ("Remove database-polled Weles worker"), and the
Weles database runtime went in `ceb85c7e` ("Remove Weles database runtime").
What remains under `src/worker/` is exactly `dispatch.ts`,
`deployment_version.ts`, `artifact-delivery.ts`,
`artifact-delivery-client.ts`, `upload-artifacts.ts`, and
`capture-params.ts`. Release publication, manifests, and ring promotion are
unchanged and live in [releases](releases.md).

The env vars named here are collected in [configuration](configuration.md).
