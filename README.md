# Weles

**Weles is a private browser-workflow executor for explicitly authorized,
reviewed actions that require controlled browser identity, scheduling, and
verifiable execution evidence.**

This repository contains the execution service. It is not the public Weles
client and is not a general-purpose authorization to automate a website.

[Runtime deployment](scripts/worker/deploy/README.md) ·
[Capture inventory](scripts/worker/deploy/FINGERPRINT_CAPTURE.md) ·
[Public client](https://github.com/wisent-ai/weles-client)

Current boundary: package version `0.5.0` is an internal operated surface. No
public executor package, self-service hosted workflow, target authorization, or
SLA is promised from this repository.

## Problem and intended users

Some approved workflows require a long-lived browser process, a stable execution
identity, bounded credentials, target-specific trajectories, and retained
outcome evidence. Ad hoc Playwright scripts mix those concerns, leak operational
configuration, and make authorization or replay difficult to audit.

Weles serves:

- **workflow operators** who admit exact origins, actions, accounts, and
  trajectories;
- **Wisent services** that submit already-authorized work through the safe Weles
  client contract;
- **runtime engineers** who maintain browser patches, identity generation,
  scheduling, capture, and recovery.

## Product boundaries

### Included

- a TypeScript worker that atomically claims scheduled action rows;
- one supervised trajectory subprocess per claimed action;
- Chromium and Firefox runtimes selected by deployment policy;
- browser-identity and fingerprint configuration applied at the browser
  boundary;
- scoped credential acquisition through the configured secret boundary;
- screenshots, recordings, traces, fingerprint capture, and structured outcome
  evidence where the selected trajectory requests them;
- bounded retries and explicit terminal failure states owned by the scheduler;
- diagnostics and lint rules for trust, browser-boundary, and trajectory code.

### Explicit non-goals

- Weles does not decide whether a target permits automation.
- It does not turn possession of a credential into authorization for arbitrary
  origins or actions.
- It does not expose browser patches, provider rotation, stealth configuration,
  private trajectories, customer recordings, or operational credentials as a
  public SDK.
- It is not the public receipt-verification boundary; that belongs to
  `weles-client`.
- It does not provide billing, account ownership, or organization approval.
- It must not be used for evasion, fake engagement, unauthorized access, or
  bypassing a target's rules.

### Supported environment and status

| Surface | Environment | Current state |
|---|---|---|
| Worker and scheduler | deployment-managed Node.js/TypeScript host | Implemented |
| Chromium execution | approved patched binary selected by deployment | Implemented |
| Firefox execution | approved patched binary selected by deployment | Implemented |
| Public submission and receipt verification | `weles-client` | Separate public contract |
| Hosted self-service executor | — | Not published |
| Arbitrary website automation | — | Not supported |

## Core use cases

### Execute one approved trajectory

- **Actor:** an authorized service submitting through the safe client boundary.
- **Initial state:** organization, exact origin, allowlisted action, credential
  references, justification, idempotency key, and evidence policy are present.
- **Outcome:** one worker claims the task, executes the reviewed trajectory, and
  records a terminal result with evidence metadata.
- **Boundary:** no trajectory is synthesized from the request and no unapproved
  origin or action is substituted.

### Recover a scheduled worker

- **Actor:** a Weles runtime operator.
- **Initial state:** a claimed task or browser process has failed, timed out, or
  lost its lease.
- **Outcome:** scheduler state classifies the failure and permits only the
  configured bounded recovery path.
- **Boundary:** an ambiguous effect is not silently retried as if nothing
  happened.

### Verify browser-identity capture

- **Actor:** a runtime engineer qualifying an approved browser build.
- **Initial state:** the deployment selects an exact browser binary and capture
  policy.
- **Outcome:** the run records the channels listed in the canonical fingerprint
  capture inventory for review.
- **Boundary:** capture evidence describes the run; it does not prove target
  authorization or universal browser indistinguishability.

## How Weles works

```text
safe Weles client
  -> admitted organization + origin + action + credential references
  -> scheduler row and atomic claim
  -> supervised worker
  -> deployment-selected browser and reviewed trajectory
  -> result + evidence metadata + signed service receipt
```

The scheduler is authoritative for task ownership and terminal state. The
trajectory owns target-specific interaction. The browser runtime owns
engine-level identity behavior. The secret boundary owns credential material.
The public client owns input validation and receipt verification. None of these
layers may silently assume another layer's authority.

## Operator quick start

There is no public executor quick start. A source build alone is not an
authorized deployment. Runtime operators must use the reviewed deployment path:

```bash
npm install
npm run build
node scripts/worker/run.mjs
```

Before starting the worker, provision the exact environment, database contract,
approved browser binaries, credential sources, trajectory allowlist, and service
supervision described in
[`scripts/worker/deploy/README.md`](scripts/worker/deploy/README.md). Starting
without those inputs is configuration work, not a successful Weles workflow.

A product-level first success is an approved client submission that reaches one
terminal result and whose receipt and evidence digest verify against the
configured public key. Do not use a synthetic public target as a substitute for
that authorization chain.

## Database schema

The worker database schema is owned by
[`wisent-ai/wisent-supabase-echo`](https://github.com/wisent-ai/wisent-supabase-echo),
which is the only source of truth for the Supabase project `yqizdfkfnmhddfemdxtq`.
Every DDL change — tables, columns, indexes, policies, functions, and the
`weles_schema_migrations` ledger row that records it — is proposed as a pull
request in that repository and applied only by its CI on `main`. This repository
holds no migrations, no `supabase/config.toml`, and no linked-project state;
`supabase/` is gitignored so a local `supabase`-CLI `link` cannot reintroduce
them.

No one runs the `supabase` CLI locally against production. Applying DDL by hand
from a workstation — `db query`, `db push`, or any other write subcommand
against the production project — bypasses the review and deployment gate and is
prohibited. The repository pre-commit hook additionally refuses to commit
`supabase`-CLI invocations.

What this repository declares is the schema version it requires. At startup
`src/worker/schema_compatibility.ts` reads the highest `version` from the
`weles_schema_migrations` table over the Supabase REST endpoint
(`/rest/v1/weles_schema_migrations?select=version&order=version.desc&limit=1`)
and refuses to run unless that version falls inside an inclusive range:

- `WELES_DATABASE_SCHEMA_MINIMUM`, default `4`
- `WELES_DATABASE_SCHEMA_MAXIMUM`, default `5`

Both defaults are the literals in `assertDatabaseCompatibility`
(`env.WELES_DATABASE_SCHEMA_MINIMUM ?? '4'`, `env.WELES_DATABASE_SCHEMA_MAXIMUM ?? '5'`),
so an unconfigured deployment accepts schema versions `4..5`; the deployment
environment may narrow or advance the range, but only positive integers with
minimum not greater than maximum are accepted. A ledger that is empty,
unreadable, or outside the range is a startup failure, not a warning. Widening
that range is a code change here; producing the schema version it points at is a
change in `wisent-supabase-echo`.

## Primary interfaces

- **Worker process:** `node scripts/worker/run.mjs` for the deployment-managed
  scheduler loop.
- **CLI:** the built `weles` binary for explicitly exposed operator actions.
- **MCP:** the built `weles-mcp` surface where enabled by deployment policy.
- **Public client:** `@wisent-ai/weles-client` for safe submission,
  cancellation, and receipt verification.
- **Deployment contract:** `scripts/worker/deploy/README.md` for environment,
  service supervision, and browser selection.

## Operational model

- **Configuration:** deployment-owned environment and reviewed trajectory
  inventory; no repository default authorizes a live target.
- **State:** scheduler rows are canonical for claims and outcomes; recordings
  and capture artifacts follow the configured evidence policy.
- **Credentials:** workloads submit opaque references. Runtime acquisition is
  scoped and credential plaintext must not enter prompts, task JSON, or logs.
- **Observability:** structured task state, process diagnostics, evidence
  metadata, and the fingerprint capture inventory distinguish execution failure
  from missing authorization or unavailable infrastructure.
- **Recovery:** leases and terminal classifications bound replay. Operators must
  resolve ambiguous external effects before resubmission.
- **Cost:** browser hosts, proxies, storage, and external services are operated
  costs; this repository does not publish pricing or a hosted entitlement.

## Project status and support

- **Maturity:** private operated executor, package version `0.5.0`.
- **Distribution:** no public executor release or support commitment.
- **Public integration:** use `wisent-ai/weles-client`; source availability of a
  client does not imply availability of the executor service.
- **Security:** report vulnerabilities through the repository's private GitHub
  Security Advisory channel; never place credentials, trajectories, recordings,
  or target details in a public issue.
- **License:** the current repository declares MIT; distribution and browser
  patch obligations require separate review before any executor release.
