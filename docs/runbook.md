# Runbook

Something failed — what was the exact sentence, and which file said it? Each
entry below starts from the task you were doing, quotes the message verbatim,
names where it is raised, and says what to do. Environment keys live in
[configuration](configuration.md); command flags in [cli](cli.md).

## You enqueued an action and no job appeared

`enqueueAction` (`src/state/skarbiec-records.ts`) validates locally, then runs
`stado submit` with the payload:

| Message | Meaning | Do |
|---|---|---|
| `invalid Weles action: <action>` | The action name fails `^[a-z][a-z0-9_]{0,127}$` | Use the registered lowercase action name |
| `invalid Weles account item` | The account item fails `^weles-[a-z0-9][a-z0-9-]{0,126}-account$` | Pass an item id derived by `accountItemId` (platform + username slug + `-account`) |
| `Stado refused <action>: <stderr>` | `stado submit` exited nonzero or did not start; the Stado CLI's own stderr is appended | Read the appended stderr; confirm the CLI at `WELES_STADO_BIN` (default `~/.stado/bin/stado`) exists and is logged in |
| `Stado returned no job id for <action>` | `stado submit` succeeded but printed no 8-hex job id | Inspect `stado submit` output by hand |

One placement gotcha: the submitted command always names the runner at
`~/weles/scripts/worker/stado-action-runner.mjs`
(`join(homedir(), 'weles', ...)` in `src/state/skarbiec-records.ts`), whatever
checkout enqueued it. A job that dies with a module-not-found error means the
executing host has no built checkout at `~/weles`.

## The Stado job failed immediately

`scripts/worker/stado-action-runner.mjs` refuses before any browser starts:

| Message | Raised when |
|---|---|
| `one base64url action payload is required` | `argv[2]` is missing or not base64url (`^[A-Za-z0-9_-]+$`) |
| `invalid Weles action` | The decoded `action` fails `^[a-z][a-z0-9_]{0,127}$` |
| `invalid Weles account item` | `accountItem` is present but fails `^weles-[a-z0-9][a-z0-9-]{0,126}$` |
| `invalid Weles action params` | `params` is missing, an array, or not an object |
| `no Weles trajectory for <action>` | `resolveTrajectory` (`dist/worker/dispatch.js`) maps the action to nothing |

Payloads normally come from `enqueueAction`, so any of the first four means a
hand-built payload; the last means the action name is unknown to the build the
runner imported — check the action name against `src/worker/dispatch.ts` and
that `dist/` is current. The runner imports from `dist/worker/dispatch.js`, so
an unbuilt checkout fails the import itself with Node's module-not-found
error, not with one of these sentences.

## The HTTP API answered an error

`scripts/worker/weles-api-server.mjs` — the localhost synchronous runner.
Every error body is JSON of the shape `{"ok":false,"error":...}`.

Authentication first. The token comes from `WELES_API_TOKEN` (or
`WELES_CONSOLE_API_TOKEN`) and is presented as `Authorization: Bearer <token>`
or `x-api-key`:

| Status and body | Meaning |
|---|---|
| `401 {"ok":false,"error":"unauthorized"}` | A token is configured and the request did not present it |
| `500 {"ok":false,"error":"missing_WELES_API_TOKEN"}` | No token is configured and `WELES_API_ALLOW_UNAUTH=1` is not set — the server refuses to run open by accident |

Request-shape refusals (`400` unless noted):

| `error` | Meaning |
|---|---|
| `body_too_large` | Body exceeded `WELES_API_BODY_LIMIT_BYTES` (default `262144`); the socket is destroyed mid-read |
| `invalid_json` | Body present but not JSON |
| `missing_action` | `POST /run` without a non-empty `action` |
| `creds must be redact\|raw\|store` | `POST /run` with an unknown `creds` mode |
| `raw_creds_forbidden` | `403`; `creds:"raw"` while `WELES_API_ALLOW_RAW_CREDS=0` |
| `provider must be codex\|claude\|kimi` | `POST /reauth` with an unknown provider |
| `missing_instructions` | `POST /weles-builder` with an empty body |
| `invalid_run_id` | `GET /diagnostics/...` with a run id outside `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` |

Not-found answers (`404`): `not_found` (unknown route), `no_trajectory`
(`POST /run` action resolves to no trajectory), `diagnostics_not_found`,
`diagnostic_file_not_found`, `no_reauth_trajectory`.

Run outcomes are not request errors. A failed run answers `502` with the run
envelope (`ok:false`, `exitCode`, `run_id`, `stdout_tail`, `stderr_tail`). A
timeout has no error string of its own: after `WELES_API_TIMEOUT_MS` (default
`900000`) the child gets SIGTERM, SIGKILL eight seconds later, and the `502`
envelope carries `"timed_out": true` with `exitCode` 137. For runs longer than
any client is willing to hold a socket, send `"detached": true` — the server
answers `202` with `detached_run` and `result_path` and writes the result
under `~/.stado/weles-detached-runs/`. `creds:"store"` adds `422`
`no_credentials_in_result` and `502` `run_failed` / `store_failed: <message>`.
Worker control answers `409` `worker_control_in_progress` while another
control call runs, and `501` when `controlWorker` reports
`worker_control_requires_macos`. Any unexpected exception is `500` with the
message truncated to 300 characters.

## The browser would not launch

There is no stock-browser fallback; launch requires the exact configured
release ([configuration](configuration.md)).

- `WELES_CHROMIUM_BINARY_NOT_FOUND: install the configured immutable Stado
  release` (`src/async_api.ts`) — `findCustomBrowser('chromium')` resolved
  nothing. The same sentence exists for Firefox as
  `WELES_FIREFOX_BINARY_NOT_FOUND: ...` (`src/async_api.ts`).
- The Firefox launch path throws `WELES_FIREFOX_BINARY_NOT_FOUND: <hint>`
  (`src/browser/firefox_launch.ts`), where the hint from
  `customBrowserSearchHint` (`src/session/find_browser.ts`) names the exact
  gap:
  - `set <envVersion> and <envSha256>, then install the exact Stado release
    with scripts/<browser>/download.sh` — the release coordinate is not
    configured: `WELES_CHROMIUM_RELEASE_VERSION` /
    `WELES_CHROMIUM_RELEASE_SHA256` (Firefox: `WELES_FIREFOX_*`) are unset, or
    the digest is not 64 hex characters, or the platform is not
    `darwin-arm64`, `darwin-amd64`, or `linux-amd64`;
  - `verified executable not found for the configured release; expected
    <binary> with matching <receipt>` — the coordinate is configured but the
    installed binary is missing, or its `.weles-release` receipt does not
    byte-match `release_uri=...`, `archive_sha256=...`, `platform=...`.

Do: set both release variables to the deployment's coordinate and run
`scripts/chromium/download.sh` (or `scripts/firefox/download.sh`), which
writes the receipt only after the archive checksum verifies.
`WELES_CHROMIUM_DIR` / `WELES_FIREFOX_DIR` move the install root; they never
bypass the version, checksum, or receipt check.

## Reading or writing Weles state failed

Accounts, settings, and run records are Skarbiec vault items
(`src/state/skarbiec-records.ts`). The wrapper shells out with `execFileSync`
to the skarbiec CLI (`SKARBIEC_BIN`, default `~/.stado/bin/skarbiec`) and adds
no wrapping of its own, so failures surface as Node's child-process errors:

| Failure | What you see |
|---|---|
| CLI binary missing | `spawnSync <path> ENOENT` |
| CLI exited nonzero | `Command failed: <path> <args>` with the CLI's stderr appended |
| Vault unreadable during `readSetting` / `readRunRecord` | Nothing — both swallow every failure and return the fallback / `null`, so a broken vault reads as defaults |

Local validation strings from the same file: `cannot derive a safe Weles
account item id` (the platform/username slug does not produce a valid item
id), `invalid Weles setting: <key>`, `invalid Weles run id`.

## Onboarding refused

The first-use journey (`src/onboarding.ts`, surfaced by `weles onboarding` in
`src/cli.ts`) enforces step order and real verification:

| Message | Meaning |
|---|---|
| `the receipt-verification step requires a signed service receipt; use onboarding verify` | `weles onboarding next` was run on the final step, which only `verify` completes |
| `complete the authorization-boundary and host-execution steps before verifying a receipt` | `verify` was run before the earlier steps |
| `onboarding verify requires --receipt <file> and --keys <file>` | Missing CLI flags (`src/cli.ts`) |
| `receipt key map must be a JSON object` / `receipt key map must not be empty` / `receipt key map must contain non-empty key IDs and PEM public keys` | The `--keys` file is malformed (`src/cli.ts`) |
| `receipt verification requires a receipt and trusted public-key map` | The receipt or key map reached the runtime empty |
| `verified receipt claim <field> is missing` | The verifier returned claims lacking a non-empty `taskId`, `organizationId`, `origin`, `action`, `outcome`, `evidenceDigest`, or `keyId` |
| `verified receipt outcome is not a completed Weles workflow: <outcome>` | The receipt is genuine but not for a `completed` run |

Verification itself fails with weles-client's `WelesClientError` codes
(`unsupported-receipt`, `unknown-receipt-key`, `invalid-receipt-signature`,
`invalid-receipt-payload`, `receipt-claim-mismatch`) — the checks and messages
are in [receipts](receipts.md), and a full local run is in
[walkthrough-receipt-verification](walkthrough-receipt-verification.md).

## A credential operation refused

Credential lifecycle requests (`src/secrets/acquire.ts`) queue through the
same `enqueueAction` path, so every Stado refusal in the first section applies
to them too. The operation-level refusals and their meanings are in
[credential-operations](credential-operations.md).
