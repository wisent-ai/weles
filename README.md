# Weles

Stealth browser automation: fingerprint spoofing + scheduler-driven trajectories for social-account automation.

## What this is

TypeScript + Node package that drives a custom-patched Chromium binary to run per-action trajectories against social platforms. The worker polls Supabase's `account_action_logs`, claims rows atomically, and spawns one trajectory subprocess per row.

- **Fingerprint defense**: C++ Chromium patches (canvas noise removal, UA reduction, brand list, ALPS, HEVC codec shim) applied in a separate repo (`../chromium-build/`). This repo consumes the built binary via `scripts/chromium/download.sh`.
- **Runtime**: Playwright-driven Chromium, agent loop via Claude Code CLI, flow replay cache for faster repeat runs.
- **Content-platform integration**: content-platform's `/api/cron/*-simulation` crons enqueue work; its `/api/cron/campaign-scheduler` drains operator-defined campaigns into the same queue; this worker drains the queue.

## Install + build

```bash
npm install
npm run build            # tsc → dist/
bash scripts/chromium/download.sh   # installs the custom Chromium binary
```

## Run

```bash
# Foreground
node scripts/worker/run.mjs

# Or systemd — see scripts/worker/deploy/README.md for the unit + env file
```

Required env (see `scripts/worker/deploy/README.md` for the full list):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET` (must match content-platform's)
- `CHROMIUM_PATH` (where the custom binary lives)
- `LLM_GENERATE_URL` (e.g. `https://content.wisent.ai/api/llm/generate`)

## Directory layout

```
weles/
├── src/
│   ├── worker/poll.ts         # scheduler-driven work loop (atomic claim from account_action_logs)
│   ├── session/wsession.ts    # Chromium launcher; picks up the custom binary
│   ├── async_api.ts           # Playwright setup + fingerprint injection
│   ├── agent/loop.ts          # claude -p browser-automation agent + flow replay
│   ├── fingerprint.ts         # fingerprint config generator
│   ├── platforms/             # per-platform ban-signal detectors
│   ├── utils/credentials.ts   # getSocialAccount(), resolveAccountSession()
│   └── …
├── scripts/
│   ├── worker/run.mjs         # systemd / foreground entry
│   ├── worker/deploy/         # systemd unit + launch wrapper + runbook
│   ├── trajectories/          # per-action flows (164 .mjs files)
│   │   ├── _shared/           # action-runner, benign, llm helpers
│   │   ├── github/            # github_login.mjs + github/star/, github/actions/
│   │   ├── reddit/            # reddit/promote.mjs + reddit/actions/
│   │   ├── tiktok/ instagram/ twitter/ linkedin/ discord/
│   │   └── {platform}_{login|register|...}.mjs  # legacy flat smoke tests
│   └── chromium/download.sh   # install prebuilt custom Chromium
├── dist/                      # tsc output (git-ignored)
├── package.json
└── README.md
```

## Fingerprint spoofing

Chromium patches live in `../chromium-build/` (separate repo) and are applied as direct edits against upstream Chromium source — e.g. canvas noise removal in `third_party/blink/renderer/platform/graphics/image_data_buffer.cc`, a weles command-line switch in `chrome/common/switches.cc`. The TS side of weles passes a generated fingerprint config via `--weles-fingerprint=<path>.json` which the patched binary reads at startup.

JS-level helpers in `src/scripts/` (injected via `addInitScript()`) fill gaps the C++ patches can't cover cleanly — notably the HEVC codec shim (`chrome147_stubs.js`) and the Sanitizer API stub.

## License

MIT

---

### History note

The `weles` repo briefly hosted a parallel Python implementation (Playwright Firefox + JS-level spoofing) alongside this TypeScript one. The Python tree was deleted after every consumer of it in the Wisent codebase was either ported or accepted as breakage — the TypeScript rewrite has been the production-automation path since early April 2026 (commit *"Rewrite weles from Python to TypeScript"*).

If you hit a script elsewhere in the Wisent monorepo that does `from weles import AsyncWeles`, that script is broken until it's ported to shell out to this TypeScript package or rewritten.
