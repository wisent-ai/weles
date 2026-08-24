# Worker lifecycle

What does a Weles worker do from process start to terminal state, and what
keeps a fleet of them honest? The worker is a long-running Node process
(`scripts/worker/run.mjs`) that polls the action log, claims atomically, and
spawns one trajectory subprocess per claimed row. Everything below is the
loop around that spawn.

## Startup

The launcher reads an operator-owned env file of nonsecret runtime settings
and release coordinates; it accepts no database service-role key, provider
API key, or platform password from that file. Runtime credentials are
acquired at startup through per-field Skarbiec bootstrap consumers
(`scripts/worker/deploy/README.md`). The process then, in order:

1. starts the signed artifact-delivery listener and refuses to run if it
   cannot listen;
2. checks database compatibility: the newest version in the
   `weles_schema_migrations` ledger must fall inside the worker's supported
   range, and must equal the deployment manifest's declared
   `WELES_DATABASE_SCHEMA_VERSION` when one is set
   (`src/worker/schema_compatibility.ts`);
3. starts the deployment-version heartbeat, publishing the running release
   identity — worker version, source revision, artifact SHA-256, manifest
   SHA-256, ring, browser releases, database schema, API schemas — once a
   minute (`src/worker/deployment_version.ts`);
4. reclaims its own orphans: any `running` row still tagged with this
   instance's `claimed_by` identity at startup is a zombie a dead predecessor
   left behind, and is failed before the poll loops start;
5. starts `WORKER_CONCURRENCY` concurrent poll loops. The default input
   transport is per-page CDP, which is parallel-safe; `WELES_INPUT=native`
   uses the single host OS cursor, so concurrency is clamped to 1 unless
   `WELES_ALLOW_UNSAFE_PARALLEL=1`.

## One poll tick

`pollOnce` (`src/worker/poll.ts`) runs the same ordered gates every few
seconds:

1. load the stamped placement policy — unavailable or refused policy is an
   error, and a policy-disabled host reports the denial rather than idling
   silently;
2. check the fleet-wide `workers_enabled` switch;
3. preflight evidence storage: unless the private artifact namespace is
   provably writable, the worker refuses to claim so the row stays pending
   for a healthy worker;
4. sweep zombies if due (below);
5. claim at most one row (`claimOne`, [authorization](authorization.md)):
   candidates are filtered by the policy∩allowlist set, dispatch-route
   existence, per-account in-flight locks, stale-cookie gates, and execution
   pinning, then claimed with an atomic status PATCH that also writes the
   deployment lease. A claim attempt has exactly two outcomes and neither is
   silent — every idle tick carries the sentence explaining it, and denials
   are reported once per change with a cooldown, because a host configured to
   claim nothing must not look like an empty queue;
6. run pre-spawn guards (per-run authorizations, admin-session readiness,
   credential-writer availability), spawn the trajectory, assemble the
   result, upload artifacts, and write exactly one terminal state
   ([workflows](workflows.md)).

## Watchdogs

Failure is assumed, so three independent mechanisms reap it
(`src/worker/stale.ts`):

- **Zombie sweep.** Rows left `running` for over two hours are workers killed
  mid-trajectory; a throttled sweep re-queues them so they stop blocking
  their account's in-flight slot.
- **Wedge watchdog.** A hung trajectory subprocess blocks its poll loop with
  no way out. On its own interval — not inside the wedged loop — the watchdog
  checks this instance's own running rows, and when every slot has been stuck
  past the hard cap (`WELES_TRAJECTORY_HARD_CAP_MS`, default 30 minutes) it
  SIGKILLs the process so the supervisor restarts it and the fresh worker's
  sweep re-queues the stuck rows.
- **Startup orphan reclaim.** Described above; it exists so the wedge
  watchdog does not kill a fresh worker for its predecessor's leftovers.

## Immutable releases and rings

Production workers run manifest-selected immutable artifacts, never a
checkout (`scripts/worker/deploy/README.md`):

- worker bytes are published only as `worker-vX.Y.Z` GitHub Releases —
  archive, SHA-256 sidecar, embedded provenance — and the release workflow
  accepts a tag only from an approver on the repository's allowlist;
- one deployment manifest names the exact worker, web, database, client,
  Chromium, and Firefox fragments; publication validates source identity and
  uploads a Sigstore bundle, and installation verifies the exact archive by
  URL and SHA-256;
- activation advances one manifest SHA-256 through the rings in strict order
  — `candidate`, `development`, `canary`, `production` — re-verifying the
  signed Probierz evidence receipt, run IDs, clean source revision, and build
  digest at every ring;
- candidate, development, and canary workers never claim queue rows: claiming
  is disabled in their build, and the production database lease rejects
  queued-to-running claims from any deployment other than the active
  production generation;
- during production activation the old worker drains (the drain file at
  `WELES_DRAIN_FILE` marks a host draining for another release), the lease
  advances, the unit is replaced, and a fresh instance must report the exact
  manifest heartbeat before success is recorded; failure restores the prior
  lease and unit. Rollback reactivates the retained previous manifest and
  records a `rolled_back` receipt.

Host-side auto-deploy installs only the exact release coordinates named in
the deployment env file on each tick — it never polls a branch, clones, or
builds — and `WELES_AUTO_DEPLOY_ENABLED=false` stops a host from taking new
releases.

The env vars named here are collected in [configuration](configuration.md).
