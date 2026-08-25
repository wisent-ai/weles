# Examples

How do you see Weles dispatch, queueing, and fail-closed verification work
without a fleet, credentials, or a Stado binary? Each script in this directory
runs offline with plain `node <script>` from any working directory, against
the already-built `dist/` in this repository, and imports the same compiled
modules the real execution paths use — so the output below is real dispatch
behavior, not a mock. Sample parameters are synthetic. Background for what
these paths are: [workflows](../workflows.md), [trajectories](../trajectories.md),
[worker-lifecycle](../worker-lifecycle.md).

## resolve-action.mjs

`node docs/examples/resolve-action.mjs [action]` resolves an action name to
its trajectory script and prints the env vars the trajectory subprocess would
receive, using the shared resolver both the Stado runner and the HTTP API load
(`src/worker/dispatch.ts`, compiled to `dist/worker/dispatch.js`). It
demonstrates the two halves of dispatch: `resolveTrajectory` maps
`<platform>_<verb>` to a `.mjs` path (or `null` when no branch exists — the
row is not dispatchable), and the pure function `paramsToEnv` turns the params
object into the subprocess environment.

```
$ node docs/examples/resolve-action.mjs
action: generic_browser_task
trajectory: scripts/trajectories/generic/browser_task.mjs
env from paramsToEnv(sampleParams, action, trajectory):
{
  "GENERIC_TASK_URL": "https://example.com/",
  "GENERIC_TASK_OBJECTIVE": "Read the page heading and report it back.",
  "GENERIC_TASK_FLOW_NAME": "docs_example",
  "GENERIC_TASK_HEADLESS": "1"
}

control: resolveTrajectory('nosuchplatform_nosuchverb') -> null

$ node docs/examples/resolve-action.mjs twitter_teleport
action: twitter_teleport
trajectory: null (not dispatchable; the Stado runner would refuse it)
```

## build-stado-job.mjs

`node docs/examples/build-stado-job.mjs [action]` builds the exact base64url
payload a queued Weles action becomes and prints the full `stado submit`
command — without executing it. It mirrors the enqueue side
(`scripts/_shared/stado-action-queue.mjs`) and then re-validates the payload
with the same regexes the runner applies before spawning anything
(`scripts/worker/stado-action-runner.mjs`): action must match
`^[a-z][a-z0-9_]{0,127}$`, an account item must match
`^weles-[a-z0-9][a-z0-9-]{0,126}$`, and params must be a plain object. The
last step feeds an invalid action to show the runner's exact refusal string.

```
$ node docs/examples/build-stado-job.mjs
payload (base64url): eyJhY3Rpb24iOiJnZW5lcmljX2Jyb3dzZXJfdGFzayIsImFjY291bnRJdGVtIjoid2VsZXMtZG9j...

the queue helper would submit exactly:
  stado submit "node scripts/worker/stado-action-runner.mjs eyJhY3Rpb24iOiJnZW5l..." --priority 0

runner-side re-validation of the same payload:
  {"action":"generic_browser_task","accountItem":"weles-docs-example-account","params":{"url":"https://example.com/","objective":"Report the page heading."}}

runner-side validation of a payload with action "9Bad-Action":
  refused: invalid Weles action
```

## check-browser-release.mjs

`node docs/examples/check-browser-release.mjs` shows fail-closed browser
selection (`src/session/find_browser.ts`). `findCustomBrowser` returns a
binary path only when the exact release env vars are set and the installed
binary carries a verification receipt matching the immutable Stado coordinate
and checksum; every other state returns `undefined`, and
`customBrowserSearchHint` explains which precondition is missing. The script
runs the unconfigured case, then configures a synthetic release that was never
installed, then asks about an unknown browser family. More on releases:
[releases](../releases.md).

```
$ node docs/examples/check-browser-release.mjs
1) unconfigured environment (no release env vars):
   findCustomBrowser('chromium') -> undefined
   hint: set WELES_CHROMIUM_RELEASE_VERSION and WELES_CHROMIUM_RELEASE_SHA256, then install the exact Stado release with scripts/chromium/download.sh

2) release configured but never installed/verified (synthetic coordinate):
   findCustomBrowser('chromium') -> undefined
   hint: verified executable not found for the configured release; expected ~/.local/share/weles-chromium/0.0.0-docs-example/Chromium.app/Contents/MacOS/Chromium with matching ~/.local/share/weles-chromium/0.0.0-docs-example/.weles-release

3) unknown browser family:
   hint: unknown browser family "netscape"
```

## api-server-smoke.mjs

`node docs/examples/api-server-smoke.mjs` starts the synchronous HTTP API
(`scripts/worker/weles-api-server.mjs`) on a random localhost port with a
throwaway `WELES_API_TOKEN`, hits the unauthenticated liveness route, shows
that an authenticated route refuses a caller without the bearer token
(`{"ok":false,"error":"unauthorized"}`, HTTP 401), and shuts the server down.
No trajectory runs and nothing leaves localhost. The `/healthz` body lists
the routes and the `login_item` feature flag; the script summarizes
`login_items` as a count instead of printing the account rows.

```
$ node docs/examples/api-server-smoke.mjs
[weles-api] listening http://127.0.0.1:55383 auth=true rawCreds=true

GET /healthz -> 200
{
  "ok": true,
  "source": "weles_api",
  "authConfigured": true,
  "rawCredsAllowed": true,
  "routes": [
    "GET /healthz",
    "GET /worker/version",
    ...
    "POST /reauth"
  ],
  "features": [
    "login_item"
  ],
  "login_items": "[10 entries]"
}

GET /worker/version without token -> 401 {"ok":false,"error":"unauthorized"}
```
