# Trajectories

What actually runs when Weles executes an action? A trajectory: the single
checked-in executable a production action resolves to. Every admitted action
named `<platform>_<verb>` maps through one dispatch table to exactly one
`.mjs` script under `scripts/trajectories/`, and an action with no dispatch
branch is not executable at all. This page is the trajectory noun — its shape,
layout, resolution, and lifecycle. What happens around a run (parameters in,
terminal states out) is [workflows](workflows.md).

## Shape: an env-driven subprocess

A trajectory is a Node `.mjs` script spawned as a subprocess. It receives its
entire instruction through environment variables — the row's parameters are
translated by `paramsToEnv`, a pure function with no I/O and no shared state
(`src/worker/dispatch.ts`) — and it owns its browser session and evidence
capture. Both execution paths spawn the identical child: the Stado-queued
runner (`scripts/worker/stado-action-runner.mjs`) and the synchronous
localhost API (`scripts/worker/weles-api-server.mjs`) each import the same
`resolveTrajectory` + `paramsToEnv` from `dist/worker/dispatch.js`, so a job
runs byte-identically on either path (comment in
`scripts/worker/weles-api-server.mjs`: "It reuses the worker's OWN
resolveTrajectory + paramsToEnv (from dist/) so a job runs byte-identically to
the queued path").

Every browser trajectory also runs inside the same injected fingerprint
environment: `buildInitScript` (`src/scripts/loader.ts`) prepends
`const __weles = <config>;` and concatenates the shared init scripts
(`automation.js`, `navigator.js`, `webgl.js`) plus one browser-specific set —
`chrome147_stubs.js` on Chromium only, `firefox/stubs.js` on Firefox only.

## Layout under scripts/trajectories/

488 `.mjs` files at time of writing: 33 flat `<platform>_<verb>.mjs` files at
the repository root of the directory, the rest under 54 per-platform
subdirectories (with `actions/`, `content/`, `dm/`, `recover/`, and similar
groupings inside), plus `_shared/` for the parametric runners. The dispatch
table documents its own conventions (`src/worker/dispatch.ts`):

> `<platform>_<verb>.mjs` at the root for the "default" path (twitter/linkedin
> comments, instagram likes, etc.) — the original layout.
> `<platform>/<verb>.mjs` or `<platform>/actions/<verb>.mjs` as a subdir
> exception, used when (a) the root dir hit its file-count cap, or (b) the
> trajectory grew enough adjacent files that grouping under a per-platform
> subdir was clearer (github, reddit, tiktok action atoms, content composers,
> etc.).

Do not memorize the layout; the table is the truth. Individual branches
record their own exceptions inline — for example `dm` routes twitter to the
root file, tiktok/reddit to `<platform>/dm/dm.mjs` "because the parent dirs
were at the file-count cap when the DM trajectories landed", and everything
else to `<platform>/dm.mjs`.

## Resolution: the dispatch table

`resolveTrajectory(action)` splits the action on its **first** underscore into
platform and verb, then looks the verb up in `ROUTES`, a
`Record<string, (platform: string) => string | null>`
(`src/worker/dispatch.ts`). The header comment states the invariant:

> New trajectories MUST add a branch here; otherwise resolveTrajectory will
> return null and the queued row will be silently skipped at the claim step.

The Stado runner turns that null into a hard refusal — it throws
`` `no Weles trajectory for ${payload.action}` `` — and the API server
answers `{ ok: false, error: 'no_trajectory' }`
(`scripts/worker/stado-action-runner.mjs`,
`scripts/worker/weles-api-server.mjs`).

Executed against the built tree (`dist/worker/dispatch.js`, Node v22.20.0):

```console
$ node -e "
const { resolveTrajectory } = require('./dist/worker/dispatch.js');
for (const action of ['twitter_like', 'reddit_login_via_apple', 'umami_view_summary', 'example_unknown_verb']) {
  console.log(action, '->', resolveTrajectory(action));
}
"
twitter_like -> scripts/trajectories/twitter_like.mjs
reddit_login_via_apple -> scripts/trajectories/cross_login/run.mjs
umami_view_summary -> scripts/trajectories/_shared/analytics-service.mjs
example_unknown_verb -> null
```

### Collapses: many actions, one runner

Four groups of actions deliberately collapse onto shared parametric scripts
instead of one file per pair (`src/worker/dispatch.ts`):

| Collapse | Actions | Runner | Parameters |
|---|---|---|---|
| Benign surface ticks | `dwell`, `notifications`, `search`, `profile_view` on any platform | `_shared/benign.mjs` | `PLATFORM` + `VERB` split from the action name |
| Cross-login | every `<platform>_login_via_<provider>` (e.g. `reddit_login_via_apple`, `tiktok_login_via_google`) | `cross_login/run.mjs` | `PLATFORM` + `PROVIDER` parsed from the verb suffix, so the runner can "table-lookup the target URL + OAuth-button regex without one-trajectory-file-per-pair" |
| Analytics services | the `ANALYTICS_SERVICE_ACTIONS` set — 55 actions (27 `umami_*`, 28 `googleanalytics_*`), checked before platform/verb splitting | `_shared/analytics-service.mjs` | `PLATFORM`, `VERB`, `SERVICE_ACTION`, a large named passthrough table (`DOMAIN`, `WEBSITE_ID`, `MEASUREMENT_ID`, …), and `WRITE_CONFIRM=1` only when the row set `confirm`/`write_confirm` |
| Proxy/captcha/SMS vendors | `balance` and `topup` for the 13 `PROXY_PROVIDERS` (iproyal, packetstream, brightdata, oxylabs, anticaptcha, capmonster, capsolver, twocaptcha, nopecha, sadcaptcha, pingproxies, juicysms, fivesim) | `<provider>/balance.mjs`, `<provider>/topup.mjs` | `topup` resolves to null for any non-vendor platform |

Two related consolidations live inside individual branches: `register` for
`youtube` and `google` both run the canonical Gmail signup at
`google/register.mjs` (persisting as platform `google`), and dozens of
`ads_*` verbs on platform `apple` all route to the single CLI wrapper
`apple/ads/run.mjs` with the verb surfaced as `APPLE_ADS_ACTION`.

## Parameters cross as environment

`paramsToEnv(params, action, trajPath)` branches on the resolved path and
maps named row parameters to named env vars — nothing ambient leaks in, and
malformed rows fail **at dispatch**, before a browser launches:

- capture actions parse their whole plan here ("a malformed row fails at
  dispatch with the exact refusal sentence instead of launching a browser to
  discover the problem") and re-parse the same JSON inside the trajectory;
- subscription logins (`claude`/`codex`/`kimi`) translate a vault login item
  id into `WELES_LOGIN_ITEM` + `<PROVIDER>_DISPLAY_NAME`, throwing
  `login_item must be a vault login item id string` on a non-string value;
- `apple_login` refuses without a guard: `apple_auth_guard_id must be a valid
  UUID for apple_login`, `apple_execution_host is required for apple_login`,
  `apple_execution_agent is required for apple_login`,
  `apple_login_capabilities are required for apple_login` — and then forces
  recording suppression (`WELES_DISABLE_RECORDING=1`,
  `WELES_NO_RESPONSE_BODIES=1`, netlog/instrumentation/diagnostics off)
  because "Apple credentials and capability identifiers must never enter
  videos, HAR/netlog, CDP dumps, page snapshots, or response-body recordings".

The Stado runner validates its payload before any of this: the action must
match `^[a-z][a-z0-9_]{0,127}$` (else `invalid Weles action`) and an optional
account item must match `^weles-[a-z0-9][a-z0-9-]{0,126}$` (else
`invalid Weles account item`) (`scripts/worker/stado-action-runner.mjs`).

## Drafts are not trajectories

`writeWelesTrajectoryDraft` (`src/trajectories/writer.ts`) produces a
*draft*: it asks the model router for short imperative steps for the generic
browser agent and returns `{ source: 'model-router', steps, guidance, model,
routerUrl }`. On router failure — or when
`WELES_DISABLE_TRAJECTORY_WRITER=1` — it falls back to a fixed conservative
step list with `source: 'fallback'` and the truncated error attached. The
draft contract forbids secret exfiltration in both directions: the fallback
steps instruct "Do not return raw API keys in done(value), history, notes, or
logs", and the writer prompt requires that the terminal `done(value)` "must
never include a raw API key, token, password, or secret".

A draft guides the generic agent; it is not a production action. Production
requires a reviewed, checked-in script **and** a dispatch branch — without
the branch, `resolveTrajectory` returns null and nothing runs.

## Lifecycle and invariants

1. **Draft** — `writeWelesTrajectoryDraft` maps the journey
   (`src/trajectories/writer.ts`).
2. **Review and check-in** — the script lands under `scripts/trajectories/`
   following the layout conventions above.
3. **Dispatch branch** — a `ROUTES` entry (or membership in a collapse set)
   makes the action resolvable (`src/worker/dispatch.ts`).
4. **Production** — the script ships inside the immutable worker release; the
   deployment heartbeat records `trajectories_tree_sha256` so the exact tree
   that ran is part of the release identity
   (`src/worker/deployment_version.ts`). See [releases](releases.md).

Invariants worth keeping:

- One action, one script: resolution is a pure function of the action name.
- No dispatch branch, no execution — never a half-run.
- Parameters enter only through `paramsToEnv`; validation failures happen at
  dispatch, with exact refusal strings.
- The queued path and the synchronous API spawn the identical subprocess.
- Drafts never authorize production actions, and never carry secrets.
