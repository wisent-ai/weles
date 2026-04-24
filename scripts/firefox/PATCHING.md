# Firefox Patching Plan

Close the Firefox vs. Chromium fingerprint-defense gap. Pairs with the README
Roadmap entry. Once Phase 3 is validated, `src/browser/persona.ts` can flip
back to a 60/40 chromium/firefox rotation.

## What Chromium gets today

| Layer | Mechanism | Location |
|---|---|---|
| Engine canvas | `NoiseCanvasPixmap` removed (opt-in via `canvas:{}`) | `chromium-build/src/.../image_data_buffer.cc` |
| Engine navigator/screen/window | C++ overrides read from `--weles-fingerprint` | `chromium-build/src/.../navigator_*.cc`, `screen.cc`, etc. |
| Engine input trust | `isTrusted=true` on CDP-routed clicks | `input_handler.cc` (stock behavior, documented) |
| Engine network | CDP hardening, proxy socket hardening | `network_handler.cc`, `http_proxy_client_socket.cc` |
| Launch-time config feed | `--weles-fingerprint=<json>` flag | `switches.cc` + TS `toCppConfig` writes the JSON |
| JS API stubs | Chrome 147 globals (`Sanitizer`, `AnimationTrigger`, `TimelineTrigger*`) | `src/scripts/chrome147_stubs.js` |
| JS navigator spoofing | `Navigator.prototype` property overrides | `src/scripts/navigator.js` |
| JS WebGL spoofing | Vendor / renderer overrides | `src/scripts/webgl.js` |
| JS automation scrub | `navigator.webdriver` removal | `src/scripts/automation.js` |
| Playwright identifier scrub | sed on `playwright-core/lib/generated/injectedScriptSource.js` to rename `__playwright_*` globals | per-checkout, see memory |
| TLS fingerprint | BoringSSL defaults — real Chrome JA4 | stock build side-effect |

## What Firefox gets today

Playwright-managed Firefox Nightly (`~/Library/Caches/ms-playwright/firefox-*/firefox/Nightly.app`) with `context.addInitScript(buildInitScript(fpConfig))` plus:

- `automation.js` — cross-browser `navigator.webdriver` removal ✅
- `navigator.js` — Navigator-prototype overrides; `userAgentData` block is guarded by `navigator.userAgentData` existence so it is inert on Firefox ✅
- `webgl.js` — WebGL vendor / renderer overrides (cross-browser) ✅
- `chrome147_stubs.js` — **FATAL BUG**: injects `window.Sanitizer`, `window.AnimationTrigger`, `window.TimelineTrigger`, `window.TimelineTriggerRange` onto Firefox, which real Firefox does not expose. A classifier comparing "UA says Firefox but `typeof window.Sanitizer !== 'undefined'`" flags the session immediately. ⛔
- WebAuthn passkey stub / Arkose iframe observer / register fetch interceptor — behavior-only, safe cross-browser ✅
- TikTok Accept-Language strip — header-level, safe cross-browser ✅

Firefox does **not** get:

- A custom binary. All spoofing is JS-level via `addInitScript`, defeatable from iframes / workers / CSP-sandbox contexts that don't inherit the main-world script.
- An equivalent of `--weles-fingerprint`. No engine-level canvas / screen / navigator backstop.
- Pref-level fingerprint matching (`firefoxUserPrefs`) for `privacy.resistFingerprinting`, `intl.accept_languages`, `general.platform.override`, etc.
- A Playwright juggler-extension detection-surface scrub.

## Phase 1 — JS-level and launch-pref parity (no Firefox fork)

- [x] **P1.1** Stop injecting `chrome147_stubs.js` into Firefox. Make `buildInitScript(config, exclude?)` browser-aware so the Chrome-only stubs only load when `config.browser === 'chromium'`.
- [x] **P1.2** Add `src/scripts/firefox_stubs.js` for Firefox-specific masks: scrub Playwright juggler-extension markers, defensively delete any Chrome-only globals that leaked in, assert Firefox-expected navigator surfaces (`oscpu`, `buildID`). Loaded when `config.browser !== 'chromium'`.
- [x] **P1.3** Wire `firefoxUserPrefs` from the fingerprint config into `firefox.launch(launchOpts)`. Shipped: `privacy.resistFingerprinting: false`, `privacy.fingerprintingProtection: false`, `dom.webdriver.enabled: false`, plus `intl.accept_languages` + `general.useragent.override` when a persona language / custom UA is configured. In `src/async_api.ts`.
- [x] **P1.4** Playwright identifier scrub. `injectedScriptSource.js` is shared across Chromium and Firefox (single file in `playwright-core/lib/generated/`); the existing chromium scrub that renamed `__playwright_*` → `__wpc_*_fb3e7a__` applies to both. Firefox-specific `UTILITY_WORLD_NAME` in `ffPage.js` is a juggler protocol identifier — internal to the CDP/juggler handshake, not visible to the page's JS — so no rename needed. `firefox/stubs.js` additionally deletes leaked `window.__playwright*` / `window._playwright_*` keys at init time as defense in depth.
- [x] **P1.5** Extend `scripts/debug/capture_fingerprint_local.mjs` to support firefox as the target browser. Pass `PROBE_BROWSER=firefox` to capture via Playwright-managed Firefox; output written to `recordings/local_fingerprint_{chromium,firefox}.json` for side-by-side diffing. Required plumbing the `browser` option through `WSessionOptions` and skipping the custom-Chromium resolver when `browser === 'firefox'`.
- [x] **P1.6** Postinstall hook so the Playwright identifier scrub survives `npm install` / `npm ci`. `scripts/postinstall/playwright_scrub.mjs` renames the three `__playwright_*` identifiers to `__wpc_*_fb3e7a__` and deletes the `_setupGlobalListenersRemovalDetection` call site. Idempotent; preserves a `.bak` alongside the target. Wired into `package.json` `postinstall`.

## Phase 2 — Engine-level Gecko patches

Empirical audit in `scripts/firefox/prefs_audit.mjs` (run 2026-04-23) confirms
that the overwhelming majority of "Chromium C++ patches" have Firefox pref
equivalents that stick on the rendered page. The only real Gecko-fork patches
left for Phase 2:

### Pref-covered (no C++ patch — shipped via `firefoxUserPrefs` in `async_api.ts`)

- `navigator.userAgent` → `general.useragent.override` ✓
- `navigator.platform` → `general.platform.override` ✓
- `navigator.oscpu` → `general.oscpu.override` ✓
- `navigator.appVersion` → `general.appversion.override` ✓
- `navigator.hardwareConcurrency` → `dom.maxHardwareConcurrency` ✓
- `navigator.language` → `intl.accept_languages` (first entry seeds navigator.language in Gecko) ✓
- Canvas bitmap — Firefox returns the raw buffer when `privacy.resistFingerprinting=false` (no `NoiseCanvasPixmap` analogue to remove) ✓
- TLS fingerprint — Firefox NSS defaults match real Firefox ✓
- Audio codec support — same as real Firefox ✓

### Still requires a Gecko fork

- [x] **P2.1** Scaffold `firefox-build/` sibling repo beside `chromium-build/` with a README capturing the mach build recipe, pinned commit slot, GN args, expected output path, and the five patch targets. Empty `patches/` directory tracked via `.gitkeep` ready for Phase-2 `.patch` files.
- [x] **P2.2** `navigator.webdriver` at engine level. Real patch at `../firefox-build/patches/0002-weles-navigator-webdriver.patch`. Inserts a `weles.fingerprint.webdriver.force` short-circuit at the top of `Navigator::Webdriver()` in `dom/base/Navigator.cpp`. Verified applies cleanly to `gecko-dev@5836a062`.
- [x] **P2.3** WebGL vendor/renderer un-normalized. Real patch at `../firefox-build/patches/0003-weles-webgl-vendor-renderer.patch`. Gecko's vendor/renderer code actually lives in `dom/canvas/ClientWebGLContext.cpp` (not `WebGLContext.cpp`). Patch inserts `weles.fingerprint.webgl.{vendor,renderer}` reads in the `UNMASKED_*_WEBGL` branches of `ClientWebGLContext::GetParameter` before Firefox's `webgl::SanitizeRenderer`. Verified applies cleanly.
- [x] **P2.4** Screen overrides. Real patch at `../firefox-build/patches/0004-weles-nsScreen-overrides.patch`. Gecko's file is `dom/base/nsScreen.cpp` (not `Screen.cpp`). Patch adds the `mozilla/Preferences.h` include and inserts `weles.fingerprint.screen.*` reads at the top of `GetRect` and `GetAvailRect`. Verified applies cleanly.
- [x] **P2.5** Window-outer overrides. Real patch at `../firefox-build/patches/0005-weles-window-outer-overrides.patch`. Inserts `weles.fingerprint.window.*` reads at the top of `GetOuterSize` and `GetScreenXY` in `dom/base/nsGlobalWindowOuter.cpp`. Verified applies cleanly.
- [x] **P2.6** Release pipeline. **Shipped end to end 2026-04-23.** Repo: `wisent-ai/weles-firefox` (private). First release: `firefox-142.0a1-weles.1` with asset `weles-firefox-142.0a1-weles.1-macos-arm64.tar.gz` (91 MB, sha256 `9766b2041e366aa342cba62076e3bc614bf88dda0f476ee8a5e34402c34386d1`). `scripts/firefox/download.sh` defaults `WELES_FIREFOX_RELEASE=firefox-142.0a1-weles.1` and uses `gh release download` (private-repo capable) with a curl path for environments without the gh CLI. `findCustomBrowser('firefox')` picks up the installed binary at `~/.local/share/weles-firefox/142.0a1-weles.1/Firefox.app/Contents/MacOS/firefox`. Verified end to end: fresh install directory → `bash scripts/firefox/download.sh` → extracted → `firefox --version` reports "Mozilla Firefox 142.0a1".

## Phase 3 — Validation + rotation flip

- [x] **P3.1** Per-patch surface verification. `firefox-build/verify.mjs` launches the patched binary with a synthetic `weles.fingerprint.*` pref set via a profile `user.js`, opens a loopback HTTP page that reads each surface (navigator.webdriver, webgl UNMASKED_VENDOR/RENDERER, screen.{width,height,availWidth,availHeight}, window.{outer{Width,Height},screen{X,Y}}), POSTs the results, and asserts per-surface. **Run 2026-04-23 against `obj-weles/dist/Nightly.app`: 11/11 OK.** Every Phase 2 patch confirmed live. Does not need Playwright juggler so it can run against the raw mozilla-central build.
- [x] **P3.2** Side-by-side patched vs stock capture. `../firefox-build/scripts/diff_patched_vs_stock.mjs` drives both binaries against the same loopback HTTP test page with the same weles pref set and diffs every surface. Ran 2026-04-23 — every surface a weles patch targets is `DIFF`ed (webdriver, webgl vendor/renderer, screen.*, window.outer.*), untouched surfaces (platform, hardwareConcurrency, deviceMemory) correctly match. BotD / creepjs / amiunique / JA4 diffs not yet run — can reuse the same harness by swapping the test page URL.
- [ ] **P3.3** Wire an auto-probe into weles CI that asserts the gap stays closed on every new Firefox build.
- [x] **P3.4** `src/browser/persona.ts` rotation is back to `br < 0.60 ? 'chromium' : 'firefox'` (2026-04-24). Existing accounts stay on chromium — the 107-row migration is NOT reversed, because switching live accounts' browser mid-life would itself be a detection signal. Only NEW accounts get the 60/40 roll.

## Phase 4 — Playwright integration for the patched binary

Blocker surfaced 2026-04-23: our patched Firefox 142.0a1 is a vanilla
mozilla-central build plus the five weles patches. Playwright's
`firefox.launch({ executablePath })` fails because Playwright's Firefox
fork also carries the **juggler** extension (an in-tree WebExtension +
C++ hook layer the Playwright client speaks to over the `-juggler-pipe`
command-line switch). Upstream Firefox does not have juggler. `verify.mjs`
and `diff_patched_vs_stock.mjs` work around this by driving the binary
with raw `spawn` + loopback HTTP, but trajectory code needs a real
driver.

Two paths to close the gap. Either is multi-session work.

- [x] **P4.A — SHIPPED 2026-04-24.** Juggler v1.59.1 applied onto gecko-dev@5836a062. 58/69 `bootstrap.diff` files applied with fuzz; 4 `.rej`-casualty files reverted (`dom/media/systemservices/video_engine/desktop_capture_impl.{cc,h}`, `widget/InProcessCompositorWidget.cpp`, `widget/headless/HeadlessWidget.cpp`, `dom/base/nsContentUtils.cpp`); 1 include added manually (`nsDocShell.h` in `dom/html/HTMLInputElement.cpp`); `juggler/screencast/` subtree dropped from `juggler/moz.build` DIRS with `screencastService` stubbed to `null` in `juggler/TargetRegistry.js` at build time. One runtime fix needed beyond bootstrap.diff: `CanonicalBrowsingContext::LoadURI(nsIURI*, LoadURIOptions&, ErrorResult&)` also emits `juggler-navigation-started-browser` (bootstrap.diff only added it to `FixupAndLoadURIString`, but Playwright's `PageHandler.js::Page.navigate` calls the former, causing navigationId to return undefined). End-to-end verified: `weles/scripts/firefox/integration_test.mjs` PASSES — `WSession.start({ browser: 'firefox' })` → juggler pipe → `page.goto` → `navigator.webdriver === false` AND `navigator.platform === 'MacIntel'`. Artifact: `firefox-142.0a1-weles.4`.

### Historical P4.A reference

- **P4.A** Port Playwright's juggler patches onto our tree. Playwright
  maintains the patch set at `microsoft/playwright/browser_patches/firefox/`
  (cloned to `../firefox-build/juggler-upstream/playwright-repo/`)
  against a pinned `mozilla-firefox/firefox` release branch (currently
  `4eb5a4f7`); we target `mozilla/gecko-dev@5836a062`. The upstream
  structure is `juggler/` (the in-tree WebExtension + JSM) plus one
  monolithic `patches/bootstrap.diff` (2694 lines touching 69 files).

  Dry-run against our tree with `patch -p1 --dry-run --fuzz=5` (2026-04-23):
  58 of 69 files apply with fuzz; 11 files need manual resolution
  (11 hunks total across them). Conflict list — these are where Mozilla
  refactored since Playwright's base was cut:

  ```
  docshell/base/BrowsingContext.h                              (1/6 hunks)
  docshell/base/CanonicalBrowsingContext.cpp                   (1/2 hunks)
  docshell/base/nsDocShell.cpp                                 (1/13 hunks)
  dom/base/nsContentUtils.cpp                                  (2/4 hunks)
  dom/html/HTMLInputElement.cpp                                (1/2 hunks)
  dom/media/systemservices/video_engine/desktop_capture_impl.cc (1/7 hunks)
  dom/webidl/Window.webidl                                     (1/1 hunks)
  layout/style/GeckoBindings.h                                 (1/1 hunks)
  netwerk/base/LoadInfo.cpp                                    (1/2 hunks)
  widget/InProcessCompositorWidget.cpp                         (1/2 hunks)
  widget/headless/HeadlessWidget.cpp                           (1/2 hunks)
  ```

  After resolving: also copy `../firefox-build/juggler-upstream/playwright-repo/browser_patches/firefox/juggler/` into `mozilla-central/juggler/` and
  apply the `jar.mn` / `moz.build` entries from `bootstrap.diff`. Rebuild,
  re-run `verify.mjs` against the juggler-enabled binary (must stay
  11/11 OK — juggler doesn't touch any surface the weles patches
  override), then update `src/async_api.ts` firefox branch to pass
  `executablePath: findCustomBrowser('firefox')` so Playwright drives
  the patched binary.

  **In flight 2026-04-23:** `bootstrap.diff` applied with `patch -p1 --fuzz=5`
  (58/69 files clean, 11 rejected hunks skipped). `juggler/` copied into
  `mozilla-central/juggler/`. weles patches re-applied on top. Two compile
  failures discovered + worked around mid-build:

  1. `dom/media/systemservices/video_engine/desktop_capture_impl.{cc,h}` —
     partial-apply broke `webrtc::CritScope` / `webrtc::RecursiveCriticalSection`
     references (our newer Gecko has them in `rtc::`). **Reverted both files**
     entirely — Playwright's screen-capture additions to desktop_capture aren't
     needed for the juggler protocol.
  2. `juggler/screencast/` subtree references the same renamed `webrtc::*`
     types (`VideoCaptureModuleEx`, `VideoSinkInterface`, `RawFrameCallback`).
     **Dropped `screencast` from `juggler/moz.build` `DIRS`** so the subtree
     doesn't compile. Trajectory automation does not call `Page.startScreencast`,
     so this loses no surface weles uses.

  Post-build: `firefox-build/scripts/post_build.sh` runs verify → release.sh
  → upload weles.2 tarball → local install → `weles/scripts/firefox/integration_test.mjs`.
- **P4.B** Swap the firefox driver. Firefox ships native WebDriver BiDi
  (via Marionette + RemoteAgent) in every build. Write a thin
  `src/session/firefox_bidi.ts` that speaks WebDriver BiDi over a WS
  and exposes the subset of `page.*` / `context.*` the trajectories
  actually call. Cleaner and not Playwright-fork-maintenance, but
  every trajectory's playwright method set has to be covered.

## Scope notes

- "Parity" does not mean "identical to Chromium". It means the same *level* of defense: engine-level enforcement of every surface a bot classifier reads, with a documented JSON config driving it at launch.
- Phase 1 removes the single-worst Firefox tell (Chrome-global leak) and closes the pref-level gaps that don't need a fork. Phase 1 alone does **not** make Firefox pass classifiers that sandbox-escape JS hooks — only Phase 2 does.
- Playwright's Firefox is re-based roughly every 2–3 weeks. The Phase 2 patch set must be maintained against that cadence or rebased onto a pinned mozilla-central tag.
