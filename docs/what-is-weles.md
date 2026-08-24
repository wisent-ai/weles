# What is Weles

What is Weles, and what is the mental model for reading everything else in
these docs? Weles is a browser-workflow executor that runs only explicitly
authorized work and closes every run with recorded evidence. The whole product
is three moving parts: authorization admits a workflow, an approved worker
executes it, and evidence — up to a cryptographically signed receipt — proves
what happened.

## Authorization admits the work

Nothing runs because somebody asked; something runs because an admitted,
allowlisted row exists. A caller submits through the public
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

## Approved workers execute

Admitted work lands as rows in an action log; workers claim rows, never
receive pushes. A worker claims a row only when every independent gate passes:
its launcher action allowlist (`WELES_ACTION_ALLOWLIST`), the registry-derived
host placement policy (refused entirely unless stamped by
`stado host publish-placement-policy`), the production deployment lease
(`WELES_DEPLOYMENT_ID` + `WELES_DEPLOYMENT_GENERATION`), and a preflight that
proves evidence storage is writable — a worker must never run a workflow it
cannot record (`src/worker/claim.ts`, `src/worker/poll.ts`).

The claimed action resolves to a checked-in trajectory
(`src/worker/dispatch.ts`) and executes in a browser build that launches only
when its local install receipt matches the exact immutable release coordinate
and checksum selected for the deployment (`src/session/find_browser.ts`).
There is no stock-browser fallback. See [workflows](workflows.md) and
[worker lifecycle](worker-lifecycle.md).

## Evidence closes the run

Every run ends in exactly one terminal state — `completed`, `failed`,
`pending_review`, or `cancelled` — and the worker uploads the complete run
tree (recordings, session provenance, captcha events, ban signal) to private
storage before publishing any result locator (`src/worker/poll.ts`). Runs
flagged for verification get a model verdict of `pass`, `fail`, or
`uncertain`; anything but a confident pass parks the row as `pending_review`
(`src/worker/verification.ts`).

Deployments with receipt issuance close the loop cryptographically: the
terminal response carries a receipt whose signed payload binds task,
organization, origin, action, outcome, and evidence digest, and the public
`weles-client` verifies it offline against caller-owned public keys. An
unknown key fails closed. See [receipts](receipts.md).

## What Weles is not

Weles is not a hosted endpoint you get from a source checkout: the executor
and client are public MIT/Apache-licensed source, but approved trajectories,
managed credentials, evidence retention, and an SLA are provisioned per
organization (README). Weles is not a secret store: the worker launcher
accepts no database service-role, provider API key, or platform password from
its env file; every credential read is a workload-bound Skarbiec acquisition
signed by an owner-only key, with no standing bearer
(`scripts/worker/deploy/README.md`). And Weles is not an authorization
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
