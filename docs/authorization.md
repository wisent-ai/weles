# Authorization model

Who may run what, and where is that decided? Weles answers with layered,
explicit allowlists: the caller's client refuses first, admission accepts a
schema-versioned request second, and the executing host validates every queued
payload against its own dispatch table before spawning anything. No layer
trusts the previous one, and possession of a credential authorizes nothing.

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
`release/compatibility-policy.json` and reported as `api_schemas` in each
worker's immutable release identity (`src/worker/deployment_version.ts`).

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

Admission accepts a request; whether a host runs it is decided again on the
host, at the moment a payload turns into a process:

| Gate | Authority |
|---|---|
| Runner payload validation | Every queued job executes `scripts/worker/stado-action-runner.mjs` with one base64url payload. It refuses `invalid Weles action` unless the action matches `^[a-z][a-z0-9_]{0,127}$`, `invalid Weles account item` unless any account item matches `^weles-[a-z0-9][a-z0-9-]{0,126}$`, and `invalid Weles action params` unless params is a plain object. The producers enforce the same shapes before `stado submit` ever runs (`src/state/skarbiec-records.ts`, `scripts/_shared/stado-action-queue.mjs`) |
| Dispatch table | The action must resolve through `resolveTrajectory` to a checked-in trajectory or the run dies with `no Weles trajectory for <action>`; the dispatch table (`src/worker/dispatch.ts`) is the host's executable allowlist |
| API bearer | The synchronous runner (`scripts/worker/weles-api-server.mjs`) binds `127.0.0.1` by default and answers only requests carrying `WELES_API_TOKEN` (or `WELES_CONSOLE_API_TOKEN`) as `Authorization: Bearer` or `x-api-key`; only an explicit `WELES_API_ALLOW_UNAUTH=1` waives that |
| Placement | The host's placement policy is an operator-edited file at `~/.config/weles/placement-policy.json` (override: `WELES_PLACEMENT_POLICY_FILE`) — its own header states "there is no Stado command for it because the file lives outside every delivery prefix" (`scripts/worker/deploy/grant-placement-action.sh`). The deploy helpers only narrow: `grant-placement-action.sh` adds actions but refuses `action is not in the launcher allowlist: <name>` for anything absent from the shipped `weles-action-allowlist.txt`, and keeps the previous policy at `<policy>.before-grant`; `weles-execution-placement.sh` reports or flips a per-host `enabled` flag, and an entry it has to create starts `"enabled": false` |

Some actions carry a per-run authorization on top. Apple-authenticated actions
require a previously issued one-attempt authorization
(`scripts/auth/authorize-apple-login.mjs`): the script refuses unless
`--confirm` exactly equals `AUTHORIZE ONE APPLE LOGIN`, the account item
matches `^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$`, and an execution
host is named. It then issues three one-use (`--max-uses 1`) Skarbiec
capabilities with a 1–60-minute TTL, all bound to a fresh guard UUID, and
queues one `apple_login` job pinned to that host (`--pinned-host` in
`scripts/_shared/stado-action-queue.mjs`); any failure cancels every
capability already issued. The dispatcher refuses to spawn the trajectory
without the guard id, execution host and agent, and the capability envelope —
`apple_login_capabilities are required for apple_login`
(`src/worker/dispatch.ts`).

## The credential-lifecycle entry point

Credential operations are workflows too, and they enter through the same
admission surface rather than a side door; the noun page is
[credential operations](credential-operations.md). Two public bridges in
[`weles-client`](https://github.com/wisent-ai/weles-client) carry the
`skarbiec.credential-operation.v3` wire: `weles-skarbiec-acquire-admission.mjs`
POSTs the request to the admission route `/v1/echo/secrets/acquire` and
accepts the operations `acquire`, `rotate`, `verify`, and `remove`;
`weles-skarbiec-acquire.mjs` submits the allowlisted
`skarbiec_credential_acquire` action through the standard `WelesClient` and
validates all six operations — `acquire`, `adopt`, `rotate`, `reset`,
`verify`, `remove` — against a fixed per-credential contract. In both:

- the request names an exact `credential_id`, `provider`, `field`, `consumer`,
  and a 64-hex `request_id`; the task-submitting bridge binds that
  `request_id` to the idempotency key;
- the bridge accepts no credential material on stdin and returns none on
  stdout; request buffers are zeroed after parsing;
- the target origin must be HTTPS, or HTTP only on a loopback host, with no
  credentials, query, or fragment;
- responses settle to a closed status set: `operation_plan`,
  `operation_queued`, `operation_completed`, `needs_configuration`,
  `needs_human_approval`, `unsupported_operation`, `unsupported_secret`,
  `operation_failed`. An operation paused as `needs_human_approval` continues
  only through an explicit resume with its approval ID and resume token — a
  repeated submit is not a resume path.

On the executor side, `acquireSecret` (`src/secrets/acquire.ts`) resolves the
request against a fixed secret registry — each item pins its provider, stored
field, allowed operations, and (for directory identities) the exact directory
binding — and refuses with a reason instead of guessing. Missing writer,
reader, account, or identity bindings return `needs_configuration` before
anything is queued; what queues is a Stado job, never a side channel. Statuses
and exact refusal sentences are catalogued in
[credential operations](credential-operations.md).

The worker's own runtime credentials follow the same philosophy: no standing
bearer anywhere. Each read is a workload-bound Skarbiec acquisition — an
owner-only Ed25519 key signs a fresh timestamp and nonce, the returned
short-TTL bearer is used exactly once, and the field maps directly into the
requesting process, never a file (`scripts/worker/deploy/README.md`). The
acquisition-scopes contract is a nonsecret `consumer|item|field` catalog with
exact names only; wildcards, globs, and duplicates fail before a proof is
signed.

What authorization produces when it all passes — a queued job, a reviewed
trajectory, and a terminal state with evidence — is described in
[workflows](workflows.md) and [receipts](receipts.md).
