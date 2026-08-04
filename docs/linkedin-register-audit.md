# LinkedIn Register Audit

Current scope: identify surfaces that can explain intermittent `linkedin_register`
failures, especially anything that makes Weles/debug collection visible to
LinkedIn.

Update: native Weles Chromium C++ source review is deferred until the exact
source is available. The binary/runtime provenance findings remain recorded, but
current audit work should focus on the non-C++ evidence path: baseline,
production replay, proxy/host coherence, diagnostics capture/upload, action
sequence, and captcha/challenge behavior.

## Current Evidence

- Active LinkedIn path is `scripts/trajectories/linkedin_register.mjs` through
  `WSession.start()` and the Playwright custom Chromium path.
- Local Weles Chromium bundle:
  `/Users/jakubtowarek/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium`.
- Native patch material exists in the Echo repo:
  `/Users/jakubtowarek/Projects/echo/scripts/chromium-arm64`.
- A local side-by-side audit run was saved at:
  `recordings/audits/chrome_vs_weles_2026-06-01T22-04-19-887Z.json`.
- Native patch/binary audit report:
  `recordings/audits/weles_chromium_patch_audit_2026-06-01T22-38-59-896Z.json`.
- Latest native patch/binary audit report:
  `recordings/audits/weles_chromium_patch_audit_2026-06-02T07-27-48-735Z.json`.
- Runtime Chromium provenance report:
  `recordings/audits/chromium_runtime_provenance_2026-06-01T22-42-52-035Z.json`.
- Latest runtime Chromium provenance report:
  `recordings/audits/chromium_runtime_provenance_2026-06-02T07-27-49-854Z.json`.
- Native Chromium source provenance report:
  `recordings/audits/chromium_source_provenance_audit_2026-06-02T07-27-38-458Z.json`.
- Latest offline source provenance report with GitHub checks skipped:
  `recordings/audits/chromium_source_provenance_audit_2026-06-02T07-33-24-761Z.json`.
- Native Chromium patch semantics audit report:
  `recordings/audits/chromium_patch_semantics_audit_2026-06-02T06-25-47-962Z.json`.
- Latest native Chromium patch semantics audit report:
  `recordings/audits/chromium_patch_semantics_audit_2026-06-02T08-02-48-752Z.json`.
- LinkedIn action/captcha static audit report:
  `recordings/audits/linkedin_action_surface_audit_2026-06-01T22-46-15-958Z.json`.
- Latest LinkedIn action/captcha static audit report:
  `recordings/audits/linkedin_action_surface_audit_2026-06-02T09-06-58-983Z.json`.
- Latest LinkedIn action/captcha static audit report from preflight:
  `recordings/audits/linkedin_action_surface_audit_2026-06-02T09-07-17-918Z.json`.
- Local Weles action event-sequence probe:
  `recordings/audits/action_event_probe_2026-06-02T06-20-04-250Z.json`.
- Latest local Weles action event-sequence probe:
  `recordings/audits/action_event_probe_2026-06-02T08-37-43-525Z.json`.
- LinkedIn-observable surface audit report:
  `recordings/audits/linkedin_observable_surface_audit_2026-06-02T06-26-45-694Z.json`.
- Proxy quality preflight sanity report:
  `recordings/audits/proxy_quality_audit_2026-06-01T23-06-16-231Z.json`.
- Browser-side proxy/WebRTC leak audit:
  `recordings/audits/browser_proxy_leak_audit_2026-06-02T08-34-37-750Z.json`.
- Launch/runtime side-effect audit:
  `recordings/audits/launch_runtime_audit_2026-06-02T06-46-13-179Z.json`.
- Latest launch/runtime side-effect audit:
  `recordings/audits/launch_runtime_audit_2026-06-02T07-58-29-978Z.json`.
- Redacted production recent-runs snapshot:
  `recordings/audits/linkedin_recent_runs_mcp_snapshot_2026-06-02T06-30-17-314Z.json`.
- Diagnostics capture pipeline audit:
  `recordings/audits/diagnostics_pipeline_audit_2026-06-02T06-34-31-431Z.json`.
- Latest diagnostics capture pipeline audit:
  `recordings/audits/diagnostics_pipeline_audit_2026-06-02T09-07-17-859Z.json`.
- LinkedIn preflight summary audit:
  `recordings/audits/linkedin_preflight_audit_2026-06-02T09-07-18-062Z.json`.
- Dedicated/static proxy readiness audit:
  `recordings/audits/linkedin_dedicated_proxy_readiness_audit_2026-06-02T09-07-18-058Z.json`.
- Full audit requirement/evidence matrix:
  `recordings/audits/linkedin_audit_requirements_matrix_2026-06-02T07-38-17-277Z.json`.
- Latest full audit requirement/evidence matrix:
  `recordings/audits/linkedin_audit_requirements_matrix_normal_2026-06-02T08-03-14-310Z.json`.
- Latest deferred-native matrix:
  `recordings/audits/linkedin_audit_requirements_matrix_deferred_native_2026-06-02T09-07-23-284Z.json`.
- Chrome baseline readiness audit:
  `recordings/audits/chrome_baseline_readiness_audit_2026-06-02T08-45-52-621Z.json`.
- Recordings storage access/retention audit:
  `recordings/audits/recordings_storage_audit_2026-06-02T08-50-00-000Z.json`.
- Production evidence-pack dry run:
  `recordings/audits/linkedin_production_evidence_pack_2026-06-02T08-11-09-710Z.json`.
- Local LinkedIn recording validator:
  `recordings/audits/linkedin_local_recording_audit_2026-06-02T07-44-12-305Z.json`.
- Production evidence-pack dry run with local validation forced:
  `recordings/audits/linkedin_production_evidence_pack_2026-06-02T07-44-23-020Z.json`.

## Requirement Coverage

Current status against the comprehensive audit request:

1. Custom Chromium native patch: partially audited. We found mixed-generation
   patch material and dirty shipped binary markers, but exact source/commit is
   still missing, so this cannot be closed. Native C++ source review is now
   explicitly deferred until the source is available.
2. Real Chrome baseline comparison: local harness exists, but local Chrome was
   148 and Playwright-launched. Still need same-version Chrome 147, same proxy,
   same viewport/persona, preferably on the production host.
3. LinkedIn-specific network behavior: legacy artifacts were analyzed. Need a
   post-hardening run with `complete_network.ndjson` to prove request headers,
   order, redirects, challenge endpoints, cookies, CSP/reporting, and body
   signals.
4. Playwright launch/runtime side effects: Weles now records OS-observed command
   line/risk buckets, but production has not produced a post-hardening row with
   those fields yet.
5. Runtime host coherence: metadata capture exists. Production still needs to
   prove OS, Chromium path/version, platformVersion, timezone, locale, proxy geo,
   WebGL, CPU, and screen coherence.
6. Proxy/IP quality: Node preflight, per-session metadata, and browser-side
   leak audit tooling now exist. Production rows currently have zero
   proxy-quality coverage, and the browser leak audit still needs to be run with
   the exact LinkedIn proxy.
7. Diagnostics capture pipeline: Weles-side redaction/page-visibility is
   partially audited. Storage/reporting visibility is understood as not
   page-visible, but retention and cross-app operational policy are not closed
   here.
8. Action layer/humanization: static audit and local event probe exist. The
   previous native select path emitted untrusted events and has been removed;
   the current safe native-select path refuses to select rather than dispatch
   page-context events. CDP input provenance remains tied to unreviewed native
   Chromium patches.
9. Captcha/challenge handling: static audit found unsafe generic solver paths
   and reCAPTCHA force/evaluate behavior. Weles now records host-side
   `action_diagnostics` counters for captcha solver paths, page-evaluate
   inspection/mutation, forced clicks, token/postMessage injection, and
   screenshots. Need LinkedIn post-hardening `session_meta.json` plus
   `loop_history.json` to prove which challenge path was actually used.
10. Production last-run evidence: current rows are pre-hardening. A repeatable
    recent-runs audit now exists, but the next decisive evidence requires a new
    deployed production run.
11. Preflight gate: local offline preflight exists and does not touch LinkedIn.
    The latest no-browser/no-GitHub run completed all checks and found no
    operational blockers, but it still failed clean-attribution because native
    Chromium provenance and action/captcha surfaces remain unresolved.

## Completion Matrix

Added an executable requirement matrix:

```sh
node scripts/debug/linkedin_audit_requirements_matrix.mjs
```

It does not launch a browser or touch LinkedIn. It consumes the latest audit
reports under `recordings/audits/` and maps evidence to the 10 requested audit
areas. It deliberately ignores synthetic recent-runs fixture reports for
production proof; fixture rows can validate parser behavior, but only real
Supabase/MCP recent-run snapshots can satisfy production evidence requirements.

Latest normal matrix report:
`recordings/audits/linkedin_audit_requirements_matrix_normal_2026-06-02T08-03-14-310Z.json`.

Latest deferred-native matrix report:
`recordings/audits/linkedin_audit_requirements_matrix_deferred_native_2026-06-02T09-21-40-716Z.json`.

To continue the non-C++ audit while source review is deferred:

```sh
WELES_AUDIT_DEFER_NATIVE_SOURCE=1 \
  node scripts/debug/linkedin_audit_requirements_matrix.mjs
```

This does not mark the native layer clean. It changes the native requirement
status from contradicted to deferred so the active gate can focus on evidence
that can be collected now.

Matrix report filenames include the active mode (`normal` or
`deferred_native`) so normal and deferred reports cannot overwrite each other.

Current matrix verdict: `complete = false`.

Latest deferred-native matrix verdict: `complete = false`,
`status_counts = { deferred: 1, incomplete: 3, missing: 6 }`.

Normal status counts:

- `contradicted = 1`: custom Chromium native patch.
- `incomplete = 3`: real Chrome baseline, diagnostics capture pipeline, and
  action layer/humanization.
- `missing = 6`: LinkedIn-specific post-hardening network behavior,
  production actual process tree, runtime host coherence, proxy/IP quality,
  LinkedIn captcha/challenge diagnostics, and production last-run root-cause
  evidence.

Deferred-native status counts:

- `deferred = 1`: custom Chromium native patch/source review.
- `incomplete = 3`: real Chrome baseline, diagnostics capture pipeline, and
  action layer/humanization.
- `missing = 6`: LinkedIn-specific post-hardening network behavior,
  production actual process tree/profile state, runtime host coherence,
  proxy/IP quality, LinkedIn captcha/challenge diagnostics, and production
  last-run root-cause evidence.

The matrix currently reports:

- Area 1, custom Chromium native patch, is contradicted because exact shipped
  source is not proven, the runtime bundle scan is not clean, and patch
  semantics are incomplete/risky. In deferred-native mode this is treated as
  deferred, not clean.
- Area 2, real Chrome baseline, is incomplete because the latest Chrome/Weles
  comparison is not a valid LinkedIn baseline.
- Area 3, LinkedIn-specific network behavior, is missing because no real
  post-hardening production row has uploaded `complete_network.ndjson` plus the
  new complete-network summary evidence.
- Area 4, Playwright launch/runtime, is missing production proof because recent
  rows do not include an actual process tree plus profile-state metadata.
- Area 5, runtime host coherence, is missing because production rows lack the
  complete host/startup/proxy coherence evidence.
- Area 6, proxy/IP quality, is incomplete because the browser proxy/WebRTC audit
  has not proven the exact LinkedIn proxy path.
- Area 7, diagnostics capture pipeline, is incomplete until production verifies
  the new artifact/session fields and residual sensitive local captures remain
  controlled.
- Area 8, action/humanization, is incomplete because the active LinkedIn action
  surface still uses CDP keyboard input even though the latest local event probe
  has `untrusted_count = 0`.
- Area 9, captcha/challenge handling, no longer has an active static
  token/postMessage blocker in the LinkedIn flow; it is still missing
  production proof because real LinkedIn rows lack action/captcha diagnostics.
- Area 10, production last-run evidence, is missing because no real production
  row is ready for root-cause analysis.

## Production Evidence Pack

Added a production evidence-pack orchestrator:

```sh
node scripts/debug/linkedin_production_evidence_pack.mjs "$LINKEDIN_REGISTER_PROXY"
```

By default it does not navigate to LinkedIn. It runs the preflight audit, then
the requirement matrix, and runs the recent-runs audit when Supabase credentials
are available. Even when `WELES_EVIDENCE_RUN_LINKEDIN=1` is set, it now runs
the LinkedIn trajectory only if preflight reports
`operationally_ready_for_linkedin_attempt = true`; otherwise the attempt is
skipped and recorded as `linkedin_attempt_blocked_by_preflight = true`. It writes
`recordings/audits/linkedin_production_evidence_pack_<ts>.json`.

Local/offline dry run:

```sh
WELES_EVIDENCE_SKIP_BROWSER=1 \
WELES_EVIDENCE_SKIP_GITHUB=1 \
WELES_EVIDENCE_SKIP_RECENT_RUNS=1 \
WELES_AUDIT_DEFER_NATIVE_SOURCE=1 \
node scripts/debug/linkedin_production_evidence_pack.mjs
```

Latest safety dry-run report with `WELES_EVIDENCE_RUN_LINKEDIN=1` requested but
blocked by preflight:
`recordings/audits/linkedin_production_evidence_pack_2026-06-02T09-01-49-655Z.json`.

Dry-run result:

- `all_commands_ok = true`.
- `linkedin_navigation_requested = true`.
- `linkedin_navigation_attempted = false`.
- `linkedin_attempt_blocked_by_preflight = true`.
- `preflight_operationally_ready = false` without a dedicated/static proxy env.
- `preflight_clean_for_attribution = false`.
- `matrix_complete = false`.
- `matrix_status_counts = { deferred: 1, incomplete: 4, missing: 5 }`.
- `preflight_deferred_attribution_risks` contains native source/provenance
  risks.
- `operational_blockers` contain the missing dedicated proxy declaration and
  missing country/timezone/language/platform pins on this Mac.
- `preflight_attribution_blockers = ["action_cdp_keyboard"]`.

To spend a controlled LinkedIn attempt after preflight:

```sh
WELES_EVIDENCE_RUN_LINKEDIN=1 \
LINKEDIN_REGISTER_PROXY="$LINKEDIN_REGISTER_PROXY" \
LINKEDIN_PROXY_KIND=dedicated \
LINKEDIN_PROXY_COUNTRY=US \
WELES_EXPECTED_TIMEZONE=America/New_York \
WELES_EXPECTED_LANGUAGE=en-US \
WELES_CLIENT_HINTS_PLATFORM_VERSION=15.6.1 \
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
node scripts/debug/linkedin_production_evidence_pack.mjs "$LINKEDIN_REGISTER_PROXY"
```

`WELES_EVIDENCE_RUN_LINKEDIN=1` requests the attempt but does not bypass
preflight. `WELES_EVIDENCE_FORCE_LINKEDIN=1` exists as an intentional override,
but it should not be used for normal LinkedIn evidence collection.

The script records a redacted snapshot of LinkedIn-relevant environment switches:
proxy selection, expected country/timezone/language, client-hints platform
version overrides, page-visible instrumentation flags, complete-network capture
disable flag, and public-artifact escape hatch. Proxy URLs are redacted.

The decisive post-run gate remains: at least one real production
`linkedin_register` row must have `result.session`, `result.ban_signal`,
`result.session.proxy_quality`, `startup_fingerprint_probe`,
`complete_network_capture` metadata, uploaded `complete_network.ndjson`,
non-page-visible `action_diagnostics`, and
`launch_metadata.actual_process_tree`. Until that exists, root-cause
attribution from production failures is still not proven.

Added a local post-run recording validator:

```sh
node scripts/debug/linkedin_local_recording_audit.mjs linkedin_register
```

It does not launch a browser or touch LinkedIn. It validates
`recordings/linkedin_register` for the local artifacts that must exist before a
replay is trusted or uploaded:

- `session_meta.json`
- `ban_signal.json`
- `loop_history.json`
- `network.ndjson`
- `complete_network.ndjson`
- `complete_network.meta.json`
- complete-network request/response/header phases
- page-visible diagnostics off
- register storage not injected
- proxy quality
- startup fingerprint probe
- non-page-visible action diagnostics
- actual process tree
- redacted final URL/hash
- video

The validator also warns on local sensitive JSON files such as
`session_responses_<ts>.json`, `environment_<ts>.json`, or `account.json`.
Those are not uploaded by default, but they remain sensitive on worker disk.

Latest local validator report:
`recordings/audits/linkedin_local_recording_audit_2026-06-02T07-44-12-305Z.json`.

Result on the existing old local `recordings/linkedin_register` directory:
`complete = false`. It only has old screenshots/DOM files and is missing the
post-hardening evidence: session metadata, ban signal, loop history, complete
network capture, proxy quality, startup probe, action diagnostics, actual
process tree, final URL hash, and video.

The evidence-pack runner now runs this validator automatically after a controlled
LinkedIn attempt. It can also be forced during dry runs with
`WELES_EVIDENCE_VALIDATE_LOCAL=1`. Latest forced-validation dry run:
`recordings/audits/linkedin_production_evidence_pack_2026-06-02T07-44-23-020Z.json`;
it correctly reports `local_recording_complete = false` for the stale local
recording directory.

## Hardened In Weles

- Page-visible diagnostics are opt-in:
  `WELES_PASSKEY_STUB`, `WELES_ARKOSE_CAPTURE`,
  `WELES_AUTH_FETCH_CAPTURE`, `WELES_CODEC_SHIM`,
  `WELES_ENABLE_CHROME147_STUBS`.
- `WELES_INSTRUMENT=1` does not inject page traps unless
  `WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION=1` is also set.
- Register labels do not inject stored cookies unless
  `WELES_ALLOW_REGISTER_STORAGE_INJECTION=1`.
- `linkedin_register` refuses direct, generic `residential`/rotating-style
  provider tokens, and LinkedIn proxy escape hatches before it starts Weles.
  It starts with `injectStorage: false`.
- `linkedin_register` also requires an explicit dedicated/static proxy
  declaration (`LINKEDIN_PROXY_KIND=dedicated`,
  `WELES_LINKEDIN_PROXY_KIND=dedicated`, or static/static_ip equivalent),
  country/timezone/language/platformVersion pins, complete-network capture on,
  private artifact refs, register storage injection off, and all page-visible
  diagnostic stubs off before it starts Weles.
- The direct trajectory guard can be validated without launching Weles or
  touching LinkedIn:
  `WELES_LINKEDIN_VALIDATE_GUARD_ONLY=1 node scripts/trajectories/linkedin_register.mjs`.
  A missing-env negative check fails before session start with blockers for
  proxy, dedicated declaration, country, timezone, language, and
  platformVersion. A dummy explicit proxy plus pins returns `ok = true` in
  guard-only mode. Enabling `WELES_INSTRUMENT=1` with
  `WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION=1` is rejected as
  `page_visible_instrumentation_off`.
- The older CDP launcher now writes `--weles-fingerprint=<file>` instead of
  passing inline JSON, matching the renderer-side native parser.
- New sessions persist non-secret host/runtime/coherence metadata into
  `session_meta.json`: production OS/arch/release, selected env overrides,
  Chromium path/version, sanitized intended launch args/default-arg policy,
  OS-observed process command line, launch-risk buckets, redacted profile-state
  metadata for the observed `--user-data-dir`, fingerprint config hash and
  client-hints summary, context options, startup navigator /
  `userAgentData` / screen / WebGL / media-codec / permissions / storage probe,
  exit-IP probe result, and proxy quality metadata.
- Proxy quality metadata includes Node direct IP vs proxy exit IP, IP
  intelligence from `ipwho.is`, inferred IP class
  (`mobile`, `datacenter`, `residential_or_isp`, or `unknown`), ASN/org, country,
  timezone, and country/language/timezone coherence checks.
- `linkedin_register` now writes a structured `ban_signal.json` on both success
  and failure using the LinkedIn ban-signal detector, and no longer calls
  `process.exit(1)` before `s.close()`. This preserves final session metadata,
  video, and `network.ndjson` on failed runs.
- `linkedin_register` now enables CDP-side complete network capture by default.
  It writes `complete_network.ndjson` plus `complete_network.meta.json` without
  adding page scripts or globals. Disable with
  `WELES_DISABLE_COMPLETE_NETWORK_CAPTURE=1`; enable for other flows with
  `WELES_COMPLETE_NETWORK_CAPTURE=1`.
- `complete_network.meta.json` now includes `network_evidence`: request order,
  header-order hint counts, signup/challenge/API/reporting endpoint summaries,
  redirect summaries, Set-Cookie names, response/request header-name counts, and
  body-safety counters. This is derived from CDP events and keeps raw secret
  headers/body values redacted.

## LinkedIn Preflight Gate

Added a one-command preflight summary:

```sh
node scripts/debug/linkedin_preflight_audit.mjs "$LINKEDIN_REGISTER_PROXY"
```

It does not navigate to LinkedIn. It runs the source/runtime/patch semantics,
diagnostics pipeline, action-surface, dedicated/static proxy readiness,
proxy-quality, launch-runtime, and browser-side proxy/WebRTC leak audits when
applicable, then writes
`recordings/audits/linkedin_preflight_audit_<ts>.json`.

Dedicated proxy readiness can also be checked offline:

```sh
LINKEDIN_REGISTER_PROXY="$LINKEDIN_REGISTER_PROXY" \
LINKEDIN_PROXY_KIND=dedicated \
LINKEDIN_PROXY_COUNTRY=US \
WELES_EXPECTED_TIMEZONE=America/New_York \
WELES_EXPECTED_LANGUAGE=en-US \
WELES_CLIENT_HINTS_PLATFORM_VERSION=15.6.1 \
node scripts/debug/linkedin_dedicated_proxy_readiness_audit.mjs "$LINKEDIN_REGISTER_PROXY"
```

This gate does not launch a browser or touch LinkedIn. It blocks missing/direct
proxy config, provider-class tokens such as generic residential/rotating pools,
missing dedicated/static declaration, missing country/timezone/language/platform
pins, page-visible instrumentation switches, public artifact refs, disabled
complete-network capture, and register storage injection.

For local/offline checks that must not touch the browser or GitHub credential
helper:

```sh
WELES_PREFLIGHT_SKIP_BROWSER=1 WELES_PREFLIGHT_SKIP_GITHUB=1 \
WELES_AUDIT_DEFER_NATIVE_SOURCE=1 \
  node scripts/debug/linkedin_preflight_audit.mjs
```

`WELES_PREFLIGHT_SKIP_GITHUB=1` now propagates to the source-provenance audit as
`WELES_SOURCE_PROVENANCE_SKIP_GITHUB=1`, so it skips `gh release`, `gh repo`,
and `gh search` calls instead of only blanking token environment variables. This
avoids GitHub credential-helper/keychain prompts during an offline audit.

`WELES_AUDIT_DEFER_NATIVE_SOURCE=1` keeps native risks visible under
`deferred_attribution_risks`, but removes them from the active attribution
blocker set while the native source review is intentionally deferred.

Latest offline/no-browser report:
`recordings/audits/linkedin_preflight_audit_2026-06-02T09-07-18-062Z.json`.

Result:

- `checks_completed = true`.
- `operationally_ready_for_linkedin_attempt = false` for this offline run
  because the local environment does not currently declare a dedicated/static
  proxy and matching persona pins.
- `clean_enough_for_root_cause_attribution = false`.
- `operational_blockers` are the dedicated/static proxy readiness blockers:
  missing proxy, dedicated declaration, country, timezone, language, and
  platformVersion pins.
- `deferred_attribution_risks` include native source/provenance/runtime bundle
  issues while source review is deferred.
- `attribution_blockers = ["action_cdp_keyboard"]`.

Interpretation: the current hardened code should be able to produce useful new
LinkedIn evidence, especially `complete_network.ndjson`, `session_meta.json`,
`ban_signal.json`, and action diagnostics. But if a new run fails, attribution
must still account for the deferred native Chromium risk and the
CDP/action/challenge surface; proxy reputation alone cannot be blamed cleanly
from this environment.

## Current LinkedIn Flagging Hypotheses

The current best ranking from
`scripts/debug/audit_linkedin_observable_surface.mjs` is:

1. Native Weles Chromium binary/patch is dirty or divergent from real Chrome
   147. The installed app bundle still contains native strings for
   `WELES_DEBUG`, `weles_debug.log`, `weles_brands.log`,
   `/tmp/weles_brands.log`, `/Users/lukaszbartoszcze`, `weles-fingerprint`,
   and `webrtcIp`. The exact C++ source/commit for the shipped binary is still
   not visible in `wisent-ai`.
2. Launch/profile automation differs from a normal Chrome user. Playwright still
   controls the browser through a temporary automation profile and remote
   debugging mechanics; this can affect profile freshness, background services,
   timing, and command-line/process state. New `session_meta.json` records
   `launch_metadata.actual_command_line` and
   `launch_metadata.actual_command_line_risk_buckets` so this can be verified on
   production workers.
3. Page-visible compatibility stubs or optional diagnostics alter the JS
   surface. Chrome 147 stubs are now default-off, but when enabled they add
   top-level globals. Passkey, Arkose, fetch capture, codec shim, and property
   traps are also page-visible when enabled. New `session_meta.json` must prove
   these are off for LinkedIn runs unless intentionally tested.
4. Input/challenge event sequence is not human enough. Typing still uses CDP key
   events; mouse uses Playwright/CDP events by default; select/captcha helpers
   still contain `page.evaluate`, forced clicks, `dispatchEvent`, token
   injection, and `postMessage` fallback paths.
5. Cold identity/proxy reputation and persona/IP mismatch may dominate some
   failures. New runs now record host, persona, startup fingerprint, proxy
   summary, exit IP, IP intelligence, inferred IP class, and direct-vs-exit
   comparison, but the sampled May 29 production rows mostly predate that
   metadata.

This ranking is about what LinkedIn or LinkedIn-loaded challenge providers can
observe directly or infer from browser/network behavior. It excludes
Echo/Enterprise access-control concerns.

## Native Chromium Findings

The shipped Chromium bundle is not clean enough to use for LinkedIn while
calling the native layer audited.

- `gh repo list wisent-ai --limit 200` and `gh search repos 'weles-chromium'`
  did not find a `wisent-ai/weles-chromium` repo. The only Chromium source hits
  from GitHub code search are `wisent-ai/echo/scripts/chromium-arm64`
  plus release/download references in `wisent-ai/weles`.
- The Weles release body for `chromium-147.0.7727.108-weles.1` says the source
  was `chromium-build/src` branch `weles-147`, with Linux fixup commits
  `35d835833b5ea`, `11485e78c5809`, and `2c704e8d6417d`, but GitHub code search
  did not find those commit IDs in `wisent-ai`.
- Added source provenance audit:
  `node scripts/debug/chromium_source_provenance_audit.mjs`. It does not launch
  Chromium or touch LinkedIn; it checks the release body/assets, visible
  `wisent-ai` repos, GitHub code search for the expected branch/commits, local
  candidate source trees, and local patch directories.
- Latest source provenance report
  `recordings/audits/chromium_source_provenance_audit_2026-06-02T07-27-38-458Z.json`
  found `exact_source_found = false` and
  `can_call_shipped_binary_source_reviewed = false`. Blockers:
  `release_lacks_source_repo_url`, `expected_commits_not_found_in_local_repos`,
  `no_chromium_named_repo_visible_in_wisent_ai`,
  `local_patch_material_contains_debug_markers`, and
  `local_patch_material_contains_build_errors`.
- The same source provenance report saw only these relevant `wisent-ai` repos:
  `weles`, `echo`, `wisent-supabase-echo`, and
  `weles-firefox`; none is an exact Chromium source repo. The only local patch
  dir found was
  `/Users/jakubtowarek/Projects/echo/scripts/chromium-arm64`.
- `weles-patches.diff` contains hardcoded renderer debug file writes to
  `/Users/lukaszbartoszcze/.../recordings/weles_debug.log` and
  `/tmp/weles_brands.log`.
- Full app-bundle `strings` scan found those same debug markers in the installed
  shipped framework:
  `Chromium.app/Contents/Frameworks/Chromium Framework.framework/.../Chromium Framework`.
  Markers include `WELES_DEBUG`, `weles_debug.log`, `weles_brands.log`,
  `/tmp/weles_brands.log`, and `weles-fingerprint`.
- A production/worker-safe scanner now exists:
  `node scripts/debug/chromium_runtime_provenance.mjs [optional-chromium-path]`.
  It does not launch Chromium or touch LinkedIn; it resolves the installed
  binary, hashes it, captures host OS metadata, and scans executable bundle
  strings for risky native markers.
- The diff references `cfg->locale` and `cfg->webrtc_ip`; the standalone
  `patches/weles_fingerprint_config.{cc,h}` in the same tree does not define or
  parse those fields. The diff appears to contain multiple patch generations.
- The earlier main executable-only `strings` scan missed the issue because most
  Chromium code is in `Chromium Framework`; always scan the whole `.app` bundle.
- The native HTTP-side and renderer-side parsers differ across patch generations:
  some HTTP-side code accepts inline JSON, while renderer code expects a file
  path. Weles now uses a file path in both launch paths.
- The checked-in `build.log` contains compile errors around the WebRTC patch
  (`cfg->webrtc_ip`, `String::FromUtf8`), so the checked-in patch directory is
  not proof of a successful source build.
- Added a patch semantics audit:
  `node scripts/debug/audit_chromium_patch_semantics.mjs`. It does not launch
  Chromium or touch LinkedIn; it parses the available patch dump/checklist/config
  files/build log and writes a structured surface/risk report.
- Latest semantics report
  `recordings/audits/chromium_patch_semantics_audit_2026-06-02T07-27-46-650Z.json`
  found patch coverage for all audited native surfaces:
  command-line config, `navigator`/UA/client hints, core navigator/screen,
  WebGL, canvas, WebAudio, plugins/mime/codecs, WebRTC/IP, TLS/HTTP2/ALPS, and
  host debug side effects.
- The same report classifies the available source material as
  `incomplete_or_mixed_generation` and says the shipped binary cannot be called
  source-reviewed. Critical/high risks are native debug writes, WebRTC compile
  errors in the available tree, command-line parser generation mismatch, and
  `webrtc_ip` schema mismatch.
- Canvas and WebAudio native noise are present in the patch dump. If enabled,
  they may reduce stock fingerprint reuse, but they can also create non-Chrome
  numeric artifacts unless compared against a same-version real Chrome baseline
  on the same class of host/proxy/persona.
- Transcript evidence in `wisent-ai/claude-transcripts` references
  `/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/...`
  as the active local build tree and mentions a native
  `InputHandler::HandleMouseEvent` `movement_x/y` stamping patch built into
  `Chromium Framework` on 2026-05-14. This implies the shipped native surface is
  broader than `--weles-fingerprint` and includes action/event provenance code
  that must be source-reviewed too.

Page/network visibility assessment:

- The debug `fopen()` calls are native host file I/O, not direct page globals or
  network requests. LinkedIn should not be able to read the marker strings
  directly from page JavaScript.
- They can still create observable timing/behavior differences around
  `navigator.userAgentData` access, and `/tmp/weles_brands.log` is a host-side
  operational leak. Treat this binary as contaminated until rebuilt without
  debug writes and hardcoded paths.

Required before calling native clean:

- Locate or reconstruct the exact source/commit used to build
  `chromium-147.0.7727.108-weles.1`; current GitHub org search did not find a
  dedicated `weles-chromium` repo.
- Remove debug `fopen`/`WELES_DEBUG` code and hardcoded local/tmp paths from
  native patch sources.
- Rebuild and republish a new release tag, for example
  `chromium-147.0.7727.108-weles.2`, with release notes pointing to the source
  commit and patch diff.
- Verify the rebuilt `.app` bundle with:
  `node scripts/debug/audit_weles_chromium_patch.mjs`.
- Verify every worker host with:
  `node scripts/debug/chromium_runtime_provenance.mjs`.
- Verify the source/release chain with:
  `node scripts/debug/chromium_source_provenance_audit.mjs`; the native layer is
  not source-reviewed until this report has `exact_source_found = true`,
  release notes include a source repo URL, and the expected branch/commit is
  reachable.
- Verify the actual built binary from source with a probe that covers
  `navigator`, `navigator.userAgentData`, WebGL, canvas, audio, WebRTC,
  headers, TLS, and HTTP/2.

## Baseline Harness

New local harness:

```sh
node scripts/debug/audit_chrome_vs_weles.mjs
```

It captures:

- local Chrome via Playwright `channel: chrome`
- Weles custom Chromium via `WSession`
- JS fingerprint from `dist/diagnostics/fingerprint_probe.js`
- loopback request headers
- TLS/HTTP2 fingerprint via `tls.peet.ws`

The harness now supports an exact baseline binary and writes a
`comparability.valid_linkedin_baseline` verdict:

```sh
AUDIT_CHROME_PATH="/Applications/Google Chrome 147.app/Contents/MacOS/Google Chrome" \
AUDIT_EXPECT_CHROME_MAJOR=147 \
AUDIT_EXPECT_WELES_MAJOR=147 \
AUDIT_PROXY_SERVER="$LINKEDIN_REGISTER_PROXY" \
PROBE_PROXY="$LINKEDIN_REGISTER_PROXY" \
node scripts/debug/audit_chrome_vs_weles.mjs
```

It marks the baseline invalid when it is using a Playwright channel instead of
an explicit binary, the major versions differ, proxy paths differ, observed
network exit IP hashes differ, or primary timezone/locale do not match.
The harness now generates one shared Weles persona and applies its viewport,
device scale factor, timezone, and locale to the baseline Chrome context before
capturing both sides. The comparability gate also checks same viewport, same
screen surface, and same target/probe surface, so a future valid report proves
the "same persona, same target, same viewport" requirement rather than relying
on operator discipline.
`AUDIT_REQUIRE_EXACT_PROXY=0` can loosen exact-proxy checks for local smoke
tests, but the LinkedIn audit keeps the default exact-proxy requirement. For
non-interactive CI/worker probes, `AUDIT_HEADLESS=1`, `AUDIT_TIMEOUT_MS`, and
`AUDIT_FP_TIMEOUT_MS` are available, but a headed real-user Chrome remains the
cleaner LinkedIn reference.

Added a baseline-readiness audit:

```sh
node scripts/debug/chrome_baseline_readiness_audit.mjs
```

It does not launch a browser session or touch LinkedIn. It checks whether the
host has an explicit Chrome baseline binary, Chrome 147, Weles Chromium 147,
matching major versions, same proxy env for Chrome and Weles, persona geo pins,
and macOS client-hints platformVersion pins.

Latest readiness report:
`recordings/audits/chrome_baseline_readiness_audit_2026-06-02T08-45-52-621Z.json`.

Current local result: `ready_for_valid_linkedin_baseline = false`.

Blockers on this Mac:

- `AUDIT_CHROME_PATH` is not set.
- Installed Google Chrome is `148.0.7778.216`; expected Chrome 147.
- Weles Chromium is `147.0.7727.108`, so the major versions do not match.
- Same proxy is not configured for both Chrome and Weles.
- Persona country/timezone/language pins are not all present.
- macOS `platformVersion` client-hints pin is not present.

The requirement matrix now includes this readiness report under the real Chrome
baseline requirement, so the blocker is explicit before anyone runs the heavier
side-by-side harness.

Local run notes:

- Local Chrome was 148 while Weles was 147, so this machine is not a valid
  Chrome-147 baseline.
- Local Chrome showed `navigator.webdriver === true` because it was launched via
  Playwright. Use a non-automation reference browser or Bright Data reference for
  a cleaner baseline.
- JA4 and Akamai HTTP/2 matched between local Chrome and Weles in that run.
- JA3 hash differed and needs a version-matched baseline before attribution.
- A 2026-06-02 local smoke rerun after shared-persona alignment wrote:
  `recordings/audits/chrome_vs_weles_2026-06-02T08-46-17-191Z.json`.
  It correctly marked `valid_linkedin_baseline = false`; same viewport, screen,
  timezone, and locale passed, while the remaining blockers were no explicit
  Chrome baseline binary, Chrome 148 vs Weles 147, and skipped network-exit
  proof.

## Proxy/IP Quality Preflight

Future worker rows now persist proxy reuse evidence without raw proxy values:
`result.run.worker_env.proxy_refs` and `selected_proxy_ref` contain SHA-prefixes
for the exact proxy reference and the credentialless endpoint. This lets
`scripts/debug/linkedin_recent_runs_audit.mjs` answer whether failed attempts
used the same proxy or endpoint without exposing proxy credentials.
Session-level proxy summaries now also carry `ref_hash`, `endpoint_hash`, and
`sticky_id_hash`, so direct/non-worker runs can still be correlated by proxy
identity in `result.session.proxy_quality.proxy`.

Added a proxy-quality preflight:

```sh
node scripts/debug/proxy_quality_audit.mjs "$LINKEDIN_REGISTER_PROXY"
```

It does not launch a browser or touch LinkedIn. It resolves the same proxy
format Weles uses, probes the exit IP through the proxy, probes the direct host
IP, looks up IP intelligence, infers a rough IP class, and writes a report under
`recordings/audits/proxy_quality_audit_<ts>.json`.

LinkedIn-relevant risk labels include:

- `proxy_not_used_or_direct_leak` when direct host IP equals exit IP.
- `datacenter_ip_class` when ASN/org text looks like cloud/hosting.
- `country_mismatch` when `LINKEDIN_PROXY_COUNTRY` / `WELES_PROXY_COUNTRY` does
  not match IP geolocation.
- `language_country_mismatch` when language region and IP country disagree.
- `timezone_mismatch` when `WELES_EXPECTED_TIMEZONE` is set and disagrees with
  IP timezone.

Added a browser-side proxy/WebRTC leak audit:

```sh
node scripts/debug/browser_proxy_leak_audit.mjs "$LINKEDIN_REGISTER_PROXY"
```

It does not touch LinkedIn. It launches Weles Chromium with the same proxy
resolver, probes browser-observed IPv4/IPv6 exit IP, collects WebRTC ICE
candidate classes via STUN, compares browser exit IP hashes with Node direct and
Node proxy exit probes, records whether the startup fingerprint probe is present
in `session_meta.json`, and writes
`recordings/audits/browser_proxy_leak_audit_<ts>.json`.

Direct-mode local sanity run:

- Report:
  `recordings/audits/browser_proxy_leak_audit_2026-06-02T06-41-37-108Z.json`.
- Browser IPv4 probe succeeded.
- `api64.ipify.org` returned IPv4 on this host.
- IPv6-only probe failed with `ERR_ADDRESS_UNREACHABLE`, so this Mac does not
  prove IPv6 behavior for production.
- WebRTC produced 0 ICE candidates in this local direct run.
- Risk labels were empty for direct mode.
- `session_meta.json` included `startup_fingerprint_probe`, confirming the
  runtime coherence probe now executes and persists.

Still required:

- Run both proxy audits against the exact LinkedIn proxy/sticky session used by
  production. Direct-mode browser proxy audits now report
  `exact_linkedin_proxy_not_configured` unless
  `WELES_BROWSER_PROXY_AUDIT_ALLOW_DIRECT=1` is set explicitly.
- Treat `browser_uses_direct_ip`, `browser_exit_differs_from_node_proxy_exit`,
  `browser_ipv4_ipv6_exit_split`, `webrtc_direct_ip_leak`,
  `webrtc_unexpected_public_candidate`, `datacenter_ip_class`,
  `country_mismatch`, and `timezone_mismatch` as LinkedIn-relevant failures.

## LinkedIn Network Artifact Analysis

Added a redacted network-artifact analyzer:

```sh
node scripts/debug/linkedin_network_audit.mjs <network.ndjson path-or-url> [...]
```

It summarizes status codes, normalized signup/challenge/API/reporting endpoint
timelines, redirects, response header names, Set-Cookie names, CSP/reporting
presence, and body-signal labels without printing raw response bodies or secret
headers.

The analyzer accepts both the legacy `network.ndjson` and the new
`complete_network.ndjson` format. The new format adds CDP request/response
events, redacted request headers, POST body hashes/redacted excerpts, response
body hashes/redacted excerpts, response extra-info, loading failures, websocket
metadata, and header-order hints when Chromium exposes `headersText`.
Future `complete_network.meta.json` files also include the same high-level
network evidence summary so a production row can prove request order,
redirects, challenge/reporting endpoints, cookie names, and body-safety status
without running the analyzer separately.

Production artifacts analyzed on 2026-06-02:

- Completed keeper run:
  `5951b907-5356-44b6-8d27-7876dd5a0b4b`
- Failed pinned macOS/Chromium keeper run:
  `ca2082bd-4655-48a3-90f4-1a2844429a9a`
- Failed Windows/Firefox keeper run:
  `1043b679-1e0c-43c7-8fa0-731e9030aa28`
- Output:
  `recordings/audits/linkedin_network_audit_2026-06-01T22-29-07-350Z.json`

Findings from those artifacts:

- Existing `network.ndjson` entries have response headers and response body
  excerpts, but not request headers or request header order. They cannot prove
  header ordering, request cookies, or exact POST bodies.
- Both failed samples reached
  `www.linkedin.com/signup/api/cors/createAccount`, then branched into
  `www.linkedin.com/checkpoint/challengeIframe/<id>`.
- The completed sample also had reCAPTCHA/challenge-related traffic, so the
  mere presence of Google reCAPTCHA Enterprise assets is not a sufficient
  discriminator.
- The completed sample included later onboarding/checkpoint-association paths
  (`/onboarding/start/`, `/checkpoint/rm/associate`,
  `/flagship-web/rsc-action/actions/server-request`) that were absent from the
  failed samples.
- The Windows/Firefox failed sample loaded
  `www.google.com/recaptcha/enterprise/bframe`, while the pinned macOS/Chromium
  failed sample did not in the captured window. This may reflect challenge UI
  depth or timing rather than root cause.
- Reporting/telemetry volume is high in all samples; old artifacts classify a
  large fraction of entries as reporting. Treat these as background unless a
  specific report endpoint correlates with failure.

Still missing for LinkedIn-specific network proof until new production runs are
captured:

- Request header order where Chromium does not expose `headersText`.
- Browser cookie jar snapshots before/after `createAccount`, not just
  associated-cookie and Set-Cookie names from CDP network events.
- Raw CSP/report-to payload bodies for failure-correlated reports. The new
  recorder stores redacted excerpts and hashes, not raw sensitive payloads.
- Same-proxy, same-persona, version-matched successful vs failed capture after
  the hardened code is deployed.

## Launch Runtime Findings

- Added repeatable launch/runtime audit:
  `node scripts/debug/launch_runtime_audit.mjs [idle_ms=12000]`. It does not
  touch LinkedIn. It launches Weles with page-visible diagnostics disabled,
  records `session_meta.launch_metadata`, classifies launch/profile flags, idles
  on a blank page, samples redacted profile-state metadata, and observes CDP
  `Network.requestWillBeSent` events for background requests.
- Latest local report:
  `recordings/audits/launch_runtime_audit_2026-06-02T07-58-29-978Z.json`.
- A live process command-line capture showed that Playwright's custom Chromium
  launch path still added a large default suppression bundle by default:
  background networking/component update/default apps/extensions/sync disabled,
  feature disables including `HttpsUpgrades` and `Translate`,
  `metrics-recording-only`, `use-mock-keychain`, `password-store=basic`, and
  `remote-debugging-pipe`.
- Weles now ignores most of that suppression bundle for custom Chromium flows.
- Weles now records the OS-observed process command line in
  `session_meta.json`, not only the intended launch options. When a browser PID
  is available, it also records an OS process-tree snapshot so helper/renderer
  flags are not missed. The metadata groups flags into risk buckets: automation
  control, network stack changes, quiet-browser suppression, first-run profile,
  security/sandbox, Weles native flags, and Chromium debug/dev flags.
- Local macOS audit limitation fixed for custom Chromium launches: when
  Playwright does not expose a browser PID, Weles now scans the local process
  table using the executable path and `--weles-fingerprint` launch marker. The
  latest local launch audit captured `actual_command_line_available = true`,
  `actual_process_tree_available = true`, `actual_process_tree_count = 5`, and
  PID `5993`.
- The latest local launch audit observed 32 ignored Playwright default args, no
  `--disable-background-networking`, no `--disable-component-update`, no
  `--disable-extensions`, no `--disable-sync`, no `--metrics-recording-only`,
  and no `--no-first-run` in the observable/intended custom Chromium arg set.
- The same audit observed 0 external idle background requests during a 12-second
  blank-page window. This removes some background-noise risk locally, but it is
  also a possible sterile-profile signal; production should compare against a
  real user Chrome 147 baseline on the same host/proxy.
- New launch metadata records `actual_command_line.profile_state` without raw
  paths or file contents: user-data-dir hash, root/default profile entry counts,
  Local State / Preferences presence, First Run sentinel presence, extension
  state presence, cache/service-worker state presence, and freshness heuristics.
  The requirement matrix now treats production launch/runtime evidence as
  missing until real `linkedin_register` rows include both actual process tree
  and profile-state metadata.
- `--weles-fingerprint=<file>` remains intentionally present and is classified
  as a Weles-native launch flag. Whether that itself is fingerprintable depends
  on the native patch/source audit and final command-line observability.
- Do not remove `--use-mock-keychain` / `--password-store=basic` on macOS worker
  launches: without those, Chromium can prompt for the real macOS Keychain and
  block the run. That prompt was observed locally during this audit.
- The lower-level CDP launcher now also adds those two flags outside the
  quiet-browser bundle on macOS. A Keychain dialog during local testing means a
  Chromium launch path missed those flags or was launched outside Weles.
- `remote-debugging-pipe`, temp user-data-dir, and `no-startup-window` remain
  Playwright control/profile mechanics. They need a lower-level launcher to
  remove completely.
- During the 2026-06-02 launch audit, OS process inspection showed Weles
  renderer/helper flags including `--start-stack-profiler`; these are classified
  as `chromium_debug_or_dev` launch risks when present. Production must still
  show `actual_process_tree.available = true` in a post-hardening
  `linkedin_register` row before this item is closed for production.

## LinkedIn-Observable Diagnostics Findings

- Added repeatable diagnostics pipeline audit:
  `node scripts/debug/diagnostics_pipeline_audit.mjs`. It scans Weles capture,
  session, worker upload, Echo artifact rendering, and Enterprise
  artifact rendering code. It does not fetch artifact bodies.
- Latest report:
  `recordings/audits/diagnostics_pipeline_audit_2026-06-02T08-33-01-949Z.json`.
- `session_meta.json` redacts current URL and proxy credentials for run results.
- `session_meta.json` now writes the startup probe under
  `startup_fingerprint_probe`, matching the production recent-runs audit
  coverage check.
- `network.ndjson` captures response headers and up to 8192 bytes of response
  body for the latest 500 responses.
- `complete_network.ndjson` captures CDP network diagnostics for
  `linkedin_register` by default. It redacts cookie/auth/secret headers and
  stores response/request body hashes plus redacted text excerpts. This capture
  is not page-visible, but it is sensitive operational data and should stay in
  private artifact storage.
- `session_responses_<ts>.json` can be written locally by `Capture.save()` with
  captured response bodies. It is not uploaded by `upload-artifacts.ts` because
  `.json` is not an upload kind, but it remains sensitive on worker disk.
- `Capture.captureEnvironment()` is a latent unsafe API: it evaluates page JS and
  writes `document.cookie` plus localStorage into `environment_<ts>.json` if
  called. Current `linkedin_register` does not call it, but it should not be
  added to LinkedIn diagnostics.
- DOM dumps and screenshots are uploaded by worker runs.
- `upload-artifacts.ts` uploads only `.png/.jpg/.jpeg`, `.webm/.mp4`, `.html`,
  `.ndjson`, and `.log` with caps: 10 screenshots, 1 video, 1 DOM file, and 4
  logs. `session_meta.json` and `ban_signal.json` are imported into
  `account_action_logs.result`, not uploaded as artifact logs.
- `upload-artifacts.ts` now prioritizes diagnostic logs under the 4-log cap:
  `complete_network.ndjson` first, `network.ndjson` second, then newest
  `session_console_*.log`, then other logs. This prevents a post-hardening
  LinkedIn run from capturing `complete_network.ndjson` locally but failing
  production analysis because console logs won the upload cap.
- `.ndjson` uploads now use `application/x-ndjson`.
- Artifact refs default to private `recordings://...`; setting
  `WELES_ARTIFACT_PUBLIC_URLS=1` is the escape hatch back to public storage URLs
  and should stay off for LinkedIn diagnostics.
- Echo and Enterprise artifact views both resolve
  `recordings://...` or historical public refs through Supabase signed URLs for
  display.
- Supabase storage metadata audit:
  `recordings/audits/recordings_storage_audit_2026-06-02T08-50-00-000Z.json`.
  The `recordings` bucket is private (`public = false`) with a 50MB per-object
  limit. No artifact bodies, object names, or signed URLs were fetched for this
  audit.
- The storage audit found no `pg_policies` rows for `storage.objects` or
  `storage.buckets`, so storage access is governed by service-role upload/reporting
  code and signed URL generation rather than user-level storage RLS policies.
- Aggregate storage footprint at audit time: 28,461 objects, 18,043,442,312
  bytes, 28,435 objects older than 7 days, and 145 `linkedin_register` objects,
  all older than 7 days.
- The audit now flags that uploaded `recordings` bucket artifacts do not have a
  proven retention/lifecycle/delete policy in the audited code paths. Local
  pruning exists for some worker-side captures, but signed URL expiry is access
  expiry, not object retention.
- Echo and Enterprise Weles reporting read diagnostics with
  server-side service-role/admin clients and render redacted result JSON plus
  signed artifact URLs. This is not LinkedIn-visible, but RLS is bypassed in
  those reporting paths.
- Static reporting guard evidence now distinguishes the surfaces:
  Echo action detail is protected by Supabase auth, the
  `admin_users` middleware check, and an `account_id`/route consistency check.
  Enterprise Weles pages are protected by Enterprise session middleware, and
  `/api/weles/latest-success` explicitly requires an authenticated Enterprise
  console session because middleware skips `/api`.
- Remaining reporting access-control work is narrower: review whether
  Enterprise Weles diagnostics should be scoped to a role or row subset beyond
  "logged-in console user." The retention/lifecycle policy for uploaded
  `recordings` objects is still not proven.
- Enterprise Weles UI copy was updated to describe network artifacts as
  redacted diagnostics with body hashes/excerpts and WebSocket metadata, not
  byte-by-byte/full-body capture. The stale-label risk no longer appears in the
  latest diagnostics audit.
- Upload/storage/reporting is not page-visible to LinkedIn. For LinkedIn
  flagging, the relevant question is whether collection changes browser timing
  or injects page-visible code. Current complete-network capture uses CDP and no
  page scripts; optional page traps remain unsafe and are off by default.

## Production Last-Run Evidence

Queried Echo `account_action_logs` on 2026-06-02 for
`action = 'linkedin_register'`, without reading raw account metadata or captured
response bodies.

- Added repeatable redacted recent-run audit:
  `node scripts/debug/linkedin_recent_runs_audit.mjs [limit=80] [days=14]`.
  It requires `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY`, queries only `account_action_logs`, omits raw
  params/error text/artifact bodies, hashes account/worker IDs, and writes
  `recordings/audits/linkedin_recent_runs_audit_<ts>.json`.
- The recent-run audit now includes a per-row
  `post_hardening_evidence.ready_for_root_cause_analysis` gate. A row is not
  ready until it has `result.session`, `result.ban_signal`,
  `result.session.proxy_quality`, `startup_fingerprint_probe`,
  `complete_network_capture` metadata, uploaded `network.ndjson`,
  uploaded `complete_network.ndjson`, private `recordings://` artifact refs,
  no public artifact refs, at least one screenshot, a closed/uploaded video,
  final URL hash/state,
  `action_diagnostics` with `page_visible = false`, input-provenance counters
  such as `action.cdp_keyboard`, and
  `launch_metadata.actual_process_tree`.
- Worker results now include a redacted `result.run.worker_env` snapshot with
  relevant proxy/persona/diagnostic flags and expected coherence pins. The
  recent-runs gate requires `worker_env`, expected country/timezone/language or
  platform-version pins, no page-visible worker diagnostics, and successful
  worker/session coherence checks against captured session/proxy/startup
  metadata.
- The script also supports local verification without production access:
  `LINKEDIN_RECENT_RUNS_FIXTURE=rows.json node scripts/debug/linkedin_recent_runs_audit.mjs`.
- A strict synthetic fixture generator now exists:
  `node scripts/debug/linkedin_recent_runs_strict_fixture.mjs`. It writes
  `recordings/audits/linkedin_recent_runs_strict_fixture_rows.json` with one
  complete post-hardening row and one intentionally incomplete row.
- Latest strict fixture audit:
  `recordings/audits/linkedin_recent_runs_audit_2026-06-02T08-41-27-572Z.json`.
  It produced `post_hardening_evidence_ready_rows = 1` across 2 fixture rows,
  proving the stricter gate accepts only the row with session metadata, ban
  signal, proxy quality, startup probe, both network logs, private refs,
  screenshot, video, action diagnostics, input-provenance counters, actual
  process tree, worker env snapshot, worker/session coherence, page-visible
  diagnostics disabled at the worker level, and final URL state.
- Local shell did not have Supabase credentials for the original snapshot, so
  production coverage was checked via Supabase MCP with the same redaction
  policy. A refreshed MCP coverage query on 2026-06-02 found no
  `linkedin_register` rows in the last 24 hours; the latest started at
  2026-05-29 21:37:15 UTC.
- Refreshed aggregate MCP snapshot:
  `recordings/audits/linkedin_recent_runs_mcp_snapshot_2026-06-02T08-40-00-000Z.json`.
- Last 21 days: 2 completed, 81 failed, 5 still marked `running` across 88 rows.
- All 5 `running` rows are stale by more than one hour; the newest sampled stale
  run started on 2026-05-29 21:22:46 UTC.
- 35 rows still contain historical public artifact refs. 0 rows use private
  `recordings://...` refs in the current production snapshot.
- 33 rows uploaded legacy `network.ndjson`; 0 rows uploaded
  `complete_network.ndjson`.
- The strengthened post-hardening gate now also requires uploaded
  `network.ndjson`, private-only artifact refs, no public artifact refs,
  screenshot evidence, video evidence, final URL hash/state, worker env,
  expected coherence pins, worker/session coherence, and no page-visible worker
  diagnostic flags. The 2026-06-02 production snapshot predates those checks and
  remains insufficient.
- Coverage from current production rows: 47 rows include `result.session`; 51
  include `result.ban_signal`; 0 include `result.session.proxy_quality`; 0
  include `result.session.launch_metadata.actual_command_line`; 0 include
  `result.session.startup_fingerprint_probe`; 0 include
  `result.session.action_diagnostics`; 0 include input-provenance counters such
  as `action.cdp_keyboard`; 0 include `result.run.worker_env`; 0 include
  `complete_network.ndjson`.
- Current sampled production rows predate the post-hardening gate: they do not
  include `action_diagnostics`, `actual_process_tree`, or
  `complete_network.ndjson`, and they use historical public artifact refs, so
  `post_hardening_evidence_ready_rows` is expected to be 0 until the new worker
  code is deployed and a fresh run finishes.
- Recent failure signals are not uniform:
  `action_failed` (25), missing ban signal (37), `cold_identity_challenge` (4),
  `http_429` (2), plus scattered captcha, phone-gate, proxy/tunnel, email, and
  keeper-running/abandoned signals.
- Sampled recent rows did not include populated `result.session.browser`,
  `result.session.proxy`, persona timezone/locale, or exit IP fields. That means
  current production evidence is insufficient to prove host/proxy/persona
  coherence after the fact.
- Current code now records those fields for new runs, but this still needs to be
  verified on the production worker after deployment.
- The sampled May 29 evidence includes both an automated failure and a
  human-driven no-proxy pass on the same residential IP according to stored
  `ban_signal.details`, so action-layer/automation-event differences remain a
  live suspect alongside TLS/HTTP2 and proxy reputation.

## Action/Captcha Findings

- Added static action/captcha audit:
  `node scripts/debug/audit_linkedin_action_surface.mjs`. It scans the
  `linkedin_register` entrypoint plus the agent, session, human input, captcha,
  and launch modules for page-visible or non-human interaction surfaces.
- Latest static audit
  `recordings/audits/linkedin_action_surface_audit_2026-06-02T08-38-04-451Z.json`
  reports raw high risks for CDP keyboard, JS-dispatched event paths, captcha
  token/postMessage paths, and page-visible init scripts. For the current
  `linkedin_register` entrypoint, the active high finding is reduced to
  `cdp_keyboard`: `js_click` is disabled for the flow, captcha token/fetch/
  postMessage mutation paths are blocked by `captchaMutationPolicy =
  interactive_only`, and page-visible init helpers are not enabled by the
  trajectory or current env. The latent findings remain documented because they
  still exist in shared helper code.
- Added local event-sequence probe:
  `node scripts/debug/action_event_probe.mjs`. It opens only a local `data:`
  form page, drives Weles `fill()`, `click()`, and `select()`, and records the
  page-observed event sequence. It does not navigate to LinkedIn.
- Original probe result
  `recordings/audits/action_event_probe_2026-06-02T06-20-04-250Z.json` captured
  142 events. The Weles `fill()` and `click()` path produced trusted
  pointer/key/input/click events in this local page, including
  `pointerdown -> mousedown -> focus -> pointerup -> mouseup -> click` for
  focus/click and trusted `keydown/beforeinput/input/keyup` for typing.
- That original probe found one untrusted event: native `selectOption()` emitted
  `change:country:F` (`isTrusted=false`) because the native `<select>` path set
  `selectedIndex` and dispatched `new Event('change')` in page context. That
  implementation has been removed.
- Latest probe result
  `recordings/audits/action_event_probe_2026-06-02T08-37-43-525Z.json` captured
  117 events with `untrusted_count = 0`, but `selectResult = no-select-found`.
  The safe native `<select>` path found the option and attempted focus +
  keyboard input, but Weles Chromium did not change the selected option on the
  local page. A Playwright `locator.selectOption({label})` experiment selected
  successfully but emitted untrusted `input` and `change` events, so it was not
  kept.
- `recordings/action_event_probe/session_meta.json` now contains host-side
  `action_diagnostics` with `page_visible = false`. In the latest local probe it
  recorded `action.start = 3`, `action.ok = 3`, `diagnostics.screenshot = 6`,
  `diagnostics.dom_snapshot = 6`, and `action.cdp_keyboard = 3`, with recent
  entries for each action and no page-visible debug scripts/globals. The CDP
  keyboard entries store only method/provenance and character count, not typed
  values. This same field is now the production proof point for screenshot/DOM
  volume and risky action/captcha/input paths.
- Current conclusion for LinkedIn: native `<select>` handling should be treated
  as unsupported for sensitive register flows unless we add a real OS/native
  input driver or prove a target-specific trusted event sequence. Failing to
  select is preferable to sending page-observable synthetic `input/change`.
- `linkedin_register` is LLM-driven through `src/agent/loop.ts`. Every step
  captures a screenshot for the LLM, and every `WSession._action()` captures
  before/after screenshots and DOM dumps. This is not page-visible by itself,
  but it creates high-volume diagnostics and should be retained only as long as
  needed.
- `src/agent/loop.ts` now supports per-flow disabled tools. `linkedin_register`
  passes `disabledTools: ['js_click']`, so the LLM prompt omits `js_click` and
  the dispatcher rejects it if a saved flow or model output tries to use it.
- Main `fill()` now uses a human click plus CDP key events. However, the shared
  `humanType()` path still uses `Input.dispatchKeyEvent` in
  `src/human/keyboard.ts`. This relies on the native Chromium patch removing
  debugger provenance. The local probe shows page-level `isTrusted=true`, but
  that is necessary, not sufficient: without proving the shipped native patch
  source, event provenance remains unproven.
- `click()` uses screenshot/vision targeting plus CDP mouse events. The current
  implementation does not use OS-level events for LinkedIn register by default.
- `selectOption()` still uses page evaluation to inspect dropdown state, but no
  longer dispatches native `<select>` events from page context. ARIA/CSS
  dropdown paths still use CDP locator clicks and need comparison with OS-level
  input on a real Chrome baseline.
- A repo-wide search still finds JS-dispatched `input/change` events in other
  platform trajectories and in the lower-level CDP locator fill helper
  (`src/cdp/dom/locator.ts`). Those are broader action-surface risks if reused
  by LinkedIn or future register flows, but they are not part of the current
  `linkedin_register` WSession path unless explicitly invoked.
- reCAPTCHA Enterprise solving uses frame evaluation to read instructions/grid
  state, external solver classification, and forced element clicks for tiles.
  In `interactive_only` captcha policy, the old page-context JS-click fallback
  for Verify now fails closed instead of dispatching a JS click.
- Generic captcha helpers can also inject tokens or emit page-context messages:
  `g-recaptcha-response` assignment, hCaptcha `captcha_key` resubmission, and
  FunCaptcha `window.postMessage({eventId:"challenge-complete", ...})`. For
  `linkedin_register`, `captchaMutationPolicy: 'interactive_only'` blocks those
  token assignment, fetch resubmit, Turnstile token solver, and postMessage
  completion paths and records `captcha.policy.blocked_mutation` diagnostics
  when they are attempted.
- Weles now records those captcha paths in `session_meta.action_diagnostics`
  without adding page scripts: `captcha.solver_path`,
  `captcha.page_evaluate.inspect`, `captcha.page_evaluate.mutate`,
  `captcha.forced_click`, `captcha.diagnostics.screenshot`, and
  `captcha.diagnostics.extracted_grid`. A post-hardening LinkedIn failure should
  be classified by these counters before attributing the failure to proxy or
  native fingerprint alone.
- Arkose capture and WebAuthn/passkey stubbing are disabled by default and only
  installed when their explicit env flags are set. If enabled, they create
  page-visible behavior and should be treated as unsafe for LinkedIn until a
  target-specific need is proven.
- The current `linkedin_register.mjs` entrypoint does not explicitly enable
  `passkeyStub`, `arkoseCapture`, or `authFetchCapture`; runtime env flags can
  still enable them, and new `session_meta.json` records those env/runtime
  switches.

## Still Needed

- Run the side-by-side harness on the production worker host.
- Run with the exact LinkedIn proxy class used in failing runs.
- Run `scripts/debug/proxy_quality_audit.mjs` against the exact proxy before
  every controlled LinkedIn replay and keep the report with the run artifacts.
- Compare a successful and failed LinkedIn run using uploaded `network.ndjson`,
  uploaded `complete_network.ndjson`, session metadata, proxy exit IP, and ban
  signal.
- Verify whether production has `WELES_CLIENT_HINTS_PLATFORM_VERSION` or
  `WELES_MAC_PLATFORM_VERSION` pinned.
- Add stale-run cleanup for `linkedin_register` rows stuck in `running`.
- Ensure every new run persists non-secret session coherence metadata:
  Chromium path/version, OS, timezone, locale, proxy provider/country, redacted
  exit IP metadata, WebGL vendor/renderer, CPU/screen, actual process command
  line, launch-risk buckets, IP intelligence, inferred IP class, and
  direct-vs-exit leak check.
- Deploy and verify the new `linkedin_register` failure path on production:
  failed rows should have `result.ban_signal`, `result.session`,
  `result.artifacts.logs` containing `network.ndjson` and
  `complete_network.ndjson`, private-only `recordings://` artifact refs,
  `result.run.worker_env.selected_proxy_ref`, proxy reuse hashes, 
  screenshots, final URL hash/state, and a closed video.
- Run `scripts/debug/linkedin_recent_runs_audit.mjs` after deployment and require
  `post_hardening_evidence_ready_rows >= 1` before drawing a root-cause
  conclusion from production data. If the gate fails, use
  `post_hardening_missing_counts` to fix the missing artifact/metadata path
  first.
- Compare CDP-dispatched input events against a real OS-event run or move the
  LinkedIn register flow to a native-event driver for the critical form/challenge
  steps.
- Source-review the native `InputHandler::HandleMouseEvent` patch referenced in
  transcripts before relying on CDP mouse event provenance.
