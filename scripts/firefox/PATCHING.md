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

- [ ] **P2.1** Scaffold a `firefox-build/` sibling repo beside `chromium-build/` with a README capturing branch, build args, and output paths.
- [ ] **P2.2** `navigator.webdriver` at engine level. `dom.webdriver.enabled=false` is ignored when Playwright drives via juggler — it hardcodes `webdriver=true` in the Firefox binary. Needs either a patched juggler (drop the flag) or a C++ override in `dom/base/Navigator.cpp`.
- [ ] **P2.3** WebGL vendor/renderer spoofing. `webgl.renderer-string-override` + `webgl.vendor-string-override` prefs exist but Firefox normalizes the values ("Apple Inc." is returned as "Apple"; "Apple M3" is coerced to "Apple M1, or similar"). Needs a patch in `dom/canvas/WebGLContext.cpp` to honor the raw pref string.
- [ ] **P2.4** Screen overrides — `screen.width`, `screen.height`, `screen.availWidth`, `screen.availHeight`. No pref exists; needs a patch in `dom/base/Screen.cpp` that reads from a new `weles.screen.*` pref set or a JSON config.
- [ ] **P2.5** Window-outer overrides — `window.outerWidth`, `window.outerHeight`, `window.screenX`, `window.screenY`. Needs a patch in `dom/base/nsGlobalWindowOuter.cpp`.
- [ ] **P2.6** Release pipeline: patched Firefox tarball in `wisent-ai/weles-firefox` + a `scripts/firefox/download.sh` mirror of `scripts/chromium/download.sh`. Extend `src/session/wsession.ts::findCustomChromium` → `findCustomBrowser(browser)` so WSession resolves a patched Firefox binary the same way it resolves Chromium.

## Phase 3 — Validation + rotation flip

- [ ] **P3.1** Side-by-side fingerprint capture: patched Firefox vs. real Firefox Nightly on the same Mac with the same proxy. Diff: `navigator.*`, `screen.*`, WebGL vendor, canvas hash, TLS JA4 (`tls.peet.ws`), `audio_codecs`, `distinctivePropsHits` from the property-trap harness.
- [ ] **P3.2** Pass BotD / creepjs / amiunique with no "automation" verdict.
- [ ] **P3.3** Wire an auto-probe into weles CI that asserts the gap stays closed on every new Firefox build.
- [ ] **P3.4** Flip `src/browser/persona.ts:111` back to `br < 0.60 ? 'chromium' : 'firefox'`. Re-run the 107-row migration in reverse to restore rotation across existing accounts.

## Scope notes

- "Parity" does not mean "identical to Chromium". It means the same *level* of defense: engine-level enforcement of every surface a bot classifier reads, with a documented JSON config driving it at launch.
- Phase 1 removes the single-worst Firefox tell (Chrome-global leak) and closes the pref-level gaps that don't need a fork. Phase 1 alone does **not** make Firefox pass classifiers that sandbox-escape JS hooks — only Phase 2 does.
- Playwright's Firefox is re-based roughly every 2–3 weeks. The Phase 2 patch set must be maintained against that cadence or rebased onto a pinned mozilla-central tag.
