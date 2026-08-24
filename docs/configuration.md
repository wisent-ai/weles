# Configuration

Weles configuration is environment variables plus two operator-published
files: the deployment env file read by the launcher and the stamped placement
policy. Secrets are configured nowhere — every credential is a Skarbiec
acquisition at runtime ([authorization](authorization.md)). This page lists
the surfaces an operator or integrator actually sets; deep diagnostics knobs
live next to their code.

## Caller (client) environment

From the README; consumed by your own service, not by the worker:

| Variable | Meaning |
|---|---|
| `WELES_API_BASE` | Deployment endpoint the `WelesClient` submits to |
| `WISENT_ORGANIZATION_ID` | Organization UUID sent in every request |
| `WELES_TOKEN` | Organization-scoped bearer |

## Claim authority

Read at worker startup and per claim (`src/worker/claim.ts`,
`src/worker/placement-policy.ts`):

| Variable | Meaning |
|---|---|
| `WELES_ACTION_ALLOWLIST` | Required. Comma-separated, unique, exact lowercase action names — the hard bound on what this binary may ever run |
| `WELES_CLAIMS_ENABLED` | `0` disables claiming on this host; default `1` |
| `WELES_DEPLOYMENT_ID` | Immutable deployment identity written into each claim's lease |
| `WELES_DEPLOYMENT_GENERATION` | Positive lease generation; required together with `WELES_DEPLOYMENT_ID` |
| `WELES_PLACEMENT_POLICY_FILE` | Placement policy path; default `~/.config/weles/placement-policy.json` |
| `WELES_WORKER_FORCE_ENABLED` | `1` bypasses the fleet-wide `workers_enabled` switch |
| `WELES_EXECUTION_AGENT` | Execution agent identity for host-pinned actions; default `weles-worker` |

The placement policy document is `schema_version: 1` with a `hosts[]` array —
each entry exactly `hostname`, optional `aliases`, `enabled`, and `actions`
(exact names, or a single `*` wildcard) — and a required `_source` stamp
(`registry_generation`, `published_at`, `by`) proving it was published by
`stado host publish-placement-policy <host>`. An unstamped file is refused
and the host claims nothing.

## Browser releases

Read by the install scripts and again at every launch
(`src/session/find_browser.ts`, `scripts/chromium/download.sh`,
`scripts/firefox/download.sh`):

| Variable | Meaning |
|---|---|
| `STADO_RELEASE_API_URL` / `STADO_RELEASE_LOCAL_ROOT` | Where the immutable release archive is fetched from |
| `WELES_CHROMIUM_RELEASE_VERSION` | Exact Chromium release version |
| `WELES_CHROMIUM_RELEASE_SHA256` | Exact archive SHA-256; a malformed digest disables resolution |
| `WELES_CHROMIUM_DIR` | Install root; default `~/.local/share/weles-chromium` |
| `WELES_FIREFOX_RELEASE_VERSION`, `WELES_FIREFOX_RELEASE_SHA256`, `WELES_FIREFOX_DIR` | Same trio for Firefox |

## Worker runtime

| Variable | Meaning |
|---|---|
| `WORKER_CONCURRENCY` | Concurrent poll loops; clamped to 1 under `WELES_INPUT=native` unless `WELES_ALLOW_UNSAFE_PARALLEL=1` |
| `WELES_INPUT` | Input transport; default per-page CDP, `native` uses the single host OS cursor |
| `RECORDINGS_ROOT` | Run-evidence root; default `recordings` |
| `WELES_RECORDINGS_MAX_BYTES` | Recording prune budget; default 2 GiB |
| `WELES_VIDEO_SIZE` | Recording frame size; default `1280x720` |
| `WELES_TRAJECTORY_HARD_CAP_MS` | Wedge watchdog hard cap per run; default 1800000 |
| `WELES_WEDGE_CHECK_MS` | Wedge watchdog interval; default 120000 |
| `WELES_ORPHAN_RECLAIM_LIMIT` | Max rows reclaimed at startup; default 500 |
| `WELES_VERIFY_RUNS` | `0` disables model verification of flagged runs |
| `AUTO_INSTRUMENT_RETRIES` | `0` disables the diagnostic instrumented re-run of failed trajectories |
| `WELES_INSTANCE_ID` / `INSTANCE_ID` | Stable worker identity in claims and heartbeats; default derives from hostname and PID |
| `WELES_RELEASE_STATE_ROOT` | Release state directory; default `~/.local/state/weles-release` |
| `WELES_DRAIN_FILE` | Names a target manifest SHA-256; a poll loop whose `WELES_DEPLOYMENT_MANIFEST_SHA256` differs stops polling. Default `<release-state>/drain-target` |

## Workload identity and acquired credentials

The launcher env file carries only nonsecret settings and release
coordinates. Credentials resolve at runtime through per-field Skarbiec
acquisition scopes (`scripts/worker/deploy/README.md`); the workload identity
is:

| Variable | Meaning |
|---|---|
| `SKARBIEC_WORKLOAD_ID` | Stable nonsecret deployment identity registered in Skarbiec |
| `SKARBIEC_WORKLOAD_SIGNING_KEY_FILE` | Absolute path to the owner-only Ed25519 private key that signs acquisition proofs |

Acquired fields surface to the process as, among others,
`WELES_DATABASE_URL`, `WELES_DATABASE_TOKEN`,
`WELES_STADO_OBJECT_API_TOKEN`, `WELES_STADO_MODEL_ROUTER_TOKEN`,
`WELES_ARTIFACT_DELIVERY_TOKEN`, and `WELES_ARTIFACT_SIGNING_SECRET` — each
mapped from its own exact `consumer|item|field` scope, never written to a
file. Do not set these by hand; provision the scope.

## Onboarding and CLI

| Variable / flag | Meaning |
|---|---|
| `--subject`, `--state-dir` | Durable onboarding scope and state directory ([cli](cli.md)) |
| `CHROMIUM_PATH`, `WELES_USE_STOCK_CHROMIUM` | Reported by `weles doctor`; launches still resolve only the verified release |
