# Credential operations

What is a credential operation, and why does acquiring an API key look exactly
like running any other workflow? Because it is one: a credential operation is
a Weles workflow that ends with a value inside Skarbiec instead of a value in
the response. It is planned by `buildSecretAcquisitionPlan`, queued by
`acquireSecret` as a Stado job, performed by a checked-in trajectory, and
persisted through scoped Skarbiec writes — never returned to the caller
(`src/secrets/acquire.ts`). How such an operation is admitted in the first
place is covered in [authorization](authorization.md).

## The six operations

`CredentialOperation` is a closed set (`src/secrets/acquire.ts`):

| Operation | Meaning | Supported by |
|---|---|---|
| `acquire` | Obtain a brand-new credential from the provider and commit it to Skarbiec | Every registry secret (their only operation) |
| `adopt` | The current password is already known and staged in Skarbiec: prove it with a fresh login, never change it at the provider | Microsoft account and Entra directory passwords |
| `rotate` | Generate a new strong password in-process, change it at the provider, verify with a fresh login, then commit | Microsoft account and Entra directory passwords |
| `verify` | Perform a fresh password authentication and rewrite the same managed value only after the provider accepts it | Microsoft account and Entra directory passwords |
| `reset` | The current password is unknown: drive self-service reset, pausing as `needs_human_approval` for every interactive identity verification | Entra directory passwords only |
| `remove` | Reserved on the wire; no secret definition currently lists it, so the executor refuses it as `unsupported_operation` | Nothing in the current tree |

A request without an `operation` defaults to `acquire`.

## The request

`AcquireSecretRequest` (`src/secrets/acquire.ts`) carries: `operation`,
`credentialId`, `provider`, a 64-hex `requestId`, `secret`, `purpose`, `goal`,
`dryRun`, `autoPromoteTrajectory`, `proxy`, `headless`, `priority`,
`tenantId`, `accountEmail`, and — for directory identities — `accountUpn` and
`principalObjectId`. `normalizeSecret` resolves what is being asked for: a
`credentialId` matching the managed-password shape
`^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$` wins
outright; otherwise an explicit `secret` name is lowercased and
underscore-normalized; otherwise keywords in `goal` select a registry entry;
otherwise the request is `unsupported_secret`. For a managed-password id the
requested `provider` selects which lifecycle owns the item —
`microsoft_entra` or consumer `microsoft` — so a directory identity is never
administered through a consumer-account surface.

No plaintext travels in either direction: the request has no secret-value
field, and every result variant carries ids, statuses, and messages only.

## The fixed secret registry

`SECRET_REGISTRY` is a closed table; a secret outside it cannot be acquired.
Four secrets exist, each reachable under exact aliases
(`src/secrets/acquire.ts`):

| Secret | Provider | Skarbiec item (field) | Source origin |
|---|---|---|---|
| `semantic_scholar.api_key` | `semantic_scholar` | `weles-semantic-scholar-api` (`api_key`) | `https://www.semanticscholar.org` |
| `github.admin_org_token` | `github` | `weles-github-admin-org-token` (`api_key`) | `https://github.com` |
| `figma.personal_access_token` | `figma` | `weles-figma-personal-access-token` (`api_key`) | `https://www.figma.com` |
| `snapchat.snap_kit_api_token` | `snapchat` | `weles-snapchat-snap-kit-api` (`api_key`) | `https://kit.snapchat.com` |

Each definition pins the provider, display name, environment variable names,
the acquisition form URL, flow name, requested scopes, endpoints, expected
daily requests, and `storeSecretTarget: 'skarbiec'`. The Skarbiec item, field,
and source origin come from the matching entry in
`ACQUIRED_SECRET_CONTRACTS` (`src/secrets/scoped-service.ts`); a definition
without its contract throws
`missing exact Skarbiec acquisition contract for <secret>`.

Managed Microsoft passwords are not registry rows: any credential id matching
the managed-password shape resolves to a synthesized definition —
`operations: ['adopt', 'rotate', 'verify']` for the consumer lifecycle at
`account.live.com`, `operations: ['adopt', 'rotate', 'reset', 'verify']` for
the Entra lifecycle at `login.microsoftonline.com`. Which ids belong to the
Entra lifecycle is an enumerated set in `src/secrets/scoped-service.ts`, so a
new id cannot silently inherit the consumer origin.

## Lifecycle: plan → queue → perform → persist

1. **Plan.** `buildSecretAcquisitionPlan` (or `acquireSecret` with
   `dryRun: true`) returns `operation_plan`: the URL, the full natural-language
   objective the trajectory will receive, and the parameter document —
   without queueing anything. An Entra plan without its sealed coordinates is
   refused as `needs_configuration` rather than handed back as a plan nobody
   can execute.
2. **Queue.** `acquireSecret` enqueues one Stado job through `enqueueAction`
   (`src/state/skarbiec-records.ts`): the action name must match
   `^[a-z][a-z0-9_]{0,127}$`, any account item must match
   `^weles-[a-z0-9][a-z0-9-]{0,126}-account$`, and the payload is submitted as
   `stado submit "node scripts/worker/stado-action-runner.mjs <base64url>"`.
   Acquisitions queue `generic_keeper_task`; Microsoft password operations
   queue `microsoft_adopt_password`, `microsoft_reset_password`, or
   `microsoft_verify_password`; Entra operations queue the
   `microsoft_entra_*` equivalents.
3. **Perform.** The runner re-validates the payload, resolves the action
   through the dispatch table (`src/worker/dispatch.ts`), and spawns the
   trajectory. The objective forbids emitting the credential: the trajectory
   calls `store_credential` on the visible credential element and finishes
   only after the exact encrypted Skarbiec item/field write is confirmed.
4. **Persist.** Values reach the vault only through scoped writes.
   `returnCredentialToSkarbiec` (`src/secrets/skarbiec-return.ts`) runs the
   command named by `SKARBIEC_CREDENTIAL_RETURN_COMMAND`, refusing unless it
   is an absolute, regular, non-symlink file owned by the current user,
   owner-executable, and not group/world-writable; credential ids must match
   `^[A-Z0-9_]{3,128}$`, request ids `^[a-fA-F0-9]{64}$`, and secrets are
   capped at 16 KiB.

## Result statuses

`AcquireSecretResult` is a closed union (`src/secrets/acquire.ts`):

| Status | Meaning |
|---|---|
| `operation_plan` | Dry run: URL, objective, and params returned, nothing queued |
| `operation_queued` | One Stado job enqueued; carries the `actionLogId` (job id), action, and flow name |
| `followup_queued` | The Semantic Scholar mailbox follow-up (`semanticscholar_key_followup`) is scheduled to collect a key delivered by email; idempotent per source action (`src/secrets/semantic-scholar-followup.ts`) |
| `needs_configuration` | A required binding is missing; the `missing` array names each one, and nothing was queued |
| `unsupported_operation` | The operation is outside the secret's allowed set |
| `unsupported_secret` | No registry entry, or the registry entry belongs to a different provider |

Three further statuses never come from `acquireSecret`: the executing
trajectory settles `operation_completed`, `needs_human_approval`, and
`operation_failed`, and the `weles-client` bridges accept exactly this
eight-status set and nothing else.

### Queue confirmations, verbatim

- `Microsoft password <operation> queued; Skarbiec remains pending until
  fresh-login verification activates the staged candidate` (adopt) or
  `… rewrites the managed item` (rotate, verify).
- `Entra password <operation> queued; Skarbiec remains pending until the
  fresh-login identity assertion rewrites the managed item`.
- `<display name> API key acquisition queued via generic_keeper_task`.

### Refusals, verbatim

`unsupported_secret`:

- `No secret acquisition registry entry for <secret>`
- `Credential <secret> is not registered for provider <provider>`

`unsupported_operation`:

- `<operation> is not supported for <secret>`
- `<operation> is not supported for a Microsoft account password`
- `<operation> is not supported for a Microsoft Entra directory password`

`needs_configuration` messages:

- `Cannot enqueue Weles acquisition without <missing…>`
- `Microsoft password operations require one exact account email`
- `Cannot enqueue Microsoft password <operation> without <missing…>`
- `Cannot enqueue Entra password <operation> without <missing…>`
- `Cannot plan <operation> for <secret> without <missing…>` (plan-time Entra
  refusal; its `missing` items are `one exact account UPN`,
  `one exact tenant id`, `one exact principal object id`)

The `missing` vocabulary is itself exact:

- `one exact credential operation request id` — `requestId` failed
  `^[a-f0-9]{64}$`
- `one exact Microsoft account email` / `one exact Entra account UPN` /
  `one exact lowercase Entra tenant id` /
  `one exact lowercase Entra principal object id`
- `one uniquely matching active Microsoft account` /
  `one uniquely matching active account bound to the requested Entra identity`
- `scoped Skarbiec writer for <secret>` — the writer token file is absent
- `tenant-scoped Skarbiec reader for <secret>/password` (consumer Microsoft)
  and `scoped Skarbiec reader for <secret>/password` (Entra; skipped for
  `reset`, which by definition starts without the current password)
- `exact Skarbiec password contract for <secret>` and
  `Entra credential source origin https://login.microsoftonline.com for
  <secret>` — contract-shape checks on the Entra path
- account-binding conflicts, reported verbatim from the binding check:
  `credential item is already bound to another Microsoft account`,
  `Microsoft account is already bound to another credential item`,
  `Microsoft account is not bound to the requested managed credential`,
  `more than one active account claims the requested Entra UPN`,
  `account record is missing metadata entra_upn <upn>` (likewise
  `entra_tenant_id`, `entra_principal_object_id`),
  `credential item is already bound to another Entra account`,
  `Entra account is already bound to another credential item`,
  `Entra account is not bound to the requested managed credential`

## Invariants

- **No plaintext, anywhere.** The submitting client refuses input keys that
  look like passwords, secrets, tokens, cookies, or authorization material
  (`Send a credential reference instead of sensitive plaintext`,
  `weles-client` `src/index.mjs`); results carry only ids and messages; the
  trajectory objective forbids passing the credential to `done`, logs, tool
  arguments, or result data.
- **Writer and reader are separate scoped grants**
  (`src/secrets/scoped-service.ts`). The writer exists only if the contract's
  owner-only token file is present (under `~/.stado/`, or the tenant binding
  directory) and the Skarbiec endpoint resolves; an unsafe token file —
  symlink, wrong owner, group/world access — raises
  `refusing unsafe scoped Skarbiec token file for <file>`. The reader exists
  only if the exact `consumer|item|field` row appears in the acquisition
  scope catalog, resolved from this revision's own
  `scripts/worker/deploy/skarbiec-acquisition-scopes.conf`; wildcards, globs,
  blank components, and duplicate rows are invalid by the file's own grammar.
- **The endpoint is checked, not trusted.** `WELES_SKARBIEC_URL` must be
  HTTPS or loopback HTTP and carry no credentials, query, or fragment;
  tenant-scoped operations read their endpoint from an owner-only,
  permission-checked tenant directory instead.
- **Identity is bound before anything queues.** A password operation queues
  only against exactly one active account record whose metadata is bound to
  the requested credential item — and, for Entra, whose recorded UPN, tenant
  id, and principal object id all match the request.

## How weles-client bridges admission

Self-hosted callers do not import `acquireSecret`; they speak the
`skarbiec.credential-operation.v3` wire through the two bridges shipped in
[`weles-client`](https://github.com/wisent-ai/weles-client):
`weles-skarbiec-acquire-admission.mjs` maps the wire onto the admission route
`POST /v1/echo/secrets/acquire` (operations `acquire`, `rotate`, `verify`,
`remove`), and `weles-skarbiec-acquire.mjs` submits the allowlisted
`skarbiec_credential_acquire` action with the `request_id` as idempotency key,
validating all six operations against its per-credential contract and
resuming a paused approval only via an explicit `resume` mode with the exact
approval id and resume token. Both refuse credential material on stdin,
return none on stdout, and settle to the same eight-status set. The bridge
wire, approval resource, and diagnostics are documented in the
`weles-client` README; the admission-side authorization model is in
[authorization](authorization.md).
