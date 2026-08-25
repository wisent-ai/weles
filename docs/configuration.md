# Configuration

Which environment variables does Weles actually read, and where? This page
enumerates every variable with a live reader on current main across `src/`,
`scripts/worker/`, `scripts/release/`, and `scripts/_shared/`, plus the
browser install scripts and `auto-deploy.sh` those sections depend on. There
is no database configuration: accounts, settings, and run records live in
Skarbiec vault items (`src/state/skarbiec-records.ts`). Secrets are still
configured nowhere — credentials resolve at runtime through Skarbiec
acquisition ([authorization](authorization.md)); the env names below that
carry tokens are the slots acquisition fills, not values an operator types.

Two honest boundaries. Trajectory parameters also arrive as environment
variables, but through `paramsToEnv` (`src/worker/dispatch.ts`) — those are
per-run workflow inputs, not configuration, and are covered in
[workflows](workflows.md). And the deploy helper shell scripts under
`scripts/worker/deploy/` read additional shell variables local to their own
invocation (e.g. `WELES_PLACEMENT_POLICY_FILE`, `WELES_DELIVERY_DIR`); only
the operator-facing `auto-deploy.sh` set is tabulated here. Standard process
variables (`HOME`, `PATH`, `USER`, `TEMP`/`TMPDIR`) are used as fallbacks
throughout and are not listed per file.

## Caller (client) environment

Consumed by your own service and the public verifier, not by the Weles host
(`README.md`, `weles-client/bin/weles-skarbiec-acquire.mjs`,
`weles-client/bin/weles-skarbiec-acquire-admission.mjs`):

| Variable | Meaning |
|---|---|
| `WELES_API_BASE` | Deployment endpoint your code passes to `WelesClient` (README example; read by your service, not by Weles) |
| `WELES_TOKEN` | Organization-scoped bearer; required by the acquire helper, optional for admission on an unauthenticated loopback server |
| `WISENT_ORGANIZATION_ID` | Organization UUID; required by the acquire helper |

## Synchronous execution API

The localhost HTTP server (`scripts/worker/weles-api-server.mjs`) serves
`GET /healthz`, `POST /run`, `GET /diagnostics/:run_id`, and the `/worker/*`
control routes, reusing the same `resolveTrajectory` + `paramsToEnv` as the
queued path:

| Variable | Default | Meaning |
|---|---|---|
| `WELES_API_HOST` | `127.0.0.1` | Bind address; `0.0.0.0` exposes on the LAN/Tailscale |
| `WELES_API_PORT` | `8788` | TCP port (`8787` is owned by keyword-planner-api) |
| `WELES_API_TOKEN` | none | Bearer / `x-api-key` value; unset without unauth mode, guarded routes answer `missing_WELES_API_TOKEN` |
| `WELES_CONSOLE_API_TOKEN` | none | Fallback token when `WELES_API_TOKEN` is unset |
| `WELES_API_ALLOW_UNAUTH` | unset | `1` skips auth on `/run`-class routes; diagnostics and worker control still require the token |
| `WELES_API_ALLOW_RAW_CREDS` | `1` | `0` forbids `creds: "raw"` responses (`raw_creds_forbidden`) |
| `WELES_API_TIMEOUT_MS` | `900000` | Synchronous run timeout |
| `WELES_API_BODY_LIMIT_BYTES` | `262144` | Request body cap |
| `WELES_BUILDER_BOOTSTRAP_URL` | `https://duckduckgo.com/` | Neutral landing page prepended to `/weles-builder` instructions |
| `WELES_WORKER_LAUNCHD_LABEL` | `com.wisent.weles-worker` | launchd label the `/worker/*` routes control |
| `WELES_WORKER_LAUNCHD_PLIST` | `~/Library/LaunchAgents/<label>.plist` | Plist path for `/worker/start` bootstrap |

Runs spawned by this server default `WELES_FULL_DIAGNOSTICS` to `1` in the
child environment unless the operator already set it.

## Queued execution (Stado jobs)

Enqueue runs `stado submit "node scripts/worker/stado-action-runner.mjs
<base64url-payload>"` (`scripts/_shared/stado-action-queue.mjs`,
`enqueueAction` in `src/state/skarbiec-records.ts`); the runner validates the
payload and spawns the trajectory:

| Variable | Read in | Default | Meaning |
|---|---|---|---|
| `WELES_STADO_BIN` | `scripts/_shared/stado-action-queue.mjs`, `src/state/skarbiec-records.ts`, `src/secrets/scoped-service.ts`, `scripts/_shared/scoped-secrets.mjs`, `scripts/worker/deploy/weles-skarbiec-local.mjs` | `~/.stado/bin/stado` | Stado CLI used to submit and inspect queued actions |
| `WC_JOB_ID` / `STADO_JOB_ID` | `scripts/worker/stado-action-runner.mjs`, `scripts/_shared/keeper/bookkeeping.mjs` | empty | Stado-assigned job id, forwarded to the trajectory as `ACTION_LOG_ID` |

## State: Skarbiec vault and Stado CLI

| Variable | Read in | Default | Meaning |
|---|---|---|---|
| `SKARBIEC_BIN` | `src/state/skarbiec-records.ts`, `scripts/release/lib.mjs`, `scripts/worker/deploy/weles-skarbiec-local.mjs` | `~/.stado/bin/skarbiec` | Skarbiec CLI holding accounts, settings, and run records |
| `SKARBIEC_VAULT_FILE` | `src/state/skarbiec-records.ts` | `~/.stado/skarbiec.vault.json` | Vault file those records live in |
| `STADO_BIN` | `src/session/service-placement.ts`, `scripts/_shared/keeper/service-placement.mjs` (default `~/.local/bin/stado`); `scripts/release/activate.mjs`, `scripts/release/status.mjs` (default `stado` on `PATH`) | see left | Stado CLI for service placement and release activation |

## Skarbiec workload identity and scoped secrets

Per-field acquisition is signed by a registered workload identity
(`src/secrets/scoped-service.ts`, `src/utils/capability.ts`,
`scripts/_shared/scoped-secrets.mjs`, `scripts/worker/deploy/skarbiec-acquire.mjs`;
[credential-operations](credential-operations.md)):

| Variable | Default | Meaning |
|---|---|---|
| `SKARBIEC_WORKLOAD_ID` | none (required) | Nonsecret workload identity, ≤128 chars, no whitespace/control chars |
| `SKARBIEC_WORKLOAD_SIGNING_KEY_FILE` | none (required) | Absolute path to the owner-only Ed25519 key signing acquisition and capability proofs |
| `SKARBIEC_CAP_SOCKET` | none (required for capability redeem) | Absolute path to the capability broker Unix socket (`src/utils/capability.ts`) |
| `WELES_SKARBIEC_URL` | none | Skarbiec endpoint; unset raises `WELES_SKARBIEC_URL is required for exact Weles service secret resolution` |
| `WELES_SKARBIEC_TENANTS_DIR` | `~/.stado/weles-skarbiec-tenants` | Per-tenant endpoint/token root; must be absolute |
| `SKARBIEC_WELES_ACQUISITION_SCOPES_FILE` | deployed `skarbiec-acquisition-scopes.conf` | Scope catalog; the file uses one exact `consumer\|item\|field` row per grant, no wildcards (`scripts/worker/deploy/skarbiec-acquisition-scopes.conf`) |
| `SKARBIEC_WELES_READER_ACQUIRE_COMMAND` | deployed `skarbiec-acquire.mjs` | Helper that performs a scoped read |
| `SKARBIEC_WELES_WRITER_COMMAND` | `~/weles/scripts/worker/deploy/skarbiec-write.mjs` | Helper that performs a scoped write (`src/secrets/scoped-service.ts`) |
| `SKARBIEC_CREDENTIAL_RETURN_COMMAND` | none (required when returning) | Absolute, owner-owned, owner-executable binary for credential return (`src/secrets/skarbiec-return.ts`) |
| `SKARBIEC_SYNC_DIR` | unset | When set, credential return sync-pulls/pushes the vault repo (`src/secrets/skarbiec-return.ts`); `auto-deploy.sh` also syncs it when `SKARBIEC_SYNC_REMOTE` is set |
| `SKARBIEC_SYNC_REMOTE` | unset | Git remote for the vault sync clone (`scripts/worker/deploy/auto-deploy.sh`) |
| `WELES_MICROSOFT_WRITER_TOKEN_FILE` | none (required for submit/resume) | Owner-only writer token file for the Microsoft credential flow (`scripts/worker/deploy/weles-skarbiec-local.mjs`) |
| `WELES_WORKER_ENV_FILES` | `~/weles/var/worker-content.env:~/.config/weles/worker.env:~/.weles/secrets.env:~/.stado/weles-model.env` | Colon-separated env files searched for the worker API bearer, later file wins (`scripts/worker/deploy/weles-skarbiec-local.mjs`) |

## Acquired service credentials

These env names are filled by scoped acquisition at startup; do not set them
by hand — provision the scope (`scripts/worker/deploy/README.md`). Readers
validate hard: artifact and object tokens must be ≥32 bytes and pairwise
distinct from each other and from the Brama credentials.

| Variable | Read in | Meaning |
|---|---|---|
| `STADO_API_URL` | `src/worker/upload-artifacts.ts`, `src/worker/artifact-delivery.ts` | Stado object API origin; missing raises `missing required STADO_API_URL` |
| `WELES_STADO_OBJECT_API_TOKEN` | same | Object-store token for run evidence upload |
| `WELES_ARTIFACT_DELIVERY_HOST` / `WELES_ARTIFACT_DELIVERY_PORT` | `src/worker/artifact-delivery.ts` | Bind address and TCP port of the signed artifact-URL listener |
| `WELES_ARTIFACT_DELIVERY_URL` | `src/worker/artifact-delivery.ts`, `src/worker/artifact-delivery-client.ts` | Public origin of that listener; HTTPS except loopback |
| `WELES_ARTIFACT_DELIVERY_TOKEN` | same | Client bearer for URL signing requests |
| `WELES_ARTIFACT_SIGNING_SECRET` | `src/worker/artifact-delivery.ts` | HMAC secret behind signed download URLs |
| `WELES_ARTIFACT_URL_TTL_SECONDS` | `src/worker/artifact-delivery.ts` | Signed-URL lifetime; default `300`, allowed 30–300 |
| `WELES_ARTIFACT_ALLOWED_ORIGIN` | `src/worker/artifact-delivery.ts` | Optional single CORS origin |
| `OKO_WELES_SUBSCRIPTIONS_TOKEN` | `src/worker/artifact-delivery.ts` | Oko subscriptions bearer served by the listener |
| `WELES_STADO_MEDIA_ROUTER_TOKEN` | `src/agent/jeden.ts`, `src/worker/upload-artifacts.ts`, `src/worker/artifact-delivery.ts` | Read only for credential-distinctness checks |

## Model routing

The trajectory writer and in-run agent calls go through the Jeden CLI against
Brama (`src/agent/jeden.ts`, `src/trajectories/writer.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `STADO_MODEL_ROUTER_URL` | none (required) | Router origin, HTTPS except loopback HTTP; no path, query, or credentials |
| `WELES_STADO_MODEL_ROUTER_TOKEN` | none (required) | Brama bearer, ≥32 bytes, distinct from the agent secret and sibling tokens |
| `WELES_STADO_MODEL_ROUTER_AGENT_ID` | none (required) | Must be the exact value `weles`; anything else raises `WELES_STADO_MODEL_ROUTER_AGENT_ID must be the exact Brama identity weles` |
| `WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET` | none (required) | Agent HMAC secret, distinct from the bearer |
| `WELES_AGENT_MODEL` | `best` | Must be the exact alias `best` (`WELES_AGENT_MODEL must be the exact supported Brama alias best`) |
| `WELES_JEDEN_BIN` | `jeden` | Jeden binary |
| `WELES_JEDEN_SESSION_ROOT` | `recordings/<run>/jeden/sessions` | Jeden session ledger root |
| `WELES_JEDEN_TIMEOUT_MS` | `300000` | Per-call timeout |
| `WELES_DISABLE_TRAJECTORY_WRITER` | unset | `1` makes the trajectory writer return its non-model fallback draft (`src/trajectories/writer.ts`) |

`WISENT_APP_AGENT_ID`, `WISENT_APP_AGENT_AUTH_SECRET`, `BRAMA_URL`, and
`BRAMA_TOKEN` are *written* by Weles into the Jeden child environment, never
read from the host environment (`src/agent/jeden.ts`).

## Browser releases and launch

Launches resolve only the verified Stado browser release
(`src/session/find_browser.ts`, `scripts/chromium/download.sh`,
`scripts/firefox/download.sh`); the stock-browser escape hatches are retired
guards that now throw:

| Variable | Default | Meaning |
|---|---|---|
| `WELES_CHROMIUM_RELEASE_VERSION` / `WELES_CHROMIUM_RELEASE_SHA256` | none | Exact Chromium release and archive digest; a missing pair or malformed digest disables resolution |
| `WELES_CHROMIUM_DIR` | `~/.local/share/weles-chromium` | Chromium install root |
| `WELES_FIREFOX_RELEASE_VERSION` / `WELES_FIREFOX_RELEASE_SHA256` / `WELES_FIREFOX_DIR` | `~/.local/share/weles-firefox` | Same trio for Firefox |
| `STADO_RELEASE_API_URL` | required unless local root set | HTTPS release API the download scripts fetch from |
| `STADO_RELEASE_LOCAL_ROOT` | unset | Absolute staged-release directory used instead of the API |
| `CHROMIUM_PATH` | unset | Retired: any explicit path makes `WSession.start` throw `Explicit browser path overrides are retired; configure the exact Stado browser release version and SHA-256` (`src/session/wsession.ts`); `weles doctor` reports set/unset (`src/cli.ts`) |
| `WELES_USE_STOCK_CHROMIUM` | unset | Reported by `weles doctor` only ([cli](cli.md)) |
| `WELES_NOPECHA_EXT` / `WELES_NOPECHA_EXT_DIR` | unset | Retired: an existing extension dir in headed mode throws `NopeCha stock-browser launch is retired; Weles requires the verified Chromium release` (`src/async_api.ts`) |
| `WELES_FORCE_BROWSER` | unset | Persona browser engine when the caller pins none; unset rolls 60/40 chromium/firefox (`src/session/wsession.ts`) |
| `WELES_HEADLESS` | unset | `1` defaults `WSession` launches to headless |
| `WELES_USER_DATA_DIR` | unset | Explicit profile dir; overrides the automatic per-account profile (`src/async_api.ts`, `src/session/wsession.ts`) |
| `WELES_BROWSER_PROFILE_ROOT` | `~/.local/state/weles/browser-profiles` | Root of automatic per-account profiles, keyed by hashed `ACCOUNT_ID` |
| `WELES_CHROMIUM_PROFILE_DIRECTORY` | unset | Adds `--profile-directory=<value>` to the launch args |
| `WELES_USE_NATIVE_KEYCHAIN` | unset | `1` lets Chromium use the real OS keychain instead of the mock store |
| `WELES_DISABLE_HTTP2` | unset | `1` adds `--disable-http2 --disable-quic` for proxies that drop h2 frames in CONNECT tunnels |
| `WELES_VIEWPORT` | persona-derived | `<width>x<height>` (3–4 digits each) viewport override, clamped to the honest screen |
| `WELES_HONEST_HOST` | on | `0`/`false`/`off`/`no` disables honest host hardware (`src/host_hardware.ts`) |
| `WELES_HONEST_SCREEN` | `1` headed, `0` headless | Real panel dimensions vs persona screen (`src/async_api.ts`) |
| `WELES_CLIENT_HINTS_PLATFORM_VERSION` (alias `WELES_MAC_PLATFORM_VERSION`) | honest host value | Pins the client-hints platform version (`src/fingerprint.ts`, `src/async_api.ts`) |
| `WELES_CLIENT_HINTS_ARCHITECTURE` | honest host value | Pins the client-hints architecture |
| `LANG` | `en-US` fallback | Host locale used for browser language when no persona overrides (`src/browser/api.ts`) |

## Input transport

| Variable | Default | Meaning |
|---|---|---|
| `WELES_INPUT` | per-page CDP | `native` dispatches through the single host OS cursor (`src/human/mouse.ts`) — this variable survived the worker removal |
| `WELES_INSTANT_INPUT` | unset | `1` skips humanized key timing (`src/cdp/input.ts`) |
| `WELES_NATIVE_INPUT_ALLOW_ANY_FRONTMOST` | unset | `1` skips the frontmost-application guard (`src/human/mouse-native.ts`) |
| `WELES_NATIVE_INPUT_FRONTMOST_RE` | `^(Chromium\|Google Chrome\|Weles)$` | Regex the frontmost app must match for native input |
| `WELES_NATIVE_INPUT_ALLOW_UNFOCUSED` | unset | `1` allows native input when the page is not focused and visible |
| `WELES_WIN_X` / `WELES_WIN_Y` | `0` / `0` | Window position fallback when AppleScript lookup fails |
| `WELES_CHROME_Y` | `85` | Browser chrome height added to page coordinates |

## Recordings and diagnostics

Run evidence lands under `recordings/<run_uuid>/`
(`src/session/run-recordings.ts`); everything below tunes what gets captured:

| Variable | Default | Meaning |
|---|---|---|
| `WELES_RECORDINGS_ROOT` | `<cwd>/recordings` | Evidence root (`src/session/run-recordings.ts`, `src/worker/upload-artifacts.ts`) |
| `RECORDINGS_ROOT` | `recordings` | Older fallback still read by `src/worker/upload-artifacts.ts`, `src/diagnostics/run-import.ts`, and the keeper bookkeeping |
| `ACTION_LOG_ID` / `WELES_RUN_ID` | `local` | Run identity naming the recordings dir; set by the runner or API server, also consumed by cost tracking (`src/utils/cost.ts`) |
| `ACTION` / `WELES_LABEL` | unset | Action and sub-label segments of the recordings tree; set by `paramsToEnv`/`WSession`, read back for dir naming and proxy context (`src/session/run-recordings.ts`, `src/proxy/policy.ts`) |
| `WELES_DISABLE_RECORDING` | unset | `1` disables session video |
| `WELES_VIDEO_SIZE` | `1280x720` | Video frame size |
| `WELES_RECORDINGS_MAX_BYTES` | `2147483648` | Recordings prune budget |
| `WELES_FULL_DIAGNOSTICS` | unset (but `1` for API-spawned runs) | `1` turns on netlog, CDP, storage, pcap, worker, and host diagnostics at once |
| `WELES_CDP_DIAGNOSTICS`, `WELES_STORAGE_DIAGNOSTICS`, `WELES_PCAP_DIAGNOSTICS`, `WELES_WORKER_DIAGNOSTICS`, `WELES_HOST_DIAGNOSTICS` | unset | Individual `1` switches for the same captures (`src/session/wsession-helpers/net_record.ts`) |
| `WELES_PCAP_IFACE` | `en0` (macOS) / `eth0` | Interface for the pcap sidecar |
| `WELES_CDP_FIREHOSE` / `WELES_CDP_FIREHOSE_MODE` | off | `passive` or `enable-domains` CDP event firehose (`src/session/wsession-helpers/capture_extras.ts`) |
| `WELES_CDP_FIREHOSE_LIMIT` | `20000` | Event cap, floor 1000 |
| `WELES_CDP_TRACING` | on when firehose captures run | `0` disables the Tracing domain capture (read as `WELES_CDP_<feature>`) |
| `WELES_NO_INSTRUMENT` | unset | `1` skips network instrumentation entirely (`src/session/wsession.ts`) |
| `WELES_NO_RESPONSE_BODIES` | unset | `1` drops HAR response-body capture (`src/async_api.ts`, `net_record.ts`) |
| `WELES_CAPTURE_RESPONSE_BODIES` | unset | `1` opts into per-response body capture in `WSession` (`src/session/wsession.ts`) |
| `WELES_PAGE_DIAGNOSTICS` | on | `0` disables in-page diagnostics; forced off for secure credential tasks and `linkedin_register` |
| `WELES_FINGERPRINT` | on | `0` skips the end-of-run fingerprint self-audit (`src/session/wsession-helpers/finalize.ts`) |
| `WELES_BASELINE_DIR` | `<cwd>/recordings/baselines` | Fingerprint baseline directory |
| `WELES_CHROMIUM_NETLOG` | off | `1`/`safe`/`everything` enables Chromium netlog; `0`/`false`/`off` forces it off (`src/async_api.ts`) |
| `WELES_CHROMIUM_NETLOG_MODE` | `safe` | Netlog capture mode (`everything` when requested) |
| `WELES_CHROMIUM_NETLOG_VERBOSE` | unset | `1` adds verbose net/proxy/http stderr logging |
| `WELES_LOG_CUSTOM_PROTOCOL` | dedup | `1` logs every custom-protocol navigation instead of once per target |
| `WELES_VISION_DIR` | `recordings/<run>/vision` | Vision analysis artifact dir (`src/vision/analyze.ts`) |
| `WELES_VISION_MAX_BYTES` | `524288000` | Vision artifact prune budget |

## Proxy

Resolution and preflight (`src/proxy/config.ts`, `src/proxy/policy.ts`,
`src/proxy/sticky.ts`, `src/account/session.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_URL` | unset | Explicit proxy for keeper sessions; for account sessions only honored with `PROXY_URL_FORCE=1` |
| `PROXY_URL_FORCE` | unset | `1` lets `PROXY_URL` override the account's pinned proxy without mutating the pin |
| `PROXY_SKIP_PREFLIGHT` | unset | Skips the exit preflight probe and sticky-refresh check |
| `WELES_FORCE_PROXY` | unset | `1` requires a proxy even on routes that default direct (e.g. Apple) |
| `WELES_ALLOW_DIRECT_ACCOUNT_SESSION` | unset | `1` permits an explicit direct account session when no proxy config exists |
| `WELES_ALLOW_RETIRED_PROXY` | unset | `1` bypasses retired/toxic exit blocks for re-testing |
| `WELES_PROXY_DIAGNOSTICS_LABEL` | `WELES_LABEL` | Label for `proxy_preflight.json` artifacts |
| `LINKEDIN_REGISTER_ALLOW_WARMED_SIGNUP_EXIT` | unset | With `LINKEDIN_REGISTER_WARM_PROFILE_DIR`, permits a warmed signup exit |
| `LINKEDIN_REGISTER_WARM_PROFILE_DIR` | unset | Warmed profile directory for that flow |
| `WELES_LINKEDIN_PREFLIGHT_BODY_MAX_BYTES` | `1000000` | Preflight response-body capture cap |

## Accounts, email domains, credential tasks

| Variable | Default | Meaning |
|---|---|---|
| `ACCOUNT_ID` | unset | Enables the automatic per-account browser profile (hashed key) (`src/session/wsession.ts`) |
| `WELES_LOGIN_ITEM` / `ACCOUNT_ITEM` | unset | Exact vault account item to use instead of listing by platform (`src/utils/credentials.ts`) |
| `WELES_CREDENTIAL_CONSTRAINTS` / `GENERIC_TASK_CONSTRAINTS` | unset | Marks a secure credential task; setting both raises `multiple credential constraint sources are not allowed` (`src/session/wsession-helpers/credential-store.ts`) |
| `AGENT_DOMAIN` | `wisentmedia.com` | Fallback signup email domain (`src/utils/email/domain.ts`) |
| `AGENT_EMAIL_DOMAINS` | unset | Comma-separated domain pool, picked at random |
| `FORCE_EMAIL_DOMAIN` | unset | Hard override of domain selection |
| `TIKTOK_MAX_SIGNUPS_PER_DOMAIN` | `500` | Per-domain TikTok signup cap |
| `SEMANTIC_SCHOLAR_FOLLOWUP_MAX_PAGES` | `8` (cap 20) | Inbox pages scanned per follow-up attempt (`src/secrets/semantic-scholar-followup.ts`) |
| `SEMANTIC_SCHOLAR_FOLLOWUP_MAX_ATTEMPTS` | `96` | Attempts before the follow-up expires |
| `WELES_CACHE_DIR` | `~/.weles` | Cache root for saved flows and trajectory drafts (`src/session/flows.ts`, `src/agent/tasks.ts`) |

## Release identity heartbeat

`src/worker/deployment_version.ts` publishes the running release identity to
the `weles_deployment_version` setting. The twelve identity variables are
all-or-nothing: any subset raises `immutable release identity is partially
configured`. They are written into `worker.env` by `scripts/release/activate.mjs`,
never typed by hand ([releases](releases.md)):

| Variable | Meaning |
|---|---|
| `WELES_WORKER_VERSION`, `WELES_SOURCE_REVISION`, `WELES_WORKER_ARTIFACT_SHA256` | Worker artifact identity |
| `WELES_DEPLOYMENT_MANIFEST_SHA256`, `WELES_DEPLOYMENT_ID` | Deployment manifest identity |
| `WELES_DEPLOYMENT_RING` | One of `candidate`, `development`, `canary`, `production` (`WELES_DEPLOYMENT_RING must name a release ring`) |
| `WELES_CLAIMS_ENABLED` | `0` or `1` (`WELES_CLAIMS_ENABLED must be 0 or 1`); must be `1` exactly on the production ring (`only the production release ring may claim queued work`) |
| `WELES_CHROMIUM_RELEASE`, `WELES_CHROMIUM_SHA256`, `WELES_FIREFOX_RELEASE`, `WELES_FIREFOX_SHA256` | Browser fragments of the manifest |
| `WELES_API_SCHEMAS` | Comma-separated supported API schemas |
| `WELES_INSTANCE_ID` / `INSTANCE_ID` | Stable instance identity; default `weles-<hostname>-<pid>` |

`WELES_DEPLOYMENT_GENERATION` and `WELES_DRAIN_FILE` are still exported into
`worker.env` by `scripts/release/activate.mjs`, but nothing in the current
tree reads them — the drain protocol runs on the `drain-target` file path
inside the release state directory (`scripts/release/lib.mjs`).

## Release pipeline and host deploy

`scripts/release/*.mjs` and `scripts/worker/deploy/auto-deploy.sh`:

| Variable | Default | Meaning |
|---|---|---|
| `WELES_RELEASE_ROOT` | `~/.local/share/weles-releases` | Immutable release install root (`scripts/release/lib.mjs`) |
| `WELES_RELEASE_STATE_ROOT` | `~/.local/state/weles-release` | Release state (rings, receipts, drain target) |
| `WELES_WORKER_ENV_FILE` | `~/.config/weles/worker.env` | Deployment env file written by activation, read by `auto-deploy.sh` and `scripts/worker/managed-runs-snapshot.mjs` |
| `WELES_RELEASE_TOKEN` / `GH_TOKEN` | unset | GitHub token for release asset download and attestation verify (`scripts/release/lib.mjs`) |
| `WELES_VERIFY_ATTESTATIONS` | `1` | Any other value throws `artifact attestation verification cannot be disabled for immutable releases` |
| `WELES_CHROMIUM_BIN` / `WELES_FIREFOX_BIN` | unset | Browser entrypoints recorded by `scripts/release/capture-baseline.mjs` |
| `WELES_AUTO_DEPLOY_ENABLED` | `true` | Any other value stops a host from taking new releases (`auto-deploy.sh`) |
| `WELES_STATE_DIR` | `~/.local/state/weles` | Auto-deploy log and deployment receipt dir |
| `WELES_WORKER_RELEASE_VERSION` / `WELES_WORKER_RELEASE_SHA256` | none (required) | Exact worker release coordinates; the digest must be one complete hex SHA-256 |
| `WELES_WORKER_RELEASE_ROOT` | `~/.local/share/weles-worker` | Versioned worker install root |
| `WELES_CURRENT_LINK` | `~/weles` | Symlink flipped to the verified install |
| `PROBIERZ_BUILD_PATH` | none (required) | Deployment manifest under test (`scripts/release/probierz/weles-release.spec.mjs`) |
| `WELES_WORKER_URL` / `WELES_WORKER_API_TOKEN` | none (required) | Candidate worker endpoint and bearer the release spec probes |
| `WELES_OVERLAY_ARCHIVE` / `WELES_OVERLAY_VERSION` | none (required) | Overlay archive and version stamped into `weles-overlay.json` (`scripts/worker/deploy/write-overlay-manifest.sh`) |

## Keeper sessions

The keeper is the manual capture harness (`scripts/_shared/keeper/keeper.mjs`
and siblings); its knobs are session-local, not fleet configuration:

| Variable | Default | Meaning |
|---|---|---|
| `SESSION` | `default` | Session name; socket at `~/.weles/keeper/<SESSION>/socket` |
| `PLATFORM` / `URL` / `JAR` | empty | Platform hint, start URL, cookie jar path |
| `HEADLESS` | unset | `1` launches headless |
| `BROWSER` | unset | Engine pin when no platform persona is sourced |
| `PROXY_COUNTRY` / `PERSONA_OS` | `US` / `macos` | Generated-persona axes |
| `KEEPER_USER_DATA_DIR` | `WELES_USER_DATA_DIR` | Profile dir override |
| `KEEPER_STAY_ALIVE_ON_SIGTERM` | unset | `1` ignores SIGTERM |
| `KEEPER_FLOW_ACTION` | `<PLATFORM>_keeper` or `keeper_flow` | Flow record action name |
| `KEEPER_PAGE_TRAPS` | off | `1` re-enables in-page diagnostics for deliberate forensic runs |
| `KEEPER_DISABLE_WEBAUTHN` | unset | `1` removes `PublicKeyCredential` so Google offers a password field |
| `WELES_REPO` | the checkout path hard-coded in the script | Repo whose `dist/` the keeper imports |
| `DIAGNOSTIC_STAGE` (alias `WELES_DIAGNOSTIC_STAGE`), `DIAGNOSTIC_SOURCE`, `DIAGNOSTIC_FIXED_AXES`, `DIAGNOSTIC_VARIABLE_AXIS` | unset / `keeper_env` | Diagnostic capture annotations |
| `APP_ID` | `6502873271` | App Store Connect app id for the ASC check script |

## Removed with the polled worker

PR #50 deleted the database-polled worker (`src/worker/claim.ts`, `poll.ts`,
`verification.ts`, `stale.ts`, `schema_compatibility.ts`, `identity.ts`,
`placement-policy.ts`, `credential-completion.ts`, `scripts/worker/run.mjs`)
and the Weles database runtime. These variables no longer have any reader in
`src/` or live scripts and must not be set:

- `WORKER_CONCURRENCY`, `WELES_ALLOW_UNSAFE_PARALLEL` — poll-loop concurrency
- `WELES_TRAJECTORY_HARD_CAP_MS`, `WELES_WEDGE_CHECK_MS`,
  `WELES_ORPHAN_RECLAIM_LIMIT` — watchdogs and orphan reclaim
- `WELES_VERIFY_RUNS`, `AUTO_INSTRUMENT_RETRIES` — post-run verification and
  instrumented re-runs
- `WELES_WEBHOOK_SECRET` — worker webhook auth
- `WELES_DATABASE_URL`, `WELES_DATABASE_TOKEN`,
  `WELES_DATABASE_SCHEMA_VERSION` — the removed database runtime
- `WELES_WORKER_FORCE_ENABLED`, `WELES_EXECUTION_AGENT` — claim gating

Two of the old claim-authority names moved rather than died:
`WELES_ACTION_ALLOWLIST` has no `src/` reader anymore — the allowlist file
`scripts/worker/deploy/weles-action-allowlist.txt` is injected by
`scripts/lint/check_module_load.mjs` and used by the deploy shell helpers —
and `WELES_PLACEMENT_POLICY_FILE` survives only in those helpers
(`grant-placement-action.sh`, `report-placement-policy.sh`,
`weles-execution-placement.sh`; default `~/.config/weles/placement-policy.json`),
because the policy file is operator-edited on the host — the helper's own
header notes there is no Stado command for it. `WELES_INPUT`, `WELES_CLAIMS_ENABLED`,
and `WELES_DEPLOYMENT_ID` did **not** die: their live readers are
`src/human/mouse.ts` and `src/worker/deployment_version.ts`.
