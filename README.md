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

## Firefox parity — shipped

As of `firefox-142.0a1-weles.4`, Firefox carries the same engine-level fingerprint defense stack as Chromium and is drivable end-to-end from weles trajectories via Playwright's juggler protocol.

- **Binary**: `wisent-ai/weles-firefox` releases. Install via `bash scripts/firefox/download.sh` (defaults to the current tag, uses `gh release download` for private-repo auth).
- **Gecko patches** live in `../firefox-build/patches/` against `gecko-dev@5836a062`: pref registration, `navigator.webdriver` short-circuit, WebGL vendor/renderer de-sanitize, `nsScreen` overrides, `window.outer*` overrides, plus one extra patch wiring `juggler-navigation-started-browser` through `CanonicalBrowsingContext::LoadURI(nsIURI*, ...)` so Playwright's `Page.navigate` works.
- **Juggler** (Playwright's automation extension) is baked in at the matching version. `WSession.start({ browser: 'firefox' })` routes via `findCustomBrowser('firefox')` → `async_api.firefox.launch(executablePath, firefoxUserPrefs)` with the `weles.fingerprint.*` pref group that the patched binary reads.
- **`persona.ts`** rotates 60/40 chromium/firefox. Both paths now have engine-level enforcement; JA4 rotation between BoringSSL and NSS is the side benefit.
- **CI auto-probe**: `.github/workflows/firefox-integration.yml` verifies each new release against the trajectory driver. Manual-trigger only (macOS runner cost).

Full phase-by-phase checklist in [scripts/firefox/PATCHING.md](scripts/firefox/PATCHING.md).

## License

MIT

---

### History note

The `weles` repo briefly hosted a parallel Python implementation (Playwright Firefox + JS-level spoofing) alongside this TypeScript one. The Python tree was deleted after every consumer of it in the Wisent codebase was either ported or accepted as breakage — the TypeScript rewrite has been the production-automation path since early April 2026 (commit *"Rewrite weles from Python to TypeScript"*).

If you hit a script elsewhere in the Wisent monorepo that does `from weles import AsyncWeles`, that script is broken until it's ported to shell out to this TypeScript package or rewritten.

---

## Fingerprint capture inventory (canonical)

Every channel captured per WSession run lands in one merged artifact: `recordings/<label>/<label>.inst.json`, built by `buildDumpPayload` in `src/session/wsession-helpers/net_record.ts`. Large payloads (pcap, NetLog, HAR, screenshots, response bodies, heap snapshots, CDP firehose) are written to sibling files under the same `recordings/<label>/` dir and referenced from inst.json by path. `scripts/debug/fp_matrix/diff.mjs <a.inst.json> <b.inst.json>` produces a per-field PASS-vs-FAIL delta over this shape.

Status legend: **[W]** wired and emitting · **[P]** partial (some sub-channels captured, expansion listed) · **[T]** todo (named here, not yet wired).

### A. JS-runtime property surfaces (init-script + property-trap)

- **[W]** `navigator.*`, `window.*`, `screen.*`, `screen.orientation.*`, `document.*`, `location.*`, `history.*`, `performance.*` — own/prototype enumeration at session start via `SURFACE_INVENTORY_SCRIPT`; per-read access tee via `property_trap.js`.
- **[W]** `crypto.subtle.*` method wraps; `crypto.getRandomValues` call log.
- **[W]** `Intl.*` (DateTimeFormat, NumberFormat, Collator, RelativeTimeFormat, PluralRules, ListFormat, DisplayNames, Segmenter, Locale) `.resolvedOptions()` snapshot.
- **[W]** `Notification.permission`, `Permissions.query` wrap, `navigator.userAgentData.getHighEntropyValues()`, `navigator.connection`, `navigator.getBattery()`, `navigator.storage`, `navigator.locks`, `navigator.serviceWorker`, `navigator.hid/usb/serial/bluetooth.getDevices()`, `navigator.mediaDevices.enumerateDevices()`.
- **[W]** `navigator.languages/language/platform/appVersion/product/vendor/oscpu/buildID/webdriver/cookieEnabled/doNotTrack/deviceMemory/hardwareConcurrency/maxTouchPoints/pdfViewerEnabled/plugins/mimeTypes`.
- **[W]** `WebTransport`, `EventSource`, `BroadcastChannel`, `navigator.sendBeacon`, `fetch`, `XMLHttpRequest`, `WebSocket` constructor wraps.
- **[W]** `EventTarget.addEventListener` counter; `IntersectionObserver`, `ResizeObserver`, `MutationObserver`, `ReportingObserver` (auto-installed), `PerformanceObserver` constructor wraps.
- **[W]** `trustedTypes.getPolicyNames`, `indexedDB.databases()`, `Storage` entry hooks, `document.featurePolicy`, `document.fonts`, `Notification.requestPermission`.
- **[W]** `securitypolicyviolation` listener on document.
- **[T]** Full `MediaCapabilities.decodingInfo()` matrix across every known mime/codec.
- **[T]** Full `HTMLMediaElement.canPlayType()` + `MediaSource.isTypeSupported()` matrix.
- **[T]** Full pre-probe of `window.matchMedia` across the 16-query media-feature set.
- **[T]** Full pre-probe of `navigator.permissions.query` across all 30+ permission names.
- **[T]** `MutationObserver` rooted at `document` with full subtree + attribute-old-value + character-data-old-value (constructor wrap is in, root-on-init is not).
- **[T]** `Math.random`, `Date.now`, `performance.now`, `setTimeout/setInterval/queueMicrotask/requestAnimationFrame/requestIdleCallback` call-rate counters with stack traces.
- **[T]** `getBoundingClientRect` / `getClientRects` / `getComputedStyle` call counters with stack traces.
- **[T]** Pre-probed font fingerprint: width + bounding rect of a marker string across 100+ known font families.
- **[T]** `XRSystem.isSessionSupported` per mode, Sensor API readiness probe (Accelerometer/Gyroscope/Magnetometer/AmbientLight/Orientation/Gravity/LinearAcceleration).
- **[T]** `speechSynthesis.getVoices()` full enumeration.
- **[T]** `chrome.*` and `external.*` full property enumeration.

### B. Canvas / GPU / Audio fingerprint surfaces

- **[W]** Canvas `toDataURL` / `getImageData` — full base64 pixel data dumped via `fingerprint_hooks.js`.
- **[W]** `AudioBuffer.getChannelData` per-channel Float32 base64; `OfflineAudioContext.startRendering` rendered sum.
- **[W]** `RTCPeerConnection.createOffer/setLocalDescription/addIceCandidate/getStats` SDP + candidates + stats.
- **[W]** `WebGL.getParameter` spoof + `getSupportedExtensions()` + `WEBGL_debug_renderer_info` UNMASKED_VENDOR/RENDERER.
- **[W]** `WebGPU.requestAdapter()` adapter.info / features / limits.
- **[W]** `performance.memory`, `navigator.getBattery`, `navigator.connection` change events.
- **[T]** WebGL `getParameter` over every documented param ID (~200), every `getExtension` per-extension probe, `getShaderPrecisionFormat` for every shader/precision combo.
- **[T]** Canvas `measureText` full TextMetrics dump (actualBoundingBox*, fontBoundingBox*, alphabeticBaseline, hangingBaseline, ideographicBaseline).
- **[T]** `AnalyserNode.getFloatFrequencyData` first 256 bins on a known waveform.
- **[T]** `AudioContext.outputLatency` + `baseLatency` + `getOutputTimestamp()`.

### C. CDP firehose + final-state snapshots

- **[W]** Subscribe every documented CDP event from protocol.d.ts (210 after skip-list) via `cdp_events.generated.ts`; payloads land in `ws._instCdpFirehose`.
- **[W]** `DOMSnapshot.captureSnapshot` (currently 41 CSS properties); `DOM.getDocument({pierce:true})` closed-shadow walk; `HeapProfiler.takeHeapSnapshot` full graph.
- **[W]** `SystemInfo.getInfo` + `SystemInfo.getProcessInfo` (full Chromium process tree with cpuTime + pid + processType); `Browser.getVersion`; `Browser.getHistograms` all-time; `Page.getNavigationHistory`.
- **[W]** `Performance.getMetrics` polled every 10s; `Memory.getDOMCounters` polled every 10s.
- **[W]** `Tracing.start` with `v8,blink,devtools.timeline,disabled-by-default-devtools.timeline,latencyInfo,toplevel` categories.
- **[W]** `Profiler.startPreciseCoverage` (currently `callCount:false, detailed:false`); `CSS.startRuleUsageTracking`.
- **[W]** `WebAudio.contextCreated/Destroyed/Changed`; `Animation.animationCreated/Started/Canceled/Updated`; `IndexedDB.databaseCreated/versionChange`; `Page.lifecycleEvent/javascriptDialogOpening/fileChooserOpened/windowOpen/navigatedWithinDocument`; `Browser.downloadWillBegin/downloadProgress`; `Runtime.consoleAPICalled/exceptionThrown`; `Log.entryAdded`; `Security.securityStateChanged/visibleSecurityStateChanged`; `Storage.indexedDBListUpdated/cacheStorageListUpdated/interestGroupAccessed/sharedStorageAccessed`.
- **[T]** Bump `DOMSnapshot.computedStyles` from 41 props to the full ~600-property CSS list.
- **[T]** Bump `Profiler.startPreciseCoverage` to `{callCount:true, detailed:true}` for per-function call counts + per-block coverage.
- **[T]** Drop the 1 MiB-per-event preview cap on `_instCdpFirehose`; stream raw payloads to `recordings/<label>/cdp_firehose.ndjson`.
- **[T]** `Network.getResponseBody` for every completed request — full body bytes to `recordings/<label>/bodies/<requestId>.bin`.
- **[T]** `Network.getRequestPostData` for every POST request.
- **[T]** `Network.getCookies` / `Storage.getCookies` / `Storage.getTrustTokens` / `Storage.getInterestGroups` / `Storage.getSharedStorageEntries` / `Storage.getRelatedWebsiteSets` final pulls.
- **[T]** `Page.captureScreenshot` at start, every 5s, and at close (PNG bytes to `recordings/<label>/screenshots/`).
- **[T]** `Page.captureSnapshot` (MHTML serialization per major page state).
- **[T]** `Accessibility.getFullAXTree` final dump.
- **[T]** `Browser.getBrowserCommandLine` (full Chromium argv).
- **[T]** `Debugger.scriptParsed` + `Debugger.getScriptSource` for every script loaded (deduped, saved to `recordings/<label>/scripts/`).
- **[T]** `CSS.getStyleSheetText` for every loaded sheet (saved under `recordings/<label>/css/`).
- **[T]** `Cache.requestEntries` per Cache Storage namespace; `IndexedDB.requestData` per objectStore.
- **[T]** `Audits.enable` + `Audits.issueAdded` capture (deprecation, intervention, mixed-content, contrast, forms-issues).
- **[T]** `LayerTree.compositingReasons` per layer.
- **[T]** `Schema.getDomains` self-report of the CDP version actually negotiated.

### D. Network layer (off-Chrome)

- **[W]** `tcpdump` pcap of session (`pcap_sidecar.ts`) — kept whole, no filter; `SSLKEYLOGFILE` writes alongside.
- **[W]** NetLog JSON (Chromium `--log-net-log`); HAR via Playwright.
- **[W]** Playwright `requests` array — method, URL, headers, body size, response status; CDP `Network.requestWillBeSentExtraInfo` + `responseReceivedExtraInfo` (raw wire-level headers including HTTP/2 pseudo-headers and cookie line as sent); `loadingFinished`/`loadingFailed`/`signedExchangeReceived`/`requestServedFromCache`/`webSocketHandshakeResponseReceived`/`webSocketWillSendHandshakeRequest`.
- **[T]** Post-run pcap decode: `tshark -2 -r traffic.pcap -o tls.keylog_file:sslkey.log -Y http2 -T json` → `recordings/<label>/http2_frames.json`.
- **[T]** JA4 / JA4S / JA4H / JA4L / JA4T / JA4TS computed from pcap.
- **[T]** JA3 / JA3S legacy hash.
- **[T]** Peetprint (HTTP/2 SETTINGS hash) + Akamai H2 fingerprint (frames + pseudo-header order).
- **[T]** Full TLS ClientHello + ServerHello byte dump (cipher suites, extensions, sig algs, supported_groups, key_share, ALPN, GREASE positions, ECH).
- **[T]** DNS sidecar — separate `tcpdump port 53` capture, every query name/type/response.
- **[T]** HTTP/3 / QUIC frame decode if used (Initial / Handshake / 1-RTT, frame types).

### E. Host / OS state

- **[W]** `ps -axo pid,ppid,user,command`, `ifconfig`, `netstat -rn`, `netstat -an -p tcp`, `top -l 1 -n 20`, `vm_stat`, `uptime`, `scutil --dns`, `pmset -g batt; pmset -g therm`, `sysctl -a | grep net.` (head 200), `launchctl list` (head 100), `arp -an`, `dscacheutil -cachedump`, `powermetrics -n 1 --samplers smc` (head 50), `lsof -p <node>` (head 100). All in `_instHostSnapshots`.
- **[W]** weles + trajectory version provenance (commit short sha + tree sha + dist sha256 + mtime). In `versions` field.
- **[W]** Sibling file manifest of `recordings/<label>/` — name/size/mtime for every artifact.
- **[T]** `process.env` snapshot with secret-class values sha256'd.
- **[T]** `process.argv` of the node process; `os.networkInterfaces()` MAC addresses; `os.cpus()` per-core model/speed/times.
- **[T]** Per-Chromium-child `ps -o command= -p <pid>` for every pid in `SystemInfo.getProcessInfo`.
- **[T]** `lsof -p <chromium_pid>` per Chromium process.
- **[T]** `vmmap <pid>` per Chromium process (memory regions).
- **[T]** `sample <pid>` micro-profile of node + Chromium main.
- **[T]** `fs_usage` 5-second snapshot of file syscalls.
- **[T]** `nettop -P -L 1 -l 1` per-process network counters.
- **[T]** `system_profiler SPHardwareDataType SPDisplaysDataType SPNetworkDataType SPUSBDataType SPBluetoothDataType SPAudioDataType SPCameraDataType SPPowerDataType SPSoftwareDataType SPMemoryDataType SPStorageDataType SPThunderboltDataType` full dump.
- **[T]** `sysctl -a` full tree (not the grep-net subset).
- **[T]** `nvram -p` firmware variables; `csrutil status`, `spctl --status`, `bputil -d`, `nvram boot-args`.
- **[T]** `kextstat` loaded kernel extensions.
- **[T]** `ioreg -l` IORegistry with hardware UUIDs/serials sha256'd.
- **[T]** `defaults read NSGlobalDomain` global user defaults.
- **[T]** PATH binary enumeration — every executable in every `$PATH` dir, with name/size/mode (data only, no execution).
- **[T]** Installed app list — `ls /Applications` + `mdfind 'kMDItemKind == Application'`.
- **[T]** `dscl . list /Users` local user accounts (count + sha256).
- **[T]** TZ + clock sync — `date +%z %Z`, `systemsetup -gettimezone`, `systemsetup -getusingnetworktime`, `sntp -d time.apple.com`.
- **[T]** `airport -I` current WiFi (SSID/BSSID/RSSI/channel) with SSID/BSSID sha256'd.
- **[T]** `who` / `w` / `last | head -20`; `df -h` / `mount` / `diskutil list`.
- **[T]** Keychain entry count via `security dump-keychain | wc -l`.
- **[T]** Every Launch Agent / Launch Daemon plist content.
- **[T]** Homebrew install list `brew list --versions`.

### F. Browser / weles internals

- **[W]** Persona blob (UA, brands, platform, OS, GPU, CPU count, memory, screen, locale, TZ) and proxy config (provider, pool, port, exit IP, AS, geo, cidr-burn status).
- **[T]** Chromium command line via `Browser.getBrowserCommandLine` with `--enable-features` / `--disable-features` lists fully exploded.
- **[T]** weles patch set applied to Chromium — list of patch file paths + sha256 + header line each.
- **[T]** Init scripts source — sha256 + full text of every `addInitScript` injected (property_trap.js, fingerprint_hooks.js, input_recorder.js, MODERN_API_HOOKS_SCRIPT, SURFACE_INVENTORY_SCRIPT, WEBAUTHN_REJECT_SCRIPT, ARKOSE_OBSERVER_SCRIPT).
- **[T]** Every automation env var influencing run (`PLAYWRIGHT_*`, `WELES_*`, `CHROME_*`, `CHROMIUM_*`, `PUPPETEER_*`).
- **[T]** Playwright / node / V8 / libuv / openssl versions (partly in `process.versions`).

### G. Trajectory-level state

- **[W]** Per-action timestamp + start/end URL + screenshot frame sha8 (from inspect_trajectory hook).
- **[W]** humanClick / humanType / humanScroll / humanIdlePause atoms log via `input_recorder.js` (coords, character timings, scroll deltas, pause durations + reason).

### H. Visual layer

- **[W]** Webm session recording (Playwright record_video_dir).
- **[T]** Per-action MHTML snapshot via `Page.captureSnapshot`.
- **[T]** Per-second `Page.captureScreenshot` to `recordings/<label>/screenshots/`.
- **[T]** Frame-by-frame perceptual hash (pHash) sidecar of the webm.

### I. Worker contexts

- **[W]** `Target.setAutoAttach` flatten across every worker session; per-worker Runtime.evaluate inventory of `self.*` + `self.navigator.*`; per-worker `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFailed` subscription.
- **[T]** Per-worker `Debugger.getScriptSource` of the worker's own JS.
- **[T]** Per-worker `WebAssembly.compile/instantiate` log (currently only the document context).

### J. Provenance / dedup

- **[W]** Session label + started_at + closed_at; uploaded to Supabase Storage via `uploadArtifacts.ts`.
- **[T]** SHA256 of the merged inst.json itself written to a sidecar `.sha256` for re-upload dedup.
- **[T]** Wall-clock start/end + monotonic perf delta + chromium boot time.
