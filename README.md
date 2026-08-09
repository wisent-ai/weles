# Weles

Stealth browser automation: fingerprint spoofing + scheduler-driven trajectories for social-account automation.

## What this is

TypeScript + Node package that drives custom-patched Chromium and Firefox binaries to run per-action trajectories against social platforms. The worker polls `account_action_logs` in the Echo Supabase project over PostgREST, claims rows atomically, and spawns one trajectory subprocess per row.

- **Fingerprint defense**: C++ Chromium patches (canvas noise removal, UA reduction, brand list, ALPS, HEVC codec shim) applied in a separate repo (`../chromium-build/`); Gecko patches in `../firefox-build/patches/`. This repo consumes the built binaries as checksum-verified Stado releases via `scripts/chromium/download.sh` and `scripts/firefox/download.sh`.
- **Runtime**: Playwright-driven Chromium/Firefox, agent loop through Jeden → Brama (`src/agent/jeden.ts`), flow replay cache (`src/session/flows.ts`) for faster repeat runs.
- **Queue producers**: `wisent-app` inserts rows — `src/app/api/assistants/cron/refresh-tickers/route.js` and `src/app/api/assistants/stock-context/[symbol]/enqueue/route.js` — through its Echo service-role client (`src/lib/supabase/echo.js`). This worker drains the queue. `@wisent-ai/weles-client` is the safe submission boundary for services that should not touch the table directly.

## Worker releases

Immutable worker bundles belong to this repository's `worker-vX.Y.Z` GitHub
Releases channel. `.github/workflows/release-worker.yml` builds the tagged
source, embeds source provenance, and publishes a checksum sidecar. See
[`scripts/worker/deploy/README.md`](scripts/worker/deploy/README.md) for exact
installation and rollback coordinates. Browser binaries and Skarbiec remain
separately installed integrations; Weles neither republishes nor requires their
release channels to publish its own worker.

## Install + build

```bash
npm install
npm run build            # tsc → dist/
bash scripts/chromium/download.sh   # installs the exact Stado Chromium release
bash scripts/firefox/download.sh    # installs the exact Stado Firefox release
```

Both download scripts require `STADO_RELEASE_API_URL` (or `STADO_RELEASE_LOCAL_ROOT`) plus the release version and SHA-256 for that browser. They write a `.weles-release` receipt only after verifying the archive checksum and the executable layout.

## Run

```bash
# Foreground
node scripts/worker/run.mjs

# Or systemd / launchd — see scripts/worker/deploy/README.md for the unit + env file
```

Required env (`scripts/worker/deploy/launch.sh` refuses to start without all of it; the deploy runbook has the full list):

- `WELES_DATABASE_URL`, `WELES_DATABASE_TOKEN` — the Echo PostgREST endpoint and scoped token. Legacy `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are unset by the launcher; the values are acquired per-item from Skarbiec.
- `STADO_MODEL_ROUTER_URL`, `WELES_STADO_MODEL_ROUTER_TOKEN`, `WELES_STADO_MODEL_ROUTER_AGENT_ID`, `WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET` — the browser agent reaches models only through Brama.
- `WELES_AGENT_MODEL` — must be the exact Brama alias `weles/agent/primary`; `canonicalModel()` throws on anything else.
- `STADO_API_URL`, `WELES_STADO_OBJECT_API_TOKEN`, `STADO_RELEASE_API_URL`.
- `WELES_WORKER_RELEASE_VERSION` / `_SHA256`, `WELES_CHROMIUM_RELEASE_VERSION` / `_SHA256`, `WELES_FIREFOX_RELEASE_VERSION` / `_SHA256` — no browser resolves without a matching release receipt. `CHROMIUM_PATH` and other explicit path overrides are retired: `wsession.ts` throws if one is set.
- `WELES_ARTIFACT_DELIVERY_HOST`, `_PORT`, `_URL`, `WELES_ARTIFACT_DELIVERY_TOKEN`, `WELES_ARTIFACT_SIGNING_SECRET`.
- `WELES_OPERATOR_CDP_URL`, `WELES_OPERATOR_CDP_TOKEN`.
- `WELES_ACTION_ALLOWLIST` — the exact dispatchable action catalog.
- `WELES_PLACEMENT_MODE=required` and `WELES_PLACEMENT_POLICY_FILE`; the worker
  claims only actions assigned to its OS hostname in the product-owned local
  policy. `off` is a local-development escape hatch.
- `OKO_WELES_SUBSCRIPTIONS_TOKEN`, `CONTENT_DIAGNOSTICS_API_URL` / `_TOKEN`, `TRADING_TOOLS_INGEST_URL` / `_TOKEN` / `_HMAC_SECRET`.

## Directory layout

```
weles/
├── src/
│   ├── worker/poll.ts         # scheduler-driven work loop; spawns one trajectory per row
│   ├── worker/claim.ts        # atomic claim against account_action_logs
│   ├── worker/dispatch.ts     # action name → trajectory path + params→env
│   ├── worker/stale.ts        # zombie sweep, wedge watchdog, startup orphan reclaim
│   ├── worker/schema_compatibility.ts  # startup schema-version gate
│   ├── session/wsession.ts    # session launcher over the verified browser release
│   ├── session/find_browser.ts # release-receipt + SHA-256 browser resolution
│   ├── async_api.ts           # Playwright setup + fingerprint injection
│   ├── browser/persona.ts     # persona generation; 60/40 chromium/firefox rotation
│   ├── agent/loop.ts          # browser-automation agent loop + flow replay
│   ├── agent/jeden.ts         # Jeden → Brama model call, capability-scoped
│   ├── fingerprint.ts         # fingerprint config generator
│   ├── platforms/             # per-platform ban-signal detectors
│   ├── utils/credentials.ts   # getSocialAccount(), resolveAccountSession()
│   ├── cli.ts                 # `weles` binary
│   ├── mcp.ts                 # `weles-mcp` JSON-RPC surface
│   └── …
├── scripts/
│   ├── worker/run.mjs         # systemd / launchd / foreground entry
│   ├── worker/deploy/         # unit files + launch wrappers + runbook
│   ├── trajectories/          # per-action flows (480 .mjs files across 86 entries)
│   │   ├── _shared/           # action-runner, benign, llm helpers
│   │   ├── github/ reddit/ instagram/ linkedin/ discord/ google/ microsoft/ …
│   │   ├── anticaptcha/ capmonster/ capsolver/ nopecha/  # solver integrations
│   │   ├── brightdata/ decodo/ iproyal/ oxylabs/ packetstream/  # proxy vendors
│   │   └── {platform}_{login|register|...}.mjs  # legacy flat trajectories
│   ├── chromium/download.sh   # install the exact Stado Chromium release
│   └── firefox/download.sh    # install the exact Stado Firefox release
├── dist/                      # tsc output (git-ignored)
├── package.json
└── README.md
```

## Fingerprint spoofing

Chromium patches live in `../chromium-build/` (separate repo) and are applied as direct edits against upstream Chromium source — e.g. canvas noise removal in `third_party/blink/renderer/platform/graphics/image_data_buffer.cc`, a weles command-line switch in `chrome/common/switches.cc`. The TS side of weles passes a generated fingerprint config via `--weles-fingerprint=<path>.json` (`src/async_api.ts`, `src/browser/api.ts`) which the patched binary reads at startup.

JS-level helpers in `src/scripts/` (injected via `addInitScript()`) fill gaps the C++ patches can't cover cleanly — notably the HEVC codec shim (`chrome147_stubs.js`), the screen/WebRTC patch, and the navigator stubs.

## Firefox parity — shipped

Firefox carries the same engine-level fingerprint defense stack as Chromium and is drivable end-to-end from weles trajectories via Playwright's juggler protocol.

- **Binary**: published as `stado://releases/weles-firefox/<version>/<platform>/weles-firefox.tar.gz`. Install via `bash scripts/firefox/download.sh` with `WELES_FIREFOX_RELEASE_VERSION` and `WELES_FIREFOX_RELEASE_SHA256` set.
- **Gecko patches** live in `../firefox-build/patches/`: pref registration, `navigator.webdriver` short-circuit, WebGL vendor/renderer de-sanitize, `nsScreen` overrides, `window.outer*` overrides, plus one extra patch wiring `juggler-navigation-started-browser` through `CanonicalBrowsingContext::LoadURI(nsIURI*, ...)` so Playwright's `Page.navigate` works.
- **Juggler** (Playwright's automation extension) is baked in at the matching version. `WSession.start({ browser: 'firefox' })` routes via `findCustomBrowser('firefox')` → `async_api.firefox.launch(executablePath, firefoxUserPrefs)` with the `weles.fingerprint.*` pref group that the patched binary reads.
- **`src/browser/persona.ts`** rotates 60/40 chromium/firefox. Both paths have engine-level enforcement; JA4 rotation between BoringSSL and NSS is the side benefit.
- **CI auto-probe**: `.github/workflows/firefox-integration.yml` verifies each new release against the trajectory driver. Manual-trigger only (macOS runner cost).

Full phase-by-phase checklist in [scripts/firefox/PATCHING.md](scripts/firefox/PATCHING.md).

## Database schema

The worker database schema is owned by
[`wisent-ai/wisent-supabase-echo`](https://github.com/wisent-ai/wisent-supabase-echo),
which is the only source of truth for the Supabase project `yqizdfkfnmhddfemdxtq`.
Every DDL change — tables, columns, indexes, policies, functions, and the
`weles_schema_migrations` ledger row that records it — is proposed as a pull
request in that repository and applied only by its CI on `main`. This repository
holds no migrations, no `supabase/config.toml`, and no linked-project state;
`supabase/` is gitignored so a local `supabase`-CLI `link` cannot reintroduce
them.

No one runs the `supabase` CLI locally against production. Applying DDL by hand
from a workstation — `db query`, `db push`, or any other write subcommand
against the production project — bypasses the review and deployment gate and is
prohibited. The repository pre-commit hook additionally refuses to commit
`supabase`-CLI invocations.

What this repository declares is the schema version it requires. At startup
`src/worker/schema_compatibility.ts` reads the highest `version` from the
`weles_schema_migrations` table over the Supabase REST endpoint
(`/rest/v1/weles_schema_migrations?select=version&order=version.desc&limit=1`)
and refuses to run unless that version falls inside an inclusive range:

- `WELES_DATABASE_SCHEMA_MINIMUM`, default `4`
- `WELES_DATABASE_SCHEMA_MAXIMUM`, default `5`

Both defaults are the literals in `assertDatabaseCompatibility`
(`env.WELES_DATABASE_SCHEMA_MINIMUM ?? '4'`, `env.WELES_DATABASE_SCHEMA_MAXIMUM ?? '5'`),
so an unconfigured deployment accepts schema versions `4..5`; the deployment
environment may narrow or advance the range, but only positive integers with
minimum not greater than maximum are accepted. A ledger that is empty,
unreadable, or outside the range is a startup failure, not a warning. Widening
that range is a code change here; producing the schema version it points at is a
change in `wisent-supabase-echo`.

## License

MIT

---

### History note

The `weles` repo briefly hosted a parallel Python implementation (Playwright Firefox + JS-level spoofing) alongside this TypeScript one. The Python tree was deleted after every consumer of it in the Wisent codebase was either ported or accepted as breakage — the TypeScript rewrite has been the production-automation path since early April 2026 (commit *"Rewrite weles from Python to TypeScript"*).

If you hit a script elsewhere in the Wisent monorepo that does `from weles import AsyncWeles`, that script is broken until it's ported to shell out to this TypeScript package or rewritten.

---

## Fingerprint capture inventory

Canonical inventory of every channel captured per WSession run is one file: **[`scripts/worker/deploy/FINGERPRINT_CAPTURE.md`](scripts/worker/deploy/FINGERPRINT_CAPTURE.md)**.

That file enumerates 76 collector surfaces across 13 sections (A–M): JS-runtime property/observer hooks, rendering/graphics/media/audio fingerprint, the CDP firehose and browser-internal state, network and transport (pcap, SSL keylog, NetLog, HAR, decoded HTTP/2, JA4 family), host OS and hardware, weles/browser launch provenance, DOM and accessibility structure, per-origin storage and identity, workers and cross-context messaging, WebRTC and peer transport, trajectory/input/visual evidence, crash and diagnostics, and the provenance/dedup/update protocol. Each item flagged **[W]** wired, **[P]** partial, or **[T]** todo. Source of truth for what is captured per WSession run — matches the `buildDumpPayload` field set in `src/session/wsession-helpers/net_record.ts`. Items land in the merged `recordings/<label>/<label>.inst.json` (large payloads via sibling-file path references). `scripts/debug/fp_matrix/diff.mjs <a.inst.json> <b.inst.json>` produces a per-field PASS-vs-FAIL delta over this shape.
