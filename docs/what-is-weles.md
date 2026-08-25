# What is Weles

What is Weles, and what is the mental model for reading everything else in
these docs? Weles is a browser-workflow executor that runs only explicitly
authorized work and closes every run with recorded evidence. The whole product
is three moving parts: authorization admits a workflow, an approved host
executes it, and evidence — up to a cryptographically signed receipt — proves
what happened.

## Authorization admits the work

Nothing runs because somebody asked; something runs because an admitted,
allowlisted workflow exists. A caller submits through the public
[`@wisent-ai/weles-client`](https://github.com/wisent-ai/weles-client), and
every submission names, explicitly:

- the organization, an exact `origin`, and an exact `action` — both checked
  against the client's own non-empty allowlists before any network request;
- opaque `credentialRefs` instead of secrets — input keys that look like
  passwords, tokens, cookies, or authorization material are rejected
  client-side;
- a human-readable `justification` and an `evidencePolicy`;
- an idempotency key.

Possessing credentials does not authorize a new origin or action. The bundled
first-use journey states the boundary directly: organization, origin, action,
credential references, justification, idempotency, and evidence policy must be
admitted through the safe Weles client before a host runs anything
(`src/onboarding.ts`). A technically successful run does not establish that
the target permits automation; authorization for the target remains with the
caller. The full model, including how credential-lifecycle operations enter
the system, is in [authorization](authorization.md).

## Approved hosts execute

Admitted work becomes a Stado job, never a push: `enqueueAction` encodes
`{action, accountItem, params}` as one base64url payload and submits
`node scripts/worker/stado-action-runner.mjs <payload>` through `stado submit`
(`src/state/skarbiec-records.ts`). On the host, the runner re-validates the
payload from scratch — action shape, Skarbiec account-item shape, plain-object
params — and refuses anything that does not resolve to a checked-in
trajectory: `no Weles trajectory for <action>`
(`scripts/worker/stado-action-runner.mjs`). An operator can also run the same
trajectory synchronously through the localhost Weles HTTP API
(`scripts/worker/weles-api-server.mjs`), which demands `WELES_API_TOKEN` and
reuses the identical dispatch functions, so both paths run byte-identically.

The action resolves to a checked-in trajectory
(`src/worker/dispatch.ts`) and executes in a browser build that launches only
when its local install receipt matches the exact immutable release coordinate
and checksum selected for the deployment (`src/session/find_browser.ts`).
There is no stock-browser fallback. See [workflows](workflows.md) and the
[execution model](worker-lifecycle.md).

## Evidence closes the run

Every run leaves a complete evidence tree under `recordings/<run-id>/` —
session provenance (`session_meta.json`), the captcha event log, the ban
signal, recordings — written by the trajectory's own session
(`src/session/wsession.ts`). `uploadArtifacts` mirrors that whole tree to
private Stado objects, and a result locator may be published only after Stado
acknowledges the exact canonical URI of every object
(`src/worker/upload-artifacts.ts`). The queued runner propagates the
trajectory's exit code and re-raises its fatal signal, so the Stado job's
terminal status is the trajectory's own
(`scripts/worker/stado-action-runner.mjs`).

Deployments with receipt issuance close the loop cryptographically: the
terminal response carries a receipt whose signed payload binds task,
organization, origin, action, outcome, and evidence digest, and the public
`weles-client` verifies it offline against caller-owned public keys. An
unknown key fails closed. See [receipts](receipts.md).

## What Weles is not

Weles is not a hosted endpoint you get from a source checkout: the executor
and client are public MIT/Apache-licensed source, but approved trajectories,
managed credentials, evidence retention, and an SLA are provisioned per
organization (README). Weles is not a secret store: accounts, runtime
settings, and run records are Skarbiec vault items
(`src/state/skarbiec-records.ts`), and every credential operation is queued
against an exact Skarbiec acquisition contract that fails closed when the
scoped writer or reader grant is missing
(`src/secrets/acquire.ts`). And Weles is not an authorization
authority for third-party sites: draft discovery can map a journey, but it
does not authorize that journey as a production action.

## The first three commands

```bash
weles doctor
```

Prints a JSON report of the installed version, Node version, registered
binaries, and whether the browser-selection environment is set.

```bash
weles open https://example.com --headless --text
```

Launches the verified Weles browser, navigates, and prints URL, title, HTTP
status, and body text as JSON. Fails with `WELES_CHROMIUM_BINARY_NOT_FOUND`
until the exact configured browser release is installed — see
[quick-start](quick-start.md).

```bash
weles onboarding status
```

Starts the durable first-use journey. It explains the authorization boundary
and approved-host execution, launches no browser automation, and completes
only after `weles onboarding verify` cryptographically verifies a real
workflow receipt ([cli](cli.md)).
