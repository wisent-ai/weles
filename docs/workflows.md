# Workflows

What happens between an admitted action and its terminal state? A workflow in
Weles is one named action: its parameters and the single trajectory that
action resolves to. This page follows an action from submission to terminal
state; who may submit it at all is [authorization](authorization.md), and the
transports that carry it — the Stado job queue and the synchronous HTTP API —
are the [execution model](worker-lifecycle.md).

## Actions resolve to trajectories

Actions are named `<platform>_<verb>`. The dispatch table
(`src/worker/dispatch.ts`) maps the verb to one checked-in trajectory script
under `scripts/trajectories/` — a `<platform>_<verb>.mjs` at the root or a
per-platform subdirectory module. An action with no dispatch branch is not
executable: `resolveTrajectory` returns null, the queued runner refuses with
`no Weles trajectory for <action>`, and the HTTP API answers 404
`no_trajectory` — never half-run. Analytics-service actions collapse onto one
shared service runner, and every `login_via_<provider>` verb collapses onto a
single parametric cross-login runner with the provider passed as a parameter.

## Parameters cross as environment

Parameters cross into the trajectory as environment variables through
`paramsToEnv`, a pure function with no I/O — the subprocess receives exactly
what the submission declared, nothing ambient. On top of that mapping, the
queued runner sets `WSESSION_LABEL` to the action and `ACTION_LOG_ID` from
`WC_JOB_ID` or `STADO_JOB_ID`, and merges the payload's `accountItem` into
params as `login_item` (`scripts/worker/stado-action-runner.mjs`); the HTTP
API sets `ACTION_LOG_ID` to a fresh run UUID and `ACTION` to the action
(`scripts/worker/weles-api-server.mjs`). `ACTION_LOG_ID` is the run id: it
keys the evidence tree the run writes.

## Draft discovery is not production

A production action replays a reviewed, checked-in trajectory. Drafting is a
separate, weaker artifact: `writeWelesTrajectoryDraft`
(`src/trajectories/writer.ts`) asks the model router for imperative steps for
the generic browser agent, and falls back to fixed conservative steps when the
router is unavailable. The draft contract forbids returning raw API keys,
tokens, or passwords in any terminal value, history, or log. Drafts guide the
generic agent; they do not authorize a new production action (README).

## Execution

Both paths spawn the trajectory as a `node <trajectory>` subprocess from the
repo root with the environment above. Trajectories own their session and
capture; the transport is pure orchestration. Everything the run produces
lands under `recordings/<run-id>/` (root override: `WELES_RECORDINGS_ROOT`,
`src/session/run-recordings.ts`): recordings, `session_meta.json` provenance,
`captcha_events.json`, `ban_signal.json`, optional `pending_review.json`, and
per-action result files such as `generic_task_result.json`,
`service_action_result.json`, and `capture_result.json`
(`src/session/wsession.ts`, `scripts/trajectories/`).

Terminal behavior is the subprocess's own:

- **Queued.** The runner forwards `SIGINT`/`SIGTERM` to the trajectory; a
  child killed by a signal makes the runner re-raise that signal on itself,
  and otherwise the runner exits with the child's exit code (`?? 1`), so the
  Stado job records exactly how the trajectory ended
  (`scripts/worker/stado-action-runner.mjs`). A `delay_ms` param sleeps
  before the spawn, capped at 24 hours. The session itself closes the browser
  context on `SIGTERM` so Playwright seals the HAR and video before the
  process dies (`src/session/wsession.ts`).
- **Synchronous.** The HTTP API kills a run at its deadline — `SIGTERM`, then
  `SIGKILL` 8 seconds later — and reports it as `exitCode: 137,
  timed_out: true`; a non-zero exit answers HTTP 502
  (`scripts/worker/weles-api-server.mjs`).

Trajectories that need a human file `pending_review.json` with a
`needs_human_approval` reason instead of guessing; the credential-operations
surface lifts `service_action_result.json` into `result.service_action` and
`pending_review.json` into `result.pending_review`
(`scripts/worker/deploy/weles-skarbiec-local.mjs`,
[credential operations](credential-operations.md)).

## Result assembly

The synchronous API assembles the response after the subprocess exits
(`scripts/worker/weles-api-server.mjs`): the result document is the last JSON
line of stdout (`lastJsonLine`), falling back to a walk of the run's
`recordings/<run-id>/` tree for `generic_task_result.json` or `result.json`
(`findResultDoc`). The response carries `ok` (exit 0), `exitCode`, `action`,
`run_id`, `result`, the last 4000 bytes of stdout and 2000 of stderr, and
`timed_out`. What leaves the process is decided by the request's `creds`
mode:

| Mode | Behavior |
|---|---|
| `redact` (default) | the serialized response passes through `redactSecrets`, which rewrites JWTs, PEM private-key blocks, Slack tokens, AWS access-key ids, and `<prefix>_secret/key/token/…_<value>` shapes to `[redacted-*]` |
| `raw` | the response is returned unredacted; gated by `WELES_API_ALLOW_RAW_CREDS` |
| `store` | `extractCreds` pulls a credential tuple out of the result — tolerant of `result.value`, `.credentials`, and `.account` nesting and of common field names (email, username, password, phone) — `storeCredential` persists it through `upsertCredential` (`scripts/lib/service_credentials.mjs`), and only `{credential_id, provider, login_email, has_password}` is returned; a run with no extractable credentials answers 422 `no_credentials_in_result` |

The queued path assembles no result document: the Stado job's exit status is
the verdict, and the evidence stays in the run tree. Flows that publish
evidence mirror the complete tree to private Stado objects with
`uploadArtifacts` — the keeper flows refuse to finish without it (`private
Stado artifact uploader is required`, `scripts/_shared/keeper/bookkeeping.mjs`)
— and locators exist only after Stado acknowledges the exact canonical URI of
every object (`src/worker/upload-artifacts.ts`).

What a deployment with receipt issuance signs over a terminal run — and what
a verifier checks offline — is in [receipts](receipts.md); how trajectories
themselves are written and reviewed is in [trajectories](trajectories.md).
