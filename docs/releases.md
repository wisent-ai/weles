# Releases

How does a build become the production worker? Through one immutable
deployment manifest that names every component by exact digest, promoted
through four rings with a Probierz evidence gate in front of every
activation, and recorded as receipts at every step. Nothing production runs
from a mutable checkout, a branch, or a "latest" pointer — every activation
names exact bytes. The loop the released worker then runs is
[worker lifecycle](worker-lifecycle.md); the env it reads is
[configuration](configuration.md).

## The deployment manifest

A deployment manifest is one JSON document, schema `weles.deployment.v2`
(`release/deployment-manifest.schema.json`), assembled from five fragments —
`worker`, `web`, `client`, `chromium`, `firefox` — plus a `deploymentId`
matching `YYYY-MM-DD.N`, a `createdAt` timestamp, and the git
`sourceRevision` of the release checkout
(`scripts/release/assemble-manifest.mjs`).

| Fragment | Required fields |
|---|---|
| `worker` | semver `version`, 40-hex `sourceRevision`, `artifacts[]` |
| `web` | `deploymentId`, `sourceRevision`, `apiSchemas[]` (`weles.<name>.vN`) |
| `client` | semver `minimumVersion`, `apiSchemas[]` |
| `browsers.chromium` / `browsers.firefox` | `release`, `sourceRevision`, `capabilitiesSha256`, `artifacts[]` |

Every artifact names `platform` (`darwin-arm64`, `darwin-x64`, `linux-x64`),
an `https://` URL, a SHA-256, a path-safe `entrypoint`, and SLSA provenance
(`provenanceUrl` + `provenanceRepository`). The manifest's own SHA-256 is
the deployment's identity everywhere downstream: install records, activation
state, receipts, and the worker heartbeat all carry it.

## Rings

`RELEASE_RINGS` is frozen as `candidate → development → canary → production`
(`scripts/release/lib.mjs`). `assertPromotionTransition` enforces the ladder
at activation time: promoting a manifest into a ring requires that the **same
manifest** was already active in the previous ring (error:
`` `${ring} promotion requires the same manifest to be active in ${requiredPreviousRing}` ``),
a manifest that has advanced can never return to candidate, and only
`rolled_back` receipts bypass the check. The compatibility policy states the
same contract declaratively (`release/compatibility-policy.json`):
`productionRequiresEnvironmentApproval`, `candidateBytesMustEqualPromotedBytes`,
and `partialComponentActivation: false` — the worker, web identity, client
floor, and both browsers activate together or not at all.

## The release commands

All state these commands touch lives in two places: files under the state
root (`--state-root`, `WELES_RELEASE_STATE_ROOT`, default
`~/.local/state/weles-release`) and Skarbiec vault items written through the
`skarbiec` CLI (`readReleaseState`/`writeReleaseState` map key `k` to vault
item `weles-setting-<k-with-dashes>`; binary from `SKARBIEC_BIN`, default
`~/.stado/bin/skarbiec`). There is no database (`scripts/release/lib.mjs`).

| Command (`scripts/release/`) | Purpose | Key flags |
|---|---|---|
| `assemble-manifest.mjs` | Validate five fragments into one manifest + `.sha256` sidecar | `--output`, `--deployment-id`, `--created-at`, `--source-revision`, `--worker`, `--web`, `--client`, `--chromium`, `--firefox` |
| `validate-candidate-manifest.mjs` | Check a manifest against the release target revision and expected candidate tag | `--manifest`, `--source-revision`, `--candidate-tag` |
| `publish-manifest.mjs` | Publish the candidate as a GitHub prerelease `candidate-deployment-<deploymentId>-<sha8>` on `wisent-ai/weles` | `--manifest` |
| `install.mjs` | Fetch the manifest by URL + expected SHA-256, install worker/chromium/firefox artifacts, write a `weles.installation.v1` record under `installations/<sha256>.json` | `--manifest-url`, `--manifest-sha256`, `--platform` |
| `activate.mjs` | Cut a host in a ring over to an installed manifest (details below) | `--manifest-sha256`, `--host`, `--ring`, `--receipt-status`, `--probierz-root`, `--evidence-receipt`, `--run-ids`, `--public-key`/`--fingerprint`, `--legacy-drained`, `--drain-timeout-ms`, `--health-timeout-ms`, `--worker-env-file` |
| `rollback.mjs` | Re-activate `previous.json` with receipt status `rolled_back` | `--host`, `--ring`, plus forwarded `--worker-env-file`, `--drain-timeout-ms`, `--health-timeout-ms` |
| `status.mjs` | Emit one `weles.release-status.v2` JSON: current, previous, promotion, drain target, heartbeat, active lease, `stado service status weles-worker` | `--host`, `--ring` |
| `evidence-gate.mjs` | Ask Probierz for a release verdict bound to the manifest's source revision | `--probierz-root`, `--manifest`, `--receipt`, `--run-ids`, `--public-key`/`--fingerprint` |
| `prepare-probierz.mjs` | Install the Weles release spec and `appId: weles` manifest (journeys `web-contract`, `worker-contract`, `chromium-candidate`, `firefox-candidate`) into a Probierz checkout | `--probierz-root` |
| `capture-baseline.mjs` | Record a `weles.production-baseline.v1`: repository commit and dirtiness, worker package version and `dist/` tree hash, deployment mode, browser identities, optional digest-hashed rollback archive | `--out`, `--archive-out`, `--deployment-mode-file`, `--web-deployment-id`, `--chromium-bin`, `--firefox-bin` |
| `enforce-version.mjs` | Refuse a candidate whose `package.json` version disagrees with the AutoVersion decision and the `weles.version-change.v1` declaration | `--decision`, `--baseline`, `--declaration`, `--manifest` |
| `surface.mjs` | Compute the released surface for versioning: exports of `src/index.ts`, `package.json` bin commands, the `CliCommand` union, `welesMcpTools` names, worker HTTP routes, supported API schemas, task statuses | — |
| `cutover-legacy.mjs` | One-time guarded plan for leaving `legacy-main-poll` mode; requires `--confirm 'LEGACY TO IMMUTABLE'` and a digest-verified rollback archive | `--baseline`, `--manifest-sha256`, `--host`, `--confirm` |

Publishing is gated on people as well as bytes: `publish-manifest.mjs`
refuses a manifest whose `sourceRevision` is not the current `HEAD`, refuses
a dirty tracked tree (`commit tracked Weles release inputs before publishing
a manifest`), and refuses an actor not listed in the repository variable
`WELES_RELEASE_APPROVERS`
(`` `${actor} is not an allowlisted Weles release operator` ``).

## What activate.mjs actually does

Activation (`scripts/release/activate.mjs`) is the ring transition, and it is
entirely file- and Skarbiec-state driven:

1. **Verify the installation.** Load `installations/<sha256>.json`, re-hash
   the stored manifest, check every component entrypoint exists. Take an
   exclusive `locks/activation.lock`.
2. **Enforce the ladder.** `assertPromotionTransition` against the manifest's
   promotion record. The first production activation additionally requires
   `--legacy-drained true` ("first immutable production activation requires
   --legacy-drained true after producers are paused and in-flight legacy work
   is complete").
3. **Evidence gate.** For `--receipt-status activated` (the default),
   `evidence-gate.mjs` runs first and must approve: it verifies the Probierz
   source identity includes a **clean** Weles checkout whose `gitSha` equals
   the manifest's `sourceRevision`, then runs `gate-evaluate weles release`
   over the named `--run-ids` and the signed `--evidence-receipt`. The
   approval JSON is embedded in the activation receipt and the promotion
   record. `rolled_back` activations skip the gate.
4. **Write the runtime identity.** A `runtime.env` under
   `rings/<ring>/<host>/launch/<sha256>/` exports the full release identity:
   `WELES_WORKER_VERSION`, `WELES_SOURCE_REVISION`,
   `WELES_WORKER_ARTIFACT_SHA256`, `WELES_DEPLOYMENT_MANIFEST_SHA256`,
   `WELES_DEPLOYMENT_ID`, `WELES_DEPLOYMENT_GENERATION` (derived numerically
   from the `YYYY-MM-DD.N` deploymentId), `WELES_DEPLOYMENT_RING`,
   `WELES_INSTANCE_ID`, `WELES_CLAIMS_ENABLED` (**`1` only in the production
   ring**), both browser releases with SHA-256s and binaries,
   `WELES_API_SCHEMAS`, and `WELES_DRAIN_FILE`. A `weles-worker` wrapper
   script sources the operator-owned worker env file
   (`--worker-env-file`, `WELES_WORKER_ENV_FILE`, default
   `~/.config/weles/worker.env`; error `weles worker env file is missing`)
   and then `exec`s Node on the installed worker entrypoint.
5. **Cut over through Stado.** Wait for the previous deployment to drain,
   in production write the `weles_active_worker_lease` release-state item
   (schema `weles.worker-lease.v1`: deploymentId, generation, manifest
   SHA-256), then `stado service retire weles-worker --host <host>` followed
   by `stado service deploy weles-worker --host <host> --from <wrapper>`.
6. **Wait for the heartbeat.** The new worker must report itself: the
   release-state key `weles_deployment_version` (production) or
   `weles_deployment_version_<ring>_<instanceId>` (other rings) must carry
   the expected manifest SHA-256 **and** the activation's instance id within
   `--health-timeout-ms` (default 120 000 ms), else
   `` `worker heartbeat did not report manifest ${sha} from instance ${id}` ``.
7. **Record.** Write `current.json` (schema `weles.active-deployment.v1`,
   preserving the old one as `previous.json`), a receipt file under
   `receipts/<ring>/<host>/` plus the
   `weles_deployment_receipt_<ring>_<host>` state item, and — for `activated`
   only — a `weles.promotion.v1` record that the next ring's ladder check
   reads. On any failure after cutover began, a `failed` receipt is recorded
   best-effort and the **previous** wrapper is redeployed with its lease
   restored; without a previous deployment the production lease is cleared.

Receipt `status` is one of `activated`, `rolled_back` (the only values
`--receipt-status` accepts), or `failed` (written by the error path). The
receipt binds deployment id, manifest SHA-256, host, ring, worker version and
source revision, web identity, all three artifact digests, both browser
releases, `client_minimum_version`, the previous manifest, and the evidence
(Stado deploy output, observed heartbeat, Probierz approval).

`rollback.mjs` is a thin re-activation: it loads `current.json` and
`previous.json` for the ring/host, refuses incomplete state
(`` `rollback state for ${ring}/${host} is incomplete` ``) or a no-op
(`rollback target equals the active manifest`), and re-runs `activate.mjs`
on the previous manifest with `--receipt-status rolled_back
--legacy-drained true` — so a rollback produces a real `rolled_back` receipt
through the same code path.

## The worker's side: heartbeat identity

The released worker writes its identity as a Skarbiec setting on an interval
(`src/worker/deployment_version.ts`): `startDeploymentVersionHeartbeat`
writes every `WELES_DEPLOYMENT_VERSION_HEARTBEAT_MS` (default 60 000 ms) via
`writeSetting` (`src/state/skarbiec-records.ts`). The value carries the
`weles.release-identity.v2` block read from the activation env — all twelve
variables must be set together (`immutable release identity is partially
configured` otherwise), the ring must be one of the four
(`WELES_DEPLOYMENT_RING must name a release ring`), and the ring/claims
coupling is enforced at startup: `only the production release ring may claim
queued work`. Alongside the release block it records the observed build
(`weles_dist_sha256`, `trajectories_tree_sha256`, `runner_entry_sha256`) and
runner facts (host, user, Node version, pid, platform, arch) — the identity
`status.mjs` surfaces and [receipts](receipts.md) build on.

## Host auto-deploy: exact coordinates only

`scripts/worker/deploy/auto-deploy.sh` installs and activates "one explicitly
selected immutable Weles worker release. This script never discovers source
branches, tags, channels, or provider releases." Everything comes from the
owner-controlled env file (`WELES_WORKER_ENV_FILE`, default
`~/.config/weles/worker.env`), which must be a readable regular file, not a
symlink, with valid shell syntax:

- **Kill switch**: `WELES_AUTO_DEPLOY_ENABLED` set to anything but `true`
  makes the tick a no-op, "without editing or unloading its launchd job".
- **Required coordinates**: `WELES_WORKER_RELEASE_VERSION` +
  `WELES_WORKER_RELEASE_SHA256`, `WELES_CHROMIUM_RELEASE_VERSION` +
  `WELES_CHROMIUM_RELEASE_SHA256`, `WELES_FIREFOX_RELEASE_VERSION` +
  `WELES_FIREFOX_RELEASE_SHA256`, and `STADO_RELEASE_API_URL` (unless
  `STADO_RELEASE_LOCAL_ROOT` serves releases locally). The worker release
  resolves to `stado://releases/weles-worker/<version>/<platform>/weles-worker.tar.gz`.
- **Receipts, not trust**: an install is only reused when its
  `.weles-release` receipt matches the expected content exactly, and the
  deployment as a whole re-activates only when
  `~/.local/state/weles/deployment.release` matches the six-line
  `worker_uri`/`worker_sha256`/`chromium_uri`/`chromium_sha256`/`firefox_uri`/`firefox_sha256`
  receipt. The current symlink must be "an operator-created symlink, not a
  mutable checkout or directory".
- **Browsers fail closed**: both `scripts/chromium/download.sh` and
  `scripts/firefox/download.sh` must produce a verified binary, or the API
  services are not activated ("required Weles Chromium release is unavailable
  or invalid").

## Browser release receipts

The runtime enforces the same receipt at every launch, not just at deploy
(`src/session/find_browser.ts`): `findCustomBrowser` resolves the install
directory from `WELES_CHROMIUM_RELEASE_VERSION`/`WELES_FIREFOX_RELEASE_VERSION`
and the matching `*_RELEASE_SHA256`, and returns the binary only when the
installed `.weles-release` file is byte-equal to:

```
release_uri=stado://releases/<product>/<version>/<platform>/<asset>
archive_sha256=<sha256>
platform=<platform>
```

(with a trailing newline; `expectedReceipt` in `exactReleaseCandidate`).
Anything else — missing file, wrong digest, unsupported platform — means no
browser, and there is no stock-browser fallback
([what-is-weles](what-is-weles.md)).

## Worker component releases and version discipline

The worker itself is released as a Stado product: `.wisent-release.json`
declares product `weles-worker`, version taken from `package.json`, a
`darwin-arm64` build via `release/stado-build.sh`, digest-pinned source
inputs (the `weles-client` bundle among them), and promotion channels
`candidate` and `stable`. Version changes are declared, not implied:
`release/version-change.json` (`weles.version-change.v1`) currently declares
`0.4.0 → 0.5.0`, `breaking: true`, because "The immutable worker distribution
replaces the mutable-checkout deployment contract"; `enforce-version.mjs`
cross-checks that declaration against the captured baseline and an
AutoVersion decision over the released surface (`surface.mjs`), refusing e.g.
"declared breaking change was not escalated by AutoVersion".

`release/current-production.json` is the committed production pointer
(`weles.production-pointer.v1`); in this tree it is `"status":
"uninitialized"` with null manifest coordinates — no immutable production
promotion has been recorded in the repository yet.
