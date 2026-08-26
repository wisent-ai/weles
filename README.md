<!-- wisent-banner:start -->
<p align="center">
  <img src="assets/readme-banner.webp" alt="weles by Wisent" width="100%">
</p>
<!-- wisent-banner:end -->

<!-- wisent-readme-signals:start -->
[![Source](https://img.shields.io/badge/GitHub-Source-181717?logo=github)](https://github.com/wisent-ai/weles) [![Issues](https://img.shields.io/badge/GitHub-Issues-181717?logo=github)](https://github.com/wisent-ai/weles/issues) [![Wisent](https://img.shields.io/badge/Wisent-Website-0B0B0B)](https://wisent.com) [![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/qRjpkthq54) [![LinkedIn](https://img.shields.io/badge/LinkedIn-Follow-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/company/wisent-ai/) [![X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/wisentai) [![Enterprise](https://img.shields.io/badge/Enterprise-Book%20a%20call-0B0B0B?logo=calendly)](https://calendly.com/lbartoszcze)
<!-- wisent-readme-signals:end -->

[![Weles documentation](https://img.shields.io/badge/Docs-weles.wisent.com%2Fdocs-0B0B0B?style=for-the-badge)](https://weles.wisent.com/docs) [![Latest Weles worker release](https://img.shields.io/badge/Release-worker--v0.5.6-2E7D32?style=for-the-badge)](https://github.com/wisent-ai/weles/releases/latest) [![Weles release downloads](https://img.shields.io/badge/Downloads-69-1F6FEB?style=for-the-badge)](https://github.com/wisent-ai/weles/releases) [![Weles main build status](https://img.shields.io/badge/Build-passing-2E7D32?style=for-the-badge)](https://github.com/wisent-ai/weles/actions/workflows/build-check.yml?query=branch%3Amain) [![Weles MIT license](https://img.shields.io/badge/License-MIT-6F42C1?style=for-the-badge)](LICENSE) [![Join Wisent on Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/qRjpkthq54) [![Follow Wisent on LinkedIn](https://img.shields.io/badge/LinkedIn-Follow-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/wisentai/) [![Follow Wisent on X](https://img.shields.io/badge/X-Follow-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/wisentai) [![Book a call for enterprise Weles implementation](https://img.shields.io/badge/Enterprise-Book%20a%20call-B8F2C2?style=for-the-badge&logo=calendly&logoColor=0B0B0B)](https://calendly.com/lbartoszcze)

# Weles: Undetectable Browser for Perfect AI Agent Internet Use

Your AI agents deserve to explore the entire internet. AI can now write
software, reason for hours, and order your groceries, but it still fails or
takes ages when you ask it to open a website and log in to your account.

Weles is the solution. We turn the open internet into an API.

Weles is an undetectable browser that combines custom C++-patched Chromium and
Firefox forks with rotating fingerprints to stop your AI from running into
CAPTCHAs and bans. Every time you crawl a website, it gets mapped into a
trajectory, allowing future runs to use the cached traversal instead of having
to rediscover how the website works. When a run fails, Weles records videos
showing the points of failure to give you a clear understanding of what happened
and how it can be fixed.

Give your AI the keys to the internet. The browser-use experience your AI
deserves.

## See Weles work

These are public, redacted cuts from real production runs. Dark boxes cover
credentials and account identifiers; the browser interaction is otherwise
unchanged.

### Sign in to GitHub

Weles opens GitHub, enters the account credentials, submits the form, and
reaches the authenticated dashboard.

<p align="center">
  <img src="assets/demos/github-login.gif" width="800" alt="Weles signing in to GitHub and reaching the authenticated dashboard">
</p>

### Sign in to Reddit

Weles opens Reddit and completes the credential-entry flow. The retained video
ends at the enabled **Log In** button; the production action then completed
healthy, and a later health action confirmed that the stored session remained
usable.

<p align="center">
  <img src="assets/demos/reddit-login.gif" width="800" alt="Weles filling the Reddit login form with the credential fields redacted">
</p>

### Sign in to LinkedIn

Weles enters the LinkedIn credentials and reaches the authenticated home feed.
The public cut also hides the demo account's profile card.

<p align="center">
  <img src="assets/demos/linkedin-login.gif" width="800" alt="Weles signing in to LinkedIn and reaching the authenticated home feed">
</p>

### Deliver a Slack notification

This action uses Slack's API rather than a browser, so it produced no screen
recording. The production run called `chat.postMessage`, received `ok: true`,
and completed in 1.6 seconds; its message body is not public.

<p align="center">
  <img src="assets/demos/slack-delivery.svg" width="800" alt="Weles delivering a Slack message through chat.postMessage and receiving an ok response">
</p>

## Request access

Weles is an operated service. Access starts with a conversation through
[weles.wisent.com/docs](https://weles.wisent.com/docs#get-access) or by
[booking a call](https://calendly.com/lbartoszcze). An approved deployment
provides its endpoint, organization identifier, and organization-scoped token:

```sh
export WELES_API_BASE=<deployment-endpoint>
export WISENT_ORGANIZATION_ID=<organization-uuid>
export WELES_TOKEN=<organization-scoped-token>
```

From there your agents submit authorized workflows through the public
[`@wisent-ai/weles-client`](https://github.com/wisent-ai/weles-client):

```js
import { WelesClient } from '@wisent-ai/weles-client';

const client = new WelesClient({
  endpoint: process.env.WELES_API_BASE,
  bearer: process.env.WELES_TOKEN,
  organizationId: process.env.WISENT_ORGANIZATION_ID,
  allowedOrigins: ['https://console.example.com'],
  allowedActions: ['export-approved-report'],
});

const accepted = await client.submit({
  origin: 'https://console.example.com',
  action: 'export-approved-report',
  input: { report: 'monthly' },
  credentialRefs: ['customer-console-account'],
  evidencePolicy: 'receipt',
  justification: 'Export authorized by the account owner.',
}, { idempotencyKey: 'caller-retained-operation-id' });
```

An accepted production action resolves to its reviewed trajectory and closes
with an explicit terminal state. When receipt issuance is configured, the
client verifies the signed outcome and evidence digest offline without reading
worker logs.

Both the Weles executor and
[`weles-client`](https://github.com/wisent-ai/weles-client) are public,
MIT-licensed source. You can inspect, build, and operate your own deployment.
A source checkout does not include a hosted endpoint, approved trajectories,
managed credentials, evidence retention, or an SLA; those are provisioned
separately for each organization.

## Enterprise

Weles Enterprise is the operated path for teams that need browser work to be a
reviewed production capability rather than an unowned automation script. An
engagement defines the exact origins and actions, turns approved journeys into
versioned trajectories, provisions the client and worker boundary, and binds
credentials and retained evidence to the organization.

The scope can include trajectory design and review, deployment-ring policy,
credential lifecycle integration, evidence-retention policy, and operational
support for the agreed workflows. It does not grant blanket authorization to
automate a website. The source remains available without an enterprise
engagement; Enterprise provides the managed deployment and operating service.

[Book an enterprise implementation call](https://calendly.com/lbartoszcze).

## What your agents can do

- **Browse like a human.** Custom C++-patched Chromium and Firefox forks with
  rotating fingerprints keep your agents out of CAPTCHA loops and away from
  bans.
- **Cache every website as a trajectory.** The first run maps the journey;
  later approved runs replay the cached route instead of paying the discovery
  cost again.
- **Recover from failure fast.** Every failed run is recorded with the exact
  point of failure marked, so you see what happened and how to fix it.
- **Prove what happened.** Every run closes with a terminal action-log state;
  deployments with receipt issuance add a signed outcome and evidence digest
  that `weles-client` verifies offline.
- **Operate credentials safely.** API keys and passwords move through the
  Skarbiec lifecycle — acquire, adopt, rotate, reset, verify — without
  plaintext ever touching a prompt or a log.
- **Stay in bounds.** Exact origin and action allowlists, idempotency keys,
  and a required human-readable justification on every submission.

## How it works

```mermaid
flowchart LR
    caller["Your service"] -->|"origin · action · justification · idempotency"| admission["Weles admission"]
    admission --> queue[("Action log")]
    queue -->|"lease and claim"| worker["Weles worker<br/>approved host"]
    worker --> trajectory["Reviewed trajectory<br/>verified browser release"]
    skarbiec["Skarbiec"] -. "scoped credential references" .-> trajectory
    trajectory --> evidence["Terminal state<br/>recorded evidence"]
    evidence -->|"status · optional signed receipt"| caller
```

Your service submits an exact origin and action; a worker on an approved host
claims the task; and the production action resolves to a checked-in trajectory
executed in a verified browser build. Credentials resolve through scoped
Skarbiec grants — never through plaintext in the request. Draft discovery can
map a new journey, but it does not authorize that journey as a production
action. Authorization for the target remains with you: a technically successful
run does not establish that the target permits automation.

## Compatibility and status

- **Client contract:** the public
  [`weles-client`](https://github.com/wisent-ai/weles-client) source currently
  defines the `0.1.0` minimum contract. It has no immutable package release or
  hosted-endpoint promise until an operator provisions them.
- **API:** versioned task, cancellation, status, and receipt schemas expose
  stable `current` aliases.
- **Executor:** the open-source worker ships as immutable `worker-v*` artifacts
  promoted through candidate, development, canary, and production rings.
- **Browsers:** Chromium and Firefox launch only when the local receipt matches
  the exact Stado release coordinate and checksum selected for the worker.

## Community and support

- **Discussion and integration help:** the [Wisent Discord](https://discord.gg/qRjpkthq54).
- **Operational defects:** this repository's issue tracker with the action-log
  row ID, worker instance ID, and release coordinate. Never attach recordings
  or credentials.

## Security

Report vulnerabilities through a
[private GitHub Security Advisory](https://github.com/wisent-ai/weles/security/advisories/new).
Never place credentials, trajectories, recordings, or target details in a
public issue.

## License

[MIT](LICENSE). Source availability does not grant access to the operated
service or authorize automation of any target.
