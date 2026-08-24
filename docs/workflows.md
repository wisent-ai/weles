# Workflows

What happens between an admitted row and a terminal state? A workflow in Weles
is one action-log row: a named action, its parameters, and the single
trajectory that action resolves to. This page follows a row from claim to
terminal state; who may claim it at all is [authorization](authorization.md),
and the loop doing the claiming is [worker lifecycle](worker-lifecycle.md).

## Actions resolve to trajectories

Actions are named `<platform>_<verb>`. The dispatch table
(`src/worker/dispatch.ts`) maps the verb to one checked-in trajectory script
under `scripts/trajectories/` — a `<platform>_<verb>.mjs` at the root or a
per-platform subdirectory module. An action with no dispatch branch is not
executable: `resolveTrajectory` returns null and the row is skipped at the
claim step, never half-run. Analytics-service actions collapse onto one shared
service runner, and every `login_via_<provider>` verb collapses onto a single
parametric cross-login runner with the provider passed as a parameter.

Row parameters cross into the trajectory as environment variables through
`paramsToEnv`, a pure function with no I/O — the subprocess receives exactly
what the row declared, nothing ambient.

## Draft discovery is not production

A production action replays a reviewed, checked-in trajectory. Drafting is a
separate, weaker artifact: `writeWelesTrajectoryDraft`
(`src/trajectories/writer.ts`) asks the model router for imperative steps for
the generic browser agent, and falls back to fixed conservative steps when the
router is unavailable. The draft contract forbids returning raw API keys,
tokens, or passwords in any terminal value, history, or log. Drafts guide the
generic agent; they do not authorize a new production action (README).

Trajectory builds have their own promotion path: a run that carries a
`trajectory_build_id` updates its build row with the run's final status, and
`promoteTrajectoryBuild` promotes only a `completed` run that explicitly set
`auto_promote_trajectory: true` (`src/worker/poll.ts`).

## Execution

The worker spawns the trajectory as a subprocess with the row's environment
(`runTrajectory` in `src/worker/poll.ts`). Trajectories own their session and
capture; the worker is pure orchestration. Everything the run produces lands
under `recordings/<run-id>/` (root override: `RECORDINGS_ROOT`): recordings,
`session_meta.json` provenance, `captcha_events.json`, `ban_signal.json`,
optional `pending_review.json`, and per-action result files such as
`generic_task_result.json`, `service_action_result.json`, and
`capture_result.json`.

Cancellation is cooperative: the run loop checks for a cancel request and a
cancelled subprocess yields the `cancelled` terminal state. A failed run
without instrumentation is re-run once with instrumentation enabled purely for
diagnostics — the retry's outcome never replaces the recorded failure (opt out
with `AUTO_INSTRUMENT_RETRIES=0`).

## Result assembly

After the subprocess exits, the worker assembles the result from the run tree
before writing anything back:

- `versions` — the exact source and browser build identity that ran,
  including binary SHA-256 and a mirrored `source_diff.patch` when the tree
  was dirty;
- `session` / `identity` / `run` / `challenge_outcome` — per-run provenance:
  persona, realized fingerprint, browser provenance, proxy preflight;
- `captcha` — the complete challenge event log; a no-captcha run records
  `{challenge_faced: false, events: []}`, distinct from a missing file;
- `ban_signal` — the trajectory's own health verdict, or a synthesized
  `healthy`/`unknown_error` from the exit code; an unhealthy signal pauses the
  account;
- `artifacts` — locators from `uploadArtifacts`, which always uploads the
  complete run tree to private storage before any result locator is
  published;
- costs — per-run USD cost and per-service breakdown when recorded.

Credential-producing runs persist the secret through the worker's Skarbiec
path first, then every occurrence of the secret value is redacted from the
result before it is written; a missing storage receipt fails the run rather
than publishing plaintext (`src/worker/credential-completion.ts`,
`src/worker/poll.ts`).

## Terminal states

Every row ends in exactly one state, and each write also updates the
trajectory build, closes any owning campaign item, and fires the row's webhook
when one is configured:

| State | Meaning |
|---|---|
| `completed` | Exit 0, no pending review, verification (when required) passed |
| `pending_review` | Exit 0, but the trajectory filed `pending_review.json` or required verification did not confidently pass |
| `failed` | Non-zero exit, a refused precondition, or a failed credential return |
| `cancelled` | A cancel request stopped the subprocess |

Verification runs when the row asks for it (`verification_required`,
`auto_promote_trajectory`, or `build_test` parameters; global opt-out
`WELES_VERIFY_RUNS=0`): a model judges the run artifacts and returns `pass`,
`fail`, or `uncertain` with a confidence; only `pass` at confidence ≥ 0.6
counts, and a verifier error is recorded as `uncertain`, never as a pass
(`src/worker/verification.ts`).

The webhook, when a row carries a `webhook_url` (HTTPS, or HTTP on
loopback), receives one `run.finished` POST with the run ID, action,
status, error, and result; with `WELES_WEBHOOK_SECRET` set the body is
HMAC-signed in `x-weles-signature`.

What a deployment with receipt issuance signs over this terminal state — and
what a verifier checks offline — is in [receipts](receipts.md).
