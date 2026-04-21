# Weles

Stealth browser automation: fingerprint spoofing + scheduler-driven trajectories for social-account automation.

## Two implementations live in this repo

This repository hosts **two independent implementations** of weles under one tree. Read the section that matches what you're doing before editing anything.

### 1. TypeScript weles (active; this is what you want)

- Location: `src/` + `scripts/` + `dist/`
- Manifest: `package.json` (`"name": "weles"`, currently 0.4.x)
- Backed by: **custom-patched Chromium** (built from the separate `chromium-build/` repo; prebuilt binary installed via `scripts/chromium/download.sh`)
- Entry point: `scripts/worker/run.mjs` — the long-running worker process
- Consumers:
  - Production automation stack (polls `account_action_logs` in Supabase, claims rows, spawns trajectories)
  - `scripts/trajectories/**/*.mjs` — per-action trajectories (`github_login.mjs`, `reddit/promote.mjs`, `tiktok/actions/follow.mjs`, etc.)
  - content-platform's `/api/cron/campaign-scheduler` and `/api/cron/<platform>-simulation` routes enqueue work that this worker drains
- Fingerprint defense: C++ Chromium patches (canvas noise removal, UA reduction, brand list, ALPS, HEVC codec shim) PLUS the JS-level spoofing the Python version pioneered

**Build:** `npm install && npm run build`
**Run worker:** `node scripts/worker/run.mjs` (see `scripts/worker/deploy/README.md` for systemd)

### 2. Python weles (legacy; frozen)

- Location: `weles/` (Python package), `pyproject.toml` (0.3.x)
- Backed by: **Playwright Firefox** + JS-level spoofing via `addInitScript()`
- Last touched on 2026-04-08 — no longer updated
- Replaced by the TypeScript implementation starting with commit `"Rewrite weles from Python to TypeScript"` (2026-04-05); parity reached with `"Bring TypeScript weles to full parity with Python version"` (2026-04-12)
- Still imported by a small number of operator utilities:
  - `content-platform/scripts/lib/balance-check/check-balances.py` (residential-IP balance scraping)
  - `content-platform/scripts/oxylabs/native/*.py` (manual proxy diagnostics)
  - `content-platform/recordings/*.py` (one-off Google SSO probes)
  - `content-platform/scripts/chromium-arm64/test/probe_*.py`
  - `backends/wisent-enterprise/scripts/vast/login_and_get_key.py`
- These scripts are **manually-run utilities**, not part of the automation pipeline. Keep the Python tree in place until they're migrated.

If you're an agent coming in cold and you see `from weles import AsyncWeles` in some script, that's the Python (Firefox) API. If you're touching the automation pipeline — worker, trajectories, campaign-scheduler — you want the TypeScript API, none of which matches what the Python README example shows.

## What each implementation spoofs

Both versions spoof navigator, screen, WebGL, canvas, audio, timezone, and automation signals. The TypeScript version additionally patches at the C++ level (Chromium source tree) — enough fingerprint surface that TikTok signup reaches the 6-digit code step without error_code 7 (the original Python/Firefox version could not get past that gate).

## Directory layout

```
weles/
├── src/                     # TypeScript implementation (active)
│   ├── worker/poll.ts       # scheduler-driven work loop
│   ├── session/wsession.ts  # Chromium launcher (picks up custom binary)
│   ├── agent/loop.ts        # claude -p browser-automation agent
│   ├── fingerprint.ts       # fingerprint config generator
│   ├── platforms/           # per-platform ban-signal detectors
│   ├── utils/credentials.ts # getSocialAccount, resolveAccountSession
│   └── …
├── scripts/
│   ├── worker/run.mjs       # systemd / foreground entry
│   ├── worker/deploy/       # systemd unit + runbook
│   ├── trajectories/        # per-action flows (164 .mjs files)
│   └── chromium/download.sh # install prebuilt custom Chromium
├── weles/                   # Python package (legacy, frozen)
├── chromium-build/          # NOT HERE — separate repo at ../chromium-build
├── dist/                    # tsc output, git-ignored
├── package.json             # v0.4.x — the TypeScript package
├── pyproject.toml           # v0.3.x — the Python package (legacy)
└── README.md                # this file
```

## License

MIT
