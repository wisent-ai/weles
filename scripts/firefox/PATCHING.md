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
- [ ] **P1.5** Extend `src/diagnostics/capture_fingerprint_local.mjs` to support firefox as the target browser so we can A/B against real Firefox Nightly.
- [x] **P1.6** Postinstall hook so the Playwright identifier scrub survives `npm install` / `npm ci`. `scripts/postinstall/playwright_scrub.mjs` renames the three `__playwright_*` identifiers to `__wpc_*_fb3e7a__` and deletes the `_setupGlobalListenersRemovalDetection` call site. Idempotent; preserves a `.bak` alongside the target. Wired into `package.json` `postinstall`.

## Phase 2 — Engine-level Gecko patches (separate session, requires Firefox fork)

Multi-day effort. Requires cloning `mozilla-central` (or basing on Playwright's Firefox fork), installing `mach` + `rustup` + `cargo`, and a 4–8h initial build.

- [ ] **P2.1** Scaffold a `firefox-build/` sibling repo beside `chromium-build/` with a README capturing branch, build args, and output paths.
- [ ] **P2.2** Port canvas-noise removal to Gecko. Candidate sites: `gfx/thebes/gfxPlatform.cpp` and `image/imgFrame.cpp` — Firefox does not implement `NoiseCanvasPixmap` but has its own resistFingerprinting canvas path (`CanvasUtils::IsImageExtractionAllowed`) that needs taming.
- [ ] **P2.3** Port navigator overrides to `dom/base/Navigator.cpp` (userAgent, platform, hardwareConcurrency, language, languages, oscpu, buildID, vendor).
- [ ] **P2.4** Port screen overrides to `dom/base/Screen.cpp` (width, height, availWidth, availHeight, colorDepth, pixelDepth, devicePixelRatio).
- [ ] **P2.5** Port outer-window overrides to `dom/base/nsGlobalWindowOuter.cpp` (outerWidth, outerHeight, screenX, screenY).
- [ ] **P2.6** Add a `--weles-fingerprint=<path>` command-line switch. Firefox generally drives config via `user.js` prefs — wire the JSON → pref mapping at startup instead of adding a brand-new switch if simpler.
- [ ] **P2.7** Add a weles branding flag so the `CFBundleName` / `CFBundleDisplayName` no longer renders as `Nightly.app`; the existing `findCustomChromium` resolution ladder in `src/session/wsession.ts` will then pick the patched Firefox if installed at the expected path.
- [ ] **P2.8** Release pipeline: build tarball, publish to GitHub Releases in `wisent-ai/weles-firefox` (parallel to the existing Chromium release), extend `scripts/chromium/download.sh` to also fetch the Firefox build.

## Phase 3 — Validation + rotation flip

- [ ] **P3.1** Side-by-side fingerprint capture: patched Firefox vs. real Firefox Nightly on the same Mac with the same proxy. Diff: `navigator.*`, `screen.*`, WebGL vendor, canvas hash, TLS JA4 (`tls.peet.ws`), `audio_codecs`, `distinctivePropsHits` from the property-trap harness.
- [ ] **P3.2** Pass BotD / creepjs / amiunique with no "automation" verdict.
- [ ] **P3.3** Wire an auto-probe into weles CI that asserts the gap stays closed on every new Firefox build.
- [ ] **P3.4** Flip `src/browser/persona.ts:111` back to `br < 0.60 ? 'chromium' : 'firefox'`. Re-run the 107-row migration in reverse to restore rotation across existing accounts.

## Scope notes

- "Parity" does not mean "identical to Chromium". It means the same *level* of defense: engine-level enforcement of every surface a bot classifier reads, with a documented JSON config driving it at launch.
- Phase 1 removes the single-worst Firefox tell (Chrome-global leak) and closes the pref-level gaps that don't need a fork. Phase 1 alone does **not** make Firefox pass classifiers that sandbox-escape JS hooks — only Phase 2 does.
- Playwright's Firefox is re-based roughly every 2–3 weeks. The Phase 2 patch set must be maintained against that cadence or rebased onto a pinned mozilla-central tag.
