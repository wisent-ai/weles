# Authorization model

Who may run what, and where is that decided? Weles answers with layered,
explicit allowlists: the caller's client refuses first, admission accepts a
schema-versioned request second, and the executing host re-checks its own
authority before every single claim. No layer trusts the previous one, and
possession of a credential authorizes nothing.

## The submission contract

Every workflow enters as a `weles.task.current` document built by the public
[`@wisent-ai/weles-client`](https://github.com/wisent-ai/weles-client). The
client refuses locally, before any network request:

- `origin` must be in the client's non-empty exact-origin allowlist, HTTPS (or
  HTTP on localhost), with no path, credentials, query, or fragment;
- `action` must be in the client's non-empty exact-action allowlist;
- `input` must contain no key matching password, secret, token, cookie,
  authorization, or proxy-auth patterns — credentials travel only as opaque
  `credentialRefs`;
- `justification` is a required human-readable sentence; cancellation likewise
  requires a `reason`;
- every submit and cancel carries an `Idempotency-Key` (caller-provided or a
  generated UUID) and the organization ID.

The versioned schemas — `weles.task.*`, `weles.cancellation.*`,
`weles.task-status.*`, `weles.receipt.*`, `weles.version.*` with stable
`current` aliases — and the minimum client version are declared in
`release/compatibility-policy.json` and reported in each worker's release
identity; at startup the worker separately refuses to run against a database
whose schema ledger is outside its supported range
(`src/worker/schema_compatibility.ts`).

## The boundary, stated once

The first-use journey (`src/onboarding.ts`) is the canonical statement:

> Weles executes only an already-authorized, allowlisted workflow. Possessing
> credentials does not authorize a new origin or action; organization, origin,
> action, credential references, justification, idempotency, and evidence
> policy must be admitted through the safe Weles client before this host runs
> anything.

Two corollaries from the README: draft discovery can map a new journey but
does not authorize it as a production action, and a technically successful
run does not establish that the target permits automation — target
authorization stays with the caller.

## Host-side authorization

Admission puts a row in the action log; whether any given host may run it is
decided again on the host, per claim (`src/worker/claim.ts`,
`src/worker/placement-policy.ts`):

| Gate | Authority |
|---|---|
| `WELES_ACTION_ALLOWLIST` | The launcher's hard bound on what this binary may ever run: unique, exact, lowercase action names, validated at startup |
| Placement policy | The control plane's per-host action list at `~/.config/weles/placement-policy.json`, published by `stado host publish-placement-policy <host>`; a document without a valid `_source` stamp (registry generation, `published_at`, `by`) is refused entirely and the host claims nothing |
| Intersection | The claimable set is policy ∩ allowlist; a wildcard host policy claims the whole allowlist; an empty intersection is reported as a standing denial, distinct from an empty queue |
| Deployment lease | With `WELES_DEPLOYMENT_ID` set, every claim writes `lease_deployment_id` and a positive `lease_generation`; the production database lease rejects queued-to-running claims from any deployment other than the active production generation |
| `WELES_CLAIMS_ENABLED=0` | Launcher-level off switch; non-production ring workers are built with claiming disabled |
| Evidence preflight | The worker refuses to claim anything unless private artifact storage is provably writable — a workflow it cannot record does not run (`src/worker/poll.ts`) |

Some actions carry a per-run authorization on top. Apple-authenticated actions
require a previously issued one-attempt authorization
(`scripts/auth/authorize-apple-login.mjs`): the row must be pinned to the
exact execution host and agent, the worker claims the authorization with a
lease and resolves a capability envelope before spawning, and any pre-spawn
failure cancels the capabilities and the authorization. An action that could
submit a password outside that guard (`apple_ads_api_setup_probe`) is refused
outright.

## The credential-lifecycle entry point

Credential operations are workflows too, and they enter through the same
admission surface rather than a side door. The public bridge
`weles-skarbiec-acquire-admission.mjs` (in `weles-client`) maps the
`skarbiec.credential-operation.v3` wire onto the admission route
`POST /v1/echo/secrets/acquire`:

- the request names an exact `credential_id`, `provider`, `field`, `consumer`,
  `purpose`, and one explicit operation — `acquire`, `adopt`, `rotate`,
  `reset`, `verify`, or `remove` — plus a 64-hex `request_id` bound to the
  idempotency key;
- the bridge accepts no credential material on stdin and returns none on
  stdout; request buffers are zeroed after parsing;
- the admission origin must be HTTPS, or HTTP only on a loopback host, with no
  credentials, query, or fragment;
- responses settle to a closed status set: `operation_plan`,
  `operation_queued`, `operation_completed`, `needs_configuration`,
  `needs_human_approval`, `unsupported_operation`, `unsupported_secret`,
  `operation_failed`. An operation paused as `needs_human_approval` continues
  only through an explicit resume with its approval ID and single-use resume
  token — never by resubmitting.

On the executor side, `acquireSecret` (`src/secrets/acquire.ts`) resolves the
request against a fixed secret registry — each item pins its provider, stored
field, allowed operations, and (for directory identities) the exact directory
binding — and refuses with a reason instead of guessing. Missing writer,
reader, account, or tenant bindings return `needs_configuration` before any
provider action is queued.

The worker's own runtime credentials follow the same philosophy: no standing
bearer anywhere. Each read is a workload-bound Skarbiec acquisition — an
owner-only Ed25519 key signs a fresh timestamp and nonce, the returned
short-TTL bearer is used exactly once, and the field maps directly into the
requesting process, never a file (`scripts/worker/deploy/README.md`). The
acquisition-scopes contract is a nonsecret `consumer|item|field` catalog with
exact names only; wildcards, globs, and duplicates fail before a proof is
signed.

What authorization produces when it all passes — a claimed row, a reviewed
trajectory, and a terminal state with evidence — is described in
[workflows](workflows.md) and [receipts](receipts.md).
