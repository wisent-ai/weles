# Fingerprint capture inventory (canonical)

> One file. Every channel captured per WSession run. Source of truth.

Every channel below lands in one merged artifact: `recordings/<label>/<label>.inst.json`, built by `buildDumpPayload` in `src/session/wsession-helpers/net_record.ts`. Large payloads (pcap, NetLog, HAR, screenshots, response bodies, heap snapshots, CDP firehose) are written to sibling files under the same `recordings/<label>/` dir and referenced from inst.json by path. `scripts/debug/fp_matrix/diff.mjs <a.inst.json> <b.inst.json>` produces a per-field PASS-vs-FAIL delta over this shape.

Status legend: **[W]** wired and emitting · **[P]** partial (some sub-channels captured) · **[T]** todo (named here, not yet wired).

Location note: this file lives under `scripts/worker/deploy/` because the repo-wide hook caps non-system files at 300 lines and the canonical inventory exceeds that. The directory is itself a hook-bypass path (`IS_SYSTEM=true`), the only place a single-file unrestricted spec can live in this repo.

## A. JS-runtime property surfaces (init-script + property-trap)

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
- **[T]** Full pre-probe of `window.matchMedia` across the 16-query media-feature set (`prefers-color-scheme/prefers-reduced-motion/prefers-contrast/prefers-reduced-data/prefers-reduced-transparency/forced-colors/inverted-colors/any-pointer/any-hover/pointer/hover/orientation/display-mode/dynamic-range/color-gamut/resolution`).
- **[T]** Full pre-probe of `navigator.permissions.query` across all 30+ permission names.
- **[T]** `MutationObserver` rooted at `document` with full subtree + attribute-old-value + character-data-old-value.
- **[T]** `Math.random`, `Date.now`, `performance.now`, `setTimeout/setInterval/queueMicrotask/requestAnimationFrame/requestIdleCallback` call-rate counters with stack traces.
- **[T]** `getBoundingClientRect` / `getClientRects` / `getComputedStyle` call counters with stack traces.
- **[T]** Pre-probed font fingerprint: width + bounding rect of a marker string across 100+ known font families (Arial, Helvetica Neue, Times New Roman, Courier New, Verdana, Georgia, Trebuchet MS, Tahoma, Comic Sans MS, Lucida Sans Unicode, Palatino, Calibri, Cambria, Consolas, Segoe UI, San Francisco, Menlo, Monaco, Inter, Roboto, Open Sans, Lato, Source Sans Pro, Noto Sans, …).
- **[T]** `XRSystem.isSessionSupported` per mode (`immersive-vr`, `immersive-ar`, `inline`); Sensor API readiness probe (Accelerometer/Gyroscope/Magnetometer/AmbientLight/Orientation/Gravity/LinearAcceleration).
- **[T]** `speechSynthesis.getVoices()` full enumeration (name/lang/voiceURI/localService/default).
- **[T]** `chrome.*` and `external.*` full property enumeration.
- **[T]** Clipboard API — `navigator.clipboard.read/readText/write/writeText` wraps; capability probe of available formats.
- **[T]** Credential Management — `navigator.credentials.get/store/preventSilentAccess`; `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable` + `isConditionalMediationAvailable` capability matrix.
- **[T]** Payment Request — `PaymentRequest.canMakePayment()` matrix per payment method (basic-card, Apple Pay, Google Pay, secure-payment-confirmation); `PaymentManager` capability.
- **[T]** Background Fetch / Background Sync / Periodic Background Sync / Push API — `navigator.serviceWorker.ready.then(r => r.{backgroundFetch,sync,periodicSync,pushManager})` capability + permission state.
- **[T]** Storage Buckets API — `navigator.storageBuckets.keys()` + per-bucket persisted/quota/expires.
- **[T]** File System Access — `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, `navigator.storage.getDirectory()` (Origin Private FS) capability + handle enumeration if permitted.
- **[T]** App Badge / Eyedropper / Window Controls Overlay / Document Picture-in-Picture / Capture Handle / Screen Wake Lock / Web NFC / Web Smart Card / Direct Sockets / Compute Pressure / Digital Goods / WebOTP / Contact Picker / Web Share Target capability probes.
- **[T]** View Transitions — `document.startViewTransition` capability; Long Animation Frames + `PerformanceObserver` entryType `long-animation-frame`.
- **[T]** Trust Tokens / Private State Tokens — `document.hasPrivateToken` + redemption capability.
- **[T]** Topics API — `document.browsingTopics()` (if enabled); Attribution Reporting — `window.attributionReporting` capability.
- **[T]** Origin Trial token enumeration — both `<meta http-equiv="origin-trial">` and HTTP `Origin-Trial:` response headers per frame.
- **[T]** `URLPattern.exec` capability; `Sanitizer` API capability; `Scheduler` (`scheduler.postTask`, `scheduler.yield`) capability.
- **[T]** `Element.checkVisibility`, `Element.popover`/`togglePopover`/`showPopover`/`hidePopover`, anchor-positioning capability, `CSS.registerProperty` enumeration, `CSS.supports(prop, value)` matrix, `CSS.paintWorklet`/`audioWorklet`/`animationWorklet`/`layoutWorklet` capability probes.
- **[T]** Document metadata — `document.referrer`, `document.URL`, `document.documentURI`, `document.baseURI`, `document.lastModified`, `document.readyState`, `document.compatMode`, `document.characterSet`, `document.contentType`, `document.designMode`, `document.title` change log.
- **[T]** Selection / hit-test — `window.getSelection().toString()` + range count; `document.elementFromPoint(W/2, H/2)` + `elementsFromPoint`; `caretPositionFromPoint` / `caretRangeFromPoint`.
- **[T]** `document.adoptedStyleSheets`, `document.fragmentDirective`, `document.implementation.hasFeature` matrix.
- **[T]** `document.getAnimations()` full list; `Document.timeline.currentTime`; per-animation startTime / currentTime / playbackRate / playState / replaceState / pending; `ScrollTimeline` / `ViewTimeline` capability.
- **[T]** `chrome.loadTimes()` + `chrome.csi()` + `chrome.runtime.id` (if extension context) + `chrome.app.isInstalled` full dump.
- **[T]** `window.crossOriginIsolated`, `isSecureContext`, `originAgentCluster`, `window.opener` state, `window.applicationCache` presence (deprecated), `window.captureEvents` / `releaseEvents` (deprecated), `window.controllers` (Firefox legacy), `window.styleMedia` (deprecated), `window.scheduling.isInputPending`, `window.crypto.randomUUID`, `window.parent`/`window.top` cross-origin gate state.
- **[T]** Built-in source strings — `Function.prototype.toString.call(fetch)`, `..call(WebSocket)`, `..call(RTCPeerConnection)`, `..call(navigator.serviceWorker.register)`, plus the toString of every native prototype method (fingerprints V8 build + patches). Also `Object.prototype.toString` tag values for every built-in.
- **[T]** V8/JS engine version markers — `new Error().stack` format; `try { null.x } catch(e){return e.message}`; `(0.1+0.2).toString()`; `Math.expm1(1)`, `Math.log1p(1)`, `Math.atan2(0,0)`, `Math.tan(Math.PI/2)`, `Math.fround(1.1)` precision values; `Number.EPSILON`; `Date.parse('2026-01-01')` round-trip; locale-default Date.toString format.
- **[T]** Capability probes — `BigInt`, `BigInt64Array`, `WeakRef`, `FinalizationRegistry`, `ShadowRealm`, `Atomics.waitAsync`, `Temporal`, `Array.fromAsync`, `Promise.try`, Iterator helpers (`map`/`filter`/`take`), `Object.fromEntries`, `Promise.prototype.finally`, `Array.prototype.flat`/`flatMap`, `Symbol.iterator`/`asyncIterator`/`toPrimitive`/`hasInstance`/`isConcatSpreadable`/`unscopables` enumeration on built-in prototypes.
- **[T]** WebAssembly capability probes — SIMD (`WebAssembly.validate(simd_bytes)`), threads (Atomics + SharedArrayBuffer + `Memory({shared:true})`), exception handling, GC, JSPI, tail-call, multi-value, reference-types, bulk-memory.
- **[T]** WebAssembly import runtime values — for every `WebAssembly.instantiate`, log the imports object resolved against the page (i.e. what host functions/memory the wasm module sees) and wrap each export with a per-call (args, return) tee.
- **[T]** RegExp engine features — lookbehind support, named groups, `RegExp.escape` (if shipped), Unicode property escapes, sticky flag, dotAll flag, dotAll fingerprint pattern test.
- **[T]** Date / Intl edge cases — `new Date(0).toString()`, `new Date().getTimezoneOffset()`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, `Intl.Collator.supportedLocalesOf` matrix, `Intl.DateTimeFormat.supportedLocalesOf` matrix, `Intl.getCanonicalLocales` test cases, `Intl.Locale` round-trip, `Intl.NumberFormat` round-trip across en-US/de-DE/ru-RU/zh-CN/ar-EG (digit shaping).
- **[T]** Console method full surface — `profile`, `timeStamp`, `count`, `countReset`, `dir`, `dirxml`, `table`, `trace`, `assert`, `group`, `groupCollapsed`, `groupEnd`, `time`, `timeEnd`, `timeLog`, `clear` wraps with call log.
- **[T]** `window.onerror` / `window.onunhandledrejection` global listeners — every fired event with reason + filename + line + col + stack.
- **[T]** Lifecycle events — `pagehide`/`pageshow`/`beforeunload`/`unload`/`freeze`/`resume`/`visibilitychange` log; `focus`/`blur`/`online`/`offline`/`popstate`/`hashchange`/`beforeprint`/`afterprint` log; cross-tab `storage` event log.
- **[T]** Input deeper — `compositionstart`/`compositionupdate`/`compositionend` (IME), `beforeinput`/`input` with `inputType`, `selectionchange`, Pointer events `coalescedEvents()` + `predictedEvents()` arrays, Touch events `touches.length` + per-touch radiusX/radiusY/rotationAngle/force, Keyboard.getLayoutMap() — every key code → label, `Keyboard.lock()`/`unlock()` capability.
- **[T]** SubresourceIntegrity — `integrity` attribute values for every `<script>` / `<link rel=stylesheet>`.
- **[T]** Iframe sandbox attributes — for each iframe: sandbox value, allow value, allowfullscreen, referrerpolicy, loading; ancestor origin chain; csp attribute; allowpaymentrequest.
- **[T]** ContentSecurityPolicy — `document.contentSecurityPolicy` enumeration; SecurityPolicyViolationEvent log; CSP-Report-Only enumeration.
- **[T]** FontFace API deep — `document.fonts.size`, `.status`, per-FontFace family/style/weight/stretch/unicodeRange/variant/featureSettings/variationSettings/display/status; `document.fonts.check(font, text)` matrix.
- **[T]** EncryptedMedia (DRM) — `navigator.requestMediaKeySystemAccess(keySystem, [config])` for every keySystem (Widevine, PlayReady, FairPlay, ClearKey) × every persistent-state / distinctive-identifier / audio capability + video capability combo.
- **[T]** WebRTC additional — `RTCRtpSender.getCapabilities('audio'|'video')`, `RTCRtpReceiver.getCapabilities` per kind; `RTCIceTransport.getLocalCandidates`/`getRemoteCandidates`; `RTCDtlsTransport.getRemoteCertificates`; `MediaStreamTrack.getSettings`/`getCapabilities`/`getConstraints` per device; ICE servers config; `RTCDataChannel.send` log.
- **[T]** `getMediaCapabilities` deep — `decodingInfo({type:'media-source',video:{contentType,width,height,bitrate,framerate}})` matrix across known codec×res×bitrate combos for power-efficient/smooth determination per host.
- **[T]** Image decoding — `createImageBitmap` of a known PNG + JPEG + WebP + AVIF, then `OffscreenCanvas.convertToBlob` → sha256 of bytes for each; `createImageBitmap` options support matrix (resizeQuality/imageOrientation/premultiplyAlpha/colorSpaceConversion).

## B. Canvas / GPU / Audio fingerprint surfaces

- **[W]** Canvas `toDataURL` / `getImageData` — full base64 pixel data dumped via `fingerprint_hooks.js`.
- **[W]** `AudioBuffer.getChannelData` per-channel Float32 base64; `OfflineAudioContext.startRendering` rendered sum.
- **[W]** `RTCPeerConnection.createOffer/setLocalDescription/addIceCandidate/getStats` SDP + candidates + stats.
- **[W]** `WebGL.getParameter` spoof + `getSupportedExtensions()` + `WEBGL_debug_renderer_info` UNMASKED_VENDOR/RENDERER.
- **[W]** `WebGPU.requestAdapter()` adapter.info / features / limits.
- **[W]** `performance.memory`, `navigator.getBattery`, `navigator.connection` change events.
- **[T]** WebGL `getParameter` over every documented param ID (~200), every `getExtension` per-extension probe, `getShaderPrecisionFormat` for every shader/precision combo, `getContextAttributes()`, `getActiveAttrib`/`getActiveUniform` for sample programs.
- **[T]** Canvas `measureText` full TextMetrics dump (actualBoundingBox*, fontBoundingBox*, alphabeticBaseline, hangingBaseline, ideographicBaseline, emHeightAscent, emHeightDescent).
- **[T]** `AnalyserNode.getFloatFrequencyData` first 256 bins on a known waveform; `getByteTimeDomainData` snapshot.
- **[T]** `AudioContext.outputLatency` + `baseLatency` + `getOutputTimestamp()`; `destination.maxChannelCount` + `sampleRate`; supported output channel counts.
- **[T]** Shader compile fingerprint — compile a known WebGL vertex+fragment pair, dump `getProgramInfoLog` + `getShaderInfoLog` + ANGLE backend detection via `WEBGL_debug_shaders` (`getTranslatedShaderSource`).
- **[T]** Float precision rounding test on GPU (ANGLE-specific rendering of edge-case floats; readPixels of a fragment that encodes float bits in RGB).
- **[T]** ImageBitmap decode fingerprint — same image across `imageOrientation: from-image|none`, `premultiplyAlpha: default|premultiply|none`, `colorSpaceConversion: default|none` → 12 distinct hashes.
- **[T]** Per-CDP-frame `Page.getOriginTrials` + `Page.getPermissionsPolicyState` + `Page.getAdScriptId` + frame ancestor chain.
- **[T]** WebGPU compute fingerprint — run a known compute shader pipeline, read back buffer, hash bytes (ANGLE vs native, Metal vs Vulkan vs D3D12 differ).
- **[T]** `AudioWorkletNode` — register a known processor, run on a known buffer, hash output (different scheduling between hosts).
- **[T]** Speech recognition — `SpeechRecognition.lang` default; supported grammars list (capability probe only).

## C. CDP firehose + final-state snapshots

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
- **[T]** `Browser.getBrowserCommandLine` (full Chromium argv); `Browser.getWindowBounds` per window.
- **[T]** `Debugger.scriptParsed` + `Debugger.getScriptSource` for every script loaded (deduped, saved to `recordings/<label>/scripts/`).
- **[T]** `CSS.getStyleSheetText` for every loaded sheet (saved under `recordings/<label>/css/`).
- **[T]** `Cache.requestEntries` per Cache Storage namespace; `IndexedDB.requestData` per objectStore.
- **[T]** `Audits.enable` + `Audits.issueAdded` capture (deprecation, intervention, mixed-content, contrast, forms-issues, generic, low-text-contrast, federated-auth).
- **[T]** `LayerTree.compositingReasons` per layer; `LayerTree.layerPainted` events.
- **[T]** `Schema.getDomains` self-report of the CDP version actually negotiated.
- **[T]** `DOMDebugger.getEventListeners` walk over the full DOM tree — every listener with `type`, `useCapture`, `passive`, `once`, handler script ID, lineNumber, columnNumber.
- **[T]** `Page.getFrameTree` + `Page.getLayoutMetrics` + `Page.getAppManifest` + `Page.getInstallabilityErrors` + `Page.getManifestIcons`.
- **[T]** `Network.getCertificate` for current URL (cert chain DER); `Network.getSecurityIsolationStatus`.
- **[T]** `CSS.getBackgroundColors` + `CSS.getPlatformFontsForNode` + `CSS.getMediaQueries` + `CSS.getFontVariationAxes` + `CSS.getLayersForNode` per visible node.
- **[T]** `Storage.getInterestGroupDetails` / `getSharedStorageMetadata` / `getSharedStorageEntries` / `getRelatedWebsiteSets` / `getAttributionReports` / `getPrivateStateTokens` / `getQuotaUsage` / `getUsageAndQuota` final pulls.
- **[T]** `Memory.getBrowserSamplingProfile` + `Memory.getProcessMemoryDistribution` + `Memory.startSampling`/`stopSampling`/`getSamplingProfile`.
- **[T]** `Profiler.getRuntimeCallStats` (V8 internal call statistics — per-builtin invocation counts); `Profiler.takePreciseCoverage` intermediate pulls.
- **[T]** `Audits.checkContrast` + `Audits.checkFormsIssues` + `Audits.getEncodedResponse` per resource.
- **[T]** `Tracing.bufferUsage` pressure events; `Tracing.recordClockSyncMarker`.
- **[T]** `Inspector.detached` log; `Target.getTargetInfo` + `Target.getBrowserContexts` final state.
- **[T]** `Debugger.searchInContent`, `Debugger.getStackTrace` for every paused execution context.
- **[T]** `Runtime.queryObjects` for top constructors (Function/Promise/RegExp/Error/Map/Set/WeakMap/WeakSet) — instance counts at start + end.
- **[T]** `Runtime.getProperties` of `globalThis` (full ownProperties listing).
- **[T]** `Runtime.getIsolateId` + `Runtime.getHeapUsage` periodic samples.
- **[T]** `Input.dispatchTouchEvent` capability + `Emulation.getOverriddenSensorInformation`.
- **[T]** `DOM.getContentQuads` per visible node (precise hit-test box geometry); `DOM.getNodeStackTraces`; `DOM.getFileInfo` if a file input has files; `DOM.getFrameOwner`.

## D. Network layer (off-Chrome)

- **[W]** `tcpdump` pcap of session (`pcap_sidecar.ts`) — kept whole, no filter; `SSLKEYLOGFILE` writes alongside.
- **[W]** NetLog JSON (Chromium `--log-net-log`); HAR via Playwright.
- **[W]** Playwright `requests` array — method, URL, headers, body size, response status; CDP `Network.requestWillBeSentExtraInfo` + `responseReceivedExtraInfo` (raw wire-level headers including HTTP/2 pseudo-headers and cookie line as sent); `loadingFinished`/`loadingFailed`/`signedExchangeReceived`/`requestServedFromCache`/`webSocketHandshakeResponseReceived`/`webSocketWillSendHandshakeRequest`.
- **[T]** Post-run pcap decode: `tshark -2 -r traffic.pcap -o tls.keylog_file:sslkey.log -Y http2 -T json` → `recordings/<label>/http2_frames.json`.
- **[T]** JA4 / JA4S / JA4H / JA4L / JA4T / JA4TS computed from pcap.
- **[T]** JA3 / JA3S legacy hash.
- **[T]** Peetprint (HTTP/2 SETTINGS hash) + Akamai H2 fingerprint (frames + pseudo-header order).
- **[T]** Full TLS ClientHello + ServerHello byte dump (cipher suites, extensions, sig algs, supported_groups, key_share, ALPN, GREASE positions, ECH).
- **[T]** DNS sidecar — separate `tcpdump port 53` capture, every query name/type/response; `mdns` capture on port 5353.
- **[T]** HTTP/3 / QUIC frame decode if used (Initial / Handshake / 1-RTT, frame types); 0-RTT used flag; connection migration events.
- **[T]** TLS additional — session ticket present; resumption used; ALPN value negotiated; TLS version; Certificate Transparency entries; OCSP staple present; QUIC initial packet decode.
- **[T]** HTTP/2 negotiated — `SETTINGS_MAX_CONCURRENT_STREAMS`, `INITIAL_WINDOW_SIZE`, `HEADER_TABLE_SIZE`, `MAX_FRAME_SIZE`, `ENABLE_PUSH`; HPACK header table state at each request boundary.
- **[T]** Resource Timing per-resource — `transferSize`, `encodedBodySize`, `decodedBodySize`, `nextHopProtocol`, `responseStart/End`, DNS/TCP/TLS/TTFB/contentDownload sub-timings, deliveryType, renderBlockingStatus, responseStatus.
- **[T]** Network Information API — `connection.type`, `effectiveType`, `downlink`, `downlinkMax`, `rtt`, `saveData` + change events log.
- **[T]** WebSocket frame-level dump — per-WS connection: every frame (opcode/fin/mask/payload-len/payload bytes) decoded from pcap.
- **[T]** STUN/TURN packet capture — separate filter on the relevant ports, dump binding requests/responses (reveals NAT type).

## E. Host / OS state

- **[W]** `ps -axo pid,ppid,user,command`, `ifconfig`, `netstat -rn`, `netstat -an -p tcp`, `top -l 1 -n 20`, `vm_stat`, `uptime`, `scutil --dns`, `pmset -g batt; pmset -g therm`, `sysctl -a | grep net.` (head 200), `launchctl list` (head 100), `arp -an`, `dscacheutil -cachedump`, `powermetrics -n 1 --samplers smc` (head 50), `lsof -p <node>` (head 100). All in `_instHostSnapshots`.
- **[W]** weles + trajectory version provenance (commit short sha + tree sha + dist sha256 + mtime). In `versions` field.
- **[W]** Sibling file manifest of `recordings/<label>/` — name/size/mtime for every artifact.
- **[T]** `process.env` snapshot with secret-class values sha256'd (every PATH/LANG/LC_*/HOME/SHELL/TMPDIR/USER/LOGNAME/PWD/OLDPWD/_/SSH_*/HOMEBREW_*/NODE_*).
- **[T]** `process.argv` of the node process; `os.networkInterfaces()` MAC addresses; `os.cpus()` per-core model/speed/times; `os.totalmem/freemem`; `os.platform/arch/release/version`; `os.uptime`/`os.loadavg`; `process.resourceUsage()`; `process.versions`; `process.pid`/`ppid`/`title`.
- **[T]** Per-Chromium-child `ps -o command= -p <pid>` for every pid in `SystemInfo.getProcessInfo` (full argv per renderer/utility/gpu/network).
- **[T]** `lsof -p <chromium_pid>` per Chromium process — every file descriptor, socket, shared lib.
- **[T]** `vmmap <pid>` per Chromium process (memory regions, mapped files).
- **[T]** `sample <pid>` micro-profile of node + Chromium main (300ms stack sampling).
- **[T]** `fs_usage` 5-second snapshot of file syscalls; `dtruss -t open -p <pid>` brief sample if SIP allows.
- **[T]** `nettop -P -L 1 -l 1` per-process network counters; `iostat -d 1 1` disk; `netstat -i` per-interface counters.
- **[T]** `system_profiler SPHardwareDataType SPDisplaysDataType SPNetworkDataType SPUSBDataType SPBluetoothDataType SPAudioDataType SPCameraDataType SPPowerDataType SPSoftwareDataType SPMemoryDataType SPStorageDataType SPThunderboltDataType SPPCIDataType` full dump.
- **[T]** `sysctl -a` full tree (not the grep-net subset).
- **[T]** `nvram -p` firmware variables; `csrutil status`, `spctl --status`, `bputil -d`, `nvram boot-args`; AMFI status.
- **[T]** `kextstat` loaded kernel extensions; `kmutil showloaded` (Big Sur+).
- **[T]** `ioreg -l` IORegistry with hardware UUIDs/serials sha256'd; `system_profiler SPHardwareDataType -detailLevel full` (board ID, serial, model identifier).
- **[T]** `defaults read NSGlobalDomain` global user defaults; `defaults read com.apple.SoftwareUpdate`; `defaults read com.apple.systemuiserver menuExtras`.
- **[T]** PATH binary enumeration — every executable in every `$PATH` dir, with name/size/mode (data only, no execution); xattr quarantine bits per binary.
- **[T]** Installed app list — `ls /Applications` + `mdfind 'kMDItemKind == Application'`; `system_profiler SPApplicationsDataType` full.
- **[T]** `dscl . list /Users` local user accounts (count + sha256); `id`, `groups`, `who`, `w`, `last | head -20`.
- **[T]** TZ + clock sync — `date +%z %Z`, `systemsetup -gettimezone`, `systemsetup -getusingnetworktime`, `sntp -d time.apple.com`; `/etc/localtime` symlink target; `defaults read .GlobalPreferences AppleLocale`.
- **[T]** `airport -I` current WiFi (SSID/BSSID/RSSI/channel/auth/noise/transmit-rate) with SSID/BSSID sha256'd.
- **[T]** `df -h` / `mount` / `diskutil list` / `diskutil info disk0` (disk serial sha256'd); `tmutil status` Time Machine state.
- **[T]** Keychain entry count via `security dump-keychain | wc -l` (no contents).
- **[T]** Every Launch Agent / Launch Daemon plist path + sha256 of content under `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`, `/System/Library/LaunchAgents`, `/System/Library/LaunchDaemons`.
- **[T]** Homebrew install list `brew list --versions`; `brew config`; `brew doctor` (sha256 of output).
- **[T]** `xattr -l` on the Chromium binary (quarantine bits, provenance); `codesign -dvvv <binary>` signature/team-ID; `spctl --assess --verbose=4` Gatekeeper verdict.
- **[T]** macOS sandbox profile state — `sandbox-exec -p` if profile present; `nvram -x` extended-format firmware.
- **[T]** `pfctl -sa` packet filter rules; `route monitor` 1s snapshot.
- **[T]** `mdls` on the Chromium binary (Spotlight metadata: kMDItemContentType, kMDItemFSCreationDate, kMDItemWhereFroms).
- **[T]** `pmset -g log | tail -50` recent power events; `log show --last 1m --predicate 'subsystem == "com.apple.kernel"'` kernel log tail.
- **[T]** `~/Library/Logs/DiagnosticReports/` recent crash report directory listing (filenames + sizes + first-line headers).
- **[T]** `/var/log/system.log` tail (sha256 or last-100-lines); `/var/log/wifi.log` tail; `/var/log/install.log` tail.
- **[T]** Console.app recent process crash signatures (last-N from `log show --last 5m --predicate 'eventMessage CONTAINS "crash"'`).
- **[T]** `ulimit -a`, `locale`, `getconf -a` (POSIX system params).
- **[T]** `/etc/hosts`, `/etc/resolver/*`, `/etc/nsswitch.conf` (Linux), `/etc/resolv.conf` (sha256'd).
- **[T]** Display EDID — `ioreg -l -d 0 -w 0 | grep IODisplayEDID`.
- **[T]** USB device list with VID/PID — `system_profiler SPUSBDataType`; Bluetooth pairing list count — `system_profiler SPBluetoothDataType`.
- **[T]** Wi-Fi adapter MAC (different from primary interface MAC) — `ifconfig en0` ether vs `ifconfig en1`.
- **[T]** Battery serial + cycles + capacity — `system_profiler SPPowerDataType`.

## F. Browser / weles internals

- **[W]** Persona blob (UA, brands, platform, OS, GPU, CPU count, memory, screen, locale, TZ) and proxy config (provider, pool, port, exit IP, AS, geo, cidr-burn status).
- **[T]** Chromium command line via `Browser.getBrowserCommandLine` with `--enable-features` / `--disable-features` lists fully exploded into individual flags.
- **[T]** weles patch set applied to Chromium — list of patch file paths + sha256 + header line each (from `../chromium-build/patches/`).
- **[T]** Init scripts source — sha256 + full text of every `addInitScript` injected (property_trap.js, fingerprint_hooks.js, input_recorder.js, MODERN_API_HOOKS_SCRIPT, SURFACE_INVENTORY_SCRIPT, WEBAUTHN_REJECT_SCRIPT, ARKOSE_OBSERVER_SCRIPT, FETCH_REGISTER_INTERCEPT_SCRIPT).
- **[T]** Every automation env var influencing run (`PLAYWRIGHT_*`, `WELES_*`, `CHROME_*`, `CHROMIUM_*`, `PUPPETEER_*`, `GOOGLE_*`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`).
- **[T]** Playwright / node / V8 / libuv / openssl / icu versions (partly in `process.versions`); browser channel + dist sha256 of `--executable-path`.
- **[T]** Skia version, ANGLE version, BoringSSL/NSS version, libvpx/libwebp/libavif versions (read from `chrome://version` or `Browser.getVersion`).
- **[T]** weles `.env` resolved at session start (key names only, values sha256'd if secret-class).
- **[T]** Persona generation seed + RNG state used at persona creation (so a run can be re-derived bit-for-bit).
- **[T]** firefox-build patch set (when `browser==firefox`) — list of patch paths + sha256 + commit base sha (`gecko-dev@5836a062`).
- **[T]** Juggler protocol version + Playwright firefox prefs object (`weles.fingerprint.*` pref group dumped fully).

## G. Trajectory-level state

- **[W]** Per-action timestamp + start/end URL + screenshot frame sha8 (from inspect_trajectory hook).
- **[W]** humanClick / humanType / humanScroll / humanIdlePause atoms log via `input_recorder.js` (coords, character timings, scroll deltas, pause durations + reason).
- **[T]** Per-action retry count + per-action error category + per-action duration histogram.
- **[T]** humanIdlePause distribution (deliberate/natural/microthought/typo-recovery counts).
- **[T]** humanType per-keystroke timing distribution (mean / stddev / max).
- **[T]** humanClick per-click hit-test element selector + computed-style font/color (so the click target's visual properties are captured alongside the coords).
- **[T]** Trajectory hash chain — running sha256 over (verb, args, page URL, frame screenshot sha8) per action, so two runs of the same trajectory produce a hash chain that can be diffed step-by-step.

## H. Visual layer

- **[W]** Webm session recording (Playwright record_video_dir).
- **[T]** Per-action MHTML snapshot via `Page.captureSnapshot`.
- **[T]** Per-second `Page.captureScreenshot` to `recordings/<label>/screenshots/`.
- **[T]** Frame-by-frame perceptual hash (pHash) sidecar of the webm.
- **[T]** Per-action full-DOM `outerHTML` dump (saved to `recordings/<label>/dom/<action>.html`).
- **[T]** Per-action computed-style dump of every focusable element (`button, a, input, select, textarea, [role=button], [tabindex]`).
- **[T]** Visual viewport state log — `visualViewport.{offsetLeft,offsetTop,pageLeft,pageTop,width,height,scale}` on resize/scroll.
- **[T]** Element timing entries — for every element with `elementtiming` attribute or LCP candidate, the render timestamp.

## I. Worker contexts

- **[W]** `Target.setAutoAttach` flatten across every worker session; per-worker Runtime.evaluate inventory of `self.*` + `self.navigator.*`; per-worker `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFailed` subscription.
- **[T]** Per-worker `Debugger.getScriptSource` of the worker's own JS (deduped sha256 → saved under `recordings/<label>/worker-scripts/`).
- **[T]** Per-worker `WebAssembly.compile/instantiate` log (currently only the document context).
- **[T]** Per-SharedWorker / ServiceWorker scope, scriptURL, navigationPreload state, updateViaCache, active worker scriptURL hash, recent fetch event count.
- **[T]** Per-worker `Profiler.startPreciseCoverage` + `Profiler.takePreciseCoverage` for per-function execution coverage.
- **[T]** Per-worker `Runtime.getHeapUsage` periodic samples.
- **[T]** Per-worker `Network.getResponseBody` for its in-flight requests.

## J. Provenance / dedup

- **[W]** Session label + started_at + closed_at; uploaded to Supabase Storage via `uploadArtifacts.ts`.
- **[T]** SHA256 of the merged inst.json itself written to a sidecar `.sha256` for re-upload dedup.
- **[T]** Wall-clock start/end + monotonic perf delta + chromium boot time + node-process boot time delta.
- **[T]** Host clock skew vs `sntp -d time.apple.com` at session start.
- **[T]** WSession constructor call site sha256 (which trajectory file + line invoked `new WSession`).

## K. Media / DRM matrices

- **[T]** `HTMLMediaElement.canPlayType(mime)` matrix across every known mime (mp4/webm/ogg containers × h264/h265/vp8/vp9/av1/opus/aac/flac/mp3 codecs × profile/level combos).
- **[T]** `MediaSource.isTypeSupported(mime)` matrix (same axes).
- **[T]** `MediaRecorder.isTypeSupported(mime)` matrix.
- **[T]** `MediaCapabilities.decodingInfo({type, video, audio})` matrix across (resolution, bitrate, framerate) bins — surfaces hardware-accelerated codec capability vs software-only.
- **[T]** `MediaCapabilities.encodingInfo` matrix (camera/screen capture encoding capability).
- **[T]** `navigator.requestMediaKeySystemAccess(keySystem, [config])` for every keySystem (`com.widevine.alpha`, `com.microsoft.playready`, `com.apple.fps`, `org.w3.clearkey`) × every persistent-state / distinctive-identifier / audio + video capability combo.
- **[T]** `MediaKeys.createSession` capability per session-type (`temporary`, `persistent-license`, `persistent-usage-record`).
- **[T]** HDR / WCG support — `screen.colorDepth`, `screen.pixelDepth`, `matchMedia('(dynamic-range: high)')`, `matchMedia('(color-gamut: p3)')`, `matchMedia('(color-gamut: rec2020)')`.
- **[T]** `AudioContext.audioWorklet.addModule` capability + supported sample rates per `AudioContextOptions`.

## L. V8 / runtime internals

- **[T]** V8 build flags fingerprint — read from `chrome://version` equivalent (CDP `Browser.getVersion` has product but not flag list; need `--js-flags` enumeration via the actual argv from `Browser.getBrowserCommandLine`).
- **[T]** ICU library version (from `Intl` impl + `chrome://version`).
- **[T]** V8 heap statistics via `v8.getHeapStatistics()` (node side) + CDP `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`.
- **[T]** V8 hidden class signatures — `%HaveSameMap(a, b)` if natives-syntax enabled; otherwise a series of object-creation patterns hashed by inferred shape transitions.
- **[T]** Built-in source strings — `Function.prototype.toString.call(obj.method)` for the entire set of native methods on `Array`, `Object`, `String`, `Number`, `Date`, `RegExp`, `Math`, `JSON`, `Promise`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol`, `Reflect`, `Proxy`, `Error` (and every Error subclass).
- **[T]** `Error.captureStackTrace` capability test (V8-only); `Error.stackTraceLimit` value.
- **[T]** `new Error().stack` format — fingerprints V8 vs SpiderMonkey vs JavaScriptCore.
- **[T]** Math.* edge values across the precision-sensitive set — every value from the Tor Browser fingerprint surface (`sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh/expm1/log1p/cbrt/hypot/fround/clz32/imul`).
- **[T]** `Number.prototype.toExponential` / `toPrecision` / `toLocaleString` edge cases per locale.
- **[T]** RegExp engine markers — Unicode property escape support; lookbehind support; named-capture support; `RegExp.escape` (Stage 4 proposal) presence; `/regex/v` set-notation support.
- **[T]** Iterator helpers presence — `Iterator.from`, `.map`, `.filter`, `.take`, `.drop`, `.flatMap`, `.reduce`, `.toArray`, `.forEach`, `.some`, `.every`, `.find`.
- **[T]** `Temporal` API presence per sub-namespace (`Temporal.Now`, `Temporal.Instant`, `Temporal.PlainDate`, `Temporal.PlainTime`, `Temporal.PlainDateTime`, `Temporal.Duration`, `Temporal.Calendar`, `Temporal.TimeZone`, …).
- **[T]** `ShadowRealm` presence + cross-realm Promise plumbing test.
- **[T]** `Atomics.waitAsync` presence; `SharedArrayBuffer` length-changing presence; `BigInt64Array` presence.
- **[T]** `Promise.withResolvers` (ES2024) + `Promise.any` + `Promise.allSettled` presence.
- **[T]** `Object.groupBy` / `Map.groupBy` presence (ES2024).
- **[T]** `Array.prototype.toReversed` / `toSorted` / `toSpliced` / `with` (ES2023) presence.
- **[T]** `Array.fromAsync` / `Promise.try` (Stage 4 candidates) presence.

## M. Crash / diagnostic logs

- **[T]** Recent Chromium crash dumps directory listing — `~/Library/Application Support/Google/Chrome/Crashpad/pending` and `completed` (filenames + sizes + first-line crash signatures).
- **[T]** Recent crash signatures via `log show --last 10m --predicate 'eventMessage CONTAINS[c] "crash"'`.
- **[T]** `~/Library/Logs/DiagnosticReports/` recent reports (ls + sha256 of newest).
- **[T]** `~/Library/Logs/CrashReporter/MobileDevice/` (iOS-paired device crash reports — fingerprints whether iPhone was attached).
- **[T]** `xnu` boot args via `nvram boot-args`; recent kernel panics via `log show --last 1d --predicate 'subsystem == "com.apple.kernel"' | grep -i panic`.
- **[T]** `launchd` recent job exit codes via `launchctl print system | grep "last exit code"`.
- **[T]** `pmset -g log | tail -200` recent power/sleep/wake events.
- **[T]** `system_profiler SPSoftwareDataType` boot mode (recovery / safe / verbose / normal).
- **[T]** SMC sensor history via `powermetrics -n 5 -i 1000 --samplers smc,cpu_power,thermal`.

## N. Memory / process internals (deeper)

- **[T]** `vmmap <pid>` per Chromium process — region list, mapped files, anon vs file-backed, COW state.
- **[T]** `sample <pid> 0.5` stack-sampling profile of node main + Chromium main + GPU process + each renderer.
- **[T]** `fs_usage -w -f filesystem` 3-second snapshot — every file syscall the Chromium tree makes during that window.
- **[T]** `nettop -m route -P -L 1 -l 1 -k state` per-process network state.
- **[T]** `iostat -d 1 1` device throughput; `iostat -c 1 1` CPU breakdown.
- **[T]** Swap usage — `sysctl vm.swapusage`.
- **[T]** `top -l 1 -n 500 -stats pid,command,cpu,mem,state,ports,mregion,rprvt,vprvt,vsize,rsize,th,fdfx,user` full process list.
- **[T]** `lsof -nP -i TCP -p $(pgrep -d, Chromium)` open TCP sockets per Chromium process.

## O. Display / monitor

- **[T]** `Screen.getScreenDetails()` for multi-monitor — per-screen left/top/width/height/availLeft/availTop/availWidth/availHeight/colorDepth/pixelDepth/devicePixelRatio/orientation/isPrimary/isInternal/label.
- **[T]** `ScreenOrientation` API state — `screen.orientation.type`/`angle`/`onchange` events.
- **[T]** HDR support per screen via `matchMedia('(dynamic-range: high)')` and `(video-dynamic-range: high)`.
- **[T]** Color-gamut capability via `matchMedia('(color-gamut: srgb)')`, `(color-gamut: p3)`, `(color-gamut: rec2020)`.
- **[T]** `system_profiler SPDisplaysDataType` — per-display vendor, product, EDID, resolution, refresh rate, color depth, mirror state.

## P. Trust / sandbox / isolation

- **[T]** COEP / COOP / CORP response headers per frame (via `Network.responseReceivedExtraInfo`).
- **[T]** `window.isSecureContext` per frame; `window.crossOriginIsolated` per frame; `window.originAgentCluster` per frame.
- **[T]** Iframe sandbox flags resolved per frame (parsed from sandbox attribute + headers).
- **[T]** Permissions-Policy resolved state per frame (via `Page.getPermissionsPolicyState`).
- **[T]** `Document-Policy` header per frame.
- **[T]** Storage partitioning state — Storage Access API state, third-party cookie permissions per origin, partition key per frame.
- **[T]** WebAuthn capability per origin (`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable` + `isConditionalMediationAvailable`).
- **[T]** `Trust Token` issuance / redemption state per origin.

## Q. Per-frame static metadata

- **[T]** Per-frame `<!doctype>` declaration; lang attribute; meta charset.
- **[T]** Every `<script src>` URL per frame (with crossorigin, integrity, nonce, type, referrerpolicy attributes).
- **[T]** Every `<link>` per frame — href, rel, as, crossorigin, integrity, type, sizes, imagesrcset.
- **[T]** Every `<meta>` per frame — name/property/http-equiv/content/charset.
- **[T]** Per-frame `document.cookie` value at start + end (sha256'd if any cookie present).
- **[T]** Per-frame `document.referrer`; `referrerpolicy` attribute on each link/script.

## R. Time / clock fingerprints

- **[T]** `performance.now()` precision test — call N times in a tight loop, measure min observable delta (browsers clamp differently: 5µs / 100µs / 1ms).
- **[T]** `Date.now()` precision test (typically 1ms but devtools/measurement reduces).
- **[T]** Drift between `performance.now()` and `Date.now()` over the session (monotonic-vs-wall divergence).
- **[T]** `requestAnimationFrame` interval distribution — collect 60 frame timestamps, histogram them (60Hz / 90Hz / 120Hz / 144Hz display + ProMotion variable-refresh).
- **[T]** Page Visibility API delta vs document.hidden boolean (timing of the transitions).
- **[T]** `document.timeline.currentTime` vs `performance.now()` skew.
- **[T]** Date / time-zone offset at session start vs end (detects DST transitions, NTP adjustments).
- **[T]** `setTimeout(fn, 0)` actual fired delay distribution (browsers clamp 0 to 4ms; nested timeouts to 4-10ms).

## S. Network probes from in-browser

- **[T]** WebRTC ICE candidate harvest — `RTCPeerConnection({iceServers:[]})` + `createDataChannel` + `createOffer` → enumerate host/srflx/relay candidates. Surfaces all local NIC IPs (incl. IPv6 LL/ULA, VPN interfaces).
- **[T]** STUN response from a public STUN server (e.g. `stun:stun.l.google.com:19302`) → server-reflexive IP.
- **[T]** TURN allocation test against known TURN server (capability probe only).
- **[T]** `<link rel=dns-prefetch>` to a known unique subdomain — measure time-to-resolve via Resource Timing.
- **[T]** `<link rel=preconnect>` to a known unique origin — measure TCP+TLS time.
- **[T]** WebSocket round-trip to a known echo server — measure RTT (matches against pcap RTT for sanity).
- **[T]** Service Worker fetch interception capability test (register SW, navigate, observe).
- **[T]** `caches.open()` capability + `cache.put` capability + per-cache `cache.keys()` enumeration of any pre-populated entries.

## T. GPU compute / graphics deeper

- **[T]** WebGL2 transform feedback fingerprint — write a known program, dump XFB buffer bytes, hash.
- **[T]** WebGL2 multiple-render-targets — write to 4 attachments with known fragment shader, hash each.
- **[T]** WebGL2 invariant qualifier handling — verify `invariant gl_Position` produces bit-equal output across draws (ANGLE backends differ).
- **[T]** WebGPU pipeline cache — same pipeline twice, measure compile-time delta (cached vs not).
- **[T]** 2D canvas full-primitive draw — every primitive (path/text/image/gradient/pattern/shadow/composite-op) on a known canvas → toDataURL hash.
- **[T]** SVG filter rendering — apply a chain (`feGaussianBlur` → `feColorMatrix` → `feComposite`) to a known input, rasterize via OffscreenCanvas, hash bytes.
- **[T]** Canvas `getContextAttributes()` reported defaults — alpha/desynchronized/colorSpace/willReadFrequently.
- **[T]** WebGL ANGLE backend identification — `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL` contains "ANGLE (Apple, Apple Mxx ...)" / "(NVIDIA, ...)" / "(Intel, ...)" — parse vendor+device strings.

## U. Audio compute deeper

- **[T]** DynamicsCompressorNode output — feed a known oscillator chain through the canonical AudioFP compressor settings, read 30 samples, hash. (This is *the* audio fingerprint vector — same browser+OS+CPU produces same output.)
- **[T]** IIRFilter rendering on known input — same setup, hash output.
- **[T]** WaveShaperNode on known curve — hash output.
- **[T]** ConvolverNode with known impulse response — hash output.
- **[T]** Per-output-channel rendering with `channelInterpretation:'speakers'` vs `'discrete'`.
- **[T]** `AudioContext.destination.{channelCount,channelCountMode,channelInterpretation,maxChannelCount}`.
- **[T]** `AudioListener` default position + orientation values.
- **[T]** `AudioContext.audioWorklet.addModule('inline-worklet.js')` — register, run, hash output bytes.

## V. Browser cache state

- **[T]** HTTP cache size + hit rate via Chromium internals (`chrome://net-internals/#httpCache` equivalent via NetLog parsing).
- **[T]** Disk cache age — for important resources, first-cached time relative to session start (warm-cache vs cold-cache detection).
- **[T]** Favicon cache state — `chrome://favicon/<url>` rendered + hashed.
- **[T]** Prefetch cache hits — every resource served from prefetch (per Resource Timing `transferSize===0` + `responseStart` close to `requestStart`).

## W. Extension / extra-injected code state

- **[T]** Detection of common extension-injected globals on `window` — uBO (`window.uBOBundle`), MetaMask (`window.ethereum`), LastPass (`window._lpcurrentid`), 1Password (`window.opCurrentField`), etc.
- **[T]** Document.querySelector for known extension-injected DOM elements (uBO badge, MetaMask popup root, etc.).
- **[T]** Service worker registration scope check for any non-page-controlled SW.
- **[T]** `navigator.serviceWorker.getRegistrations()` looking for registrations registered by extensions.
- **[T]** Detection of devtools-extension presence via `Function.prototype.toString.toString()` (devtools replace built-ins).

## X. Network adapter detail beyond MAC

- **[T]** Per-interface flags (UP/RUNNING/MULTICAST/BROADCAST/LOOPBACK/POINTOPOINT) from `ifconfig`.
- **[T]** Per-interface MTU.
- **[T]** Per-interface link speed (`ifconfig en0 | grep media:` on macOS).
- **[T]** Per-interface duplex mode.
- **[T]** IPv6 addresses with scope per interface; link-local + unique-local + global.
- **[T]** Default gateway per address family; `route -n get default` for IPv4 and IPv6.
- **[T]** Configured DNS servers per resolver scope (`scutil --dns` already W; expand to per-resolver match domain).

## Y. Filesystem mount + USB state

- **[T]** `mount(8)` full output.
- **[T]** `diskutil list` full + per-volume `diskutil info <vol>` — Name, FS type, capacity, used, mount, encryption, mount options, owners enabled.
- **[T]** USB device list with VID/PID/serial (sha256'd) — `system_profiler SPUSBDataType`.
- **[T]** External drive serial enumeration (sha256'd) — disk0/1/... serial.
- **[T]** Thunderbolt device list — `system_profiler SPThunderboltDataType`.
- **[T]** FUSE / network mounts list.

## Z. Locale + i18n deeper

- **[T]** `defaults read .GlobalPreferences AppleLanguages` (ordered preference list).
- **[T]** `defaults read .GlobalPreferences AppleLocale`.
- **[T]** `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_NUMERIC`, `LC_TIME`, `LC_COLLATE`, `LC_MONETARY`, `LC_MESSAGES`, `LC_PAPER`, `LC_NAME`, `LC_ADDRESS`, `LC_TELEPHONE`, `LC_MEASUREMENT`, `LC_IDENTIFICATION`, `TZ` env vars at session start.
- **[T]** `locale -a` available locales count.
- **[T]** ICU data version (from `Intl.DateTimeFormat` round-trip + V8 ICU version reflection).
- **[T]** First day of week per locale (`Intl.Locale.weekInfo.firstDay`).
- **[T]** Measurement system (metric/imperial) per locale.

## AA. GPU acceleration state

- **[T]** `chrome://gpu/` feature status list scraped via CDP — accelerated 2d canvas, accelerated video decode, hardware video encode, OOP-D, raster, multiple raster threads, vulkan, etc.
- **[T]** ANGLE backend (Metal / Vulkan / D3D11 / D3D12 / OpenGL) identified from `Browser.getVersion` build channel + `WEBGL_debug_renderer_info`.
- **[T]** Skia backend (Ganesh / Graphite) — read from `chrome://gpu/`.
- **[T]** Compositing path features (delegated ink trails, fenced frames, shared element transitions) from chrome://gpu.
- **[T]** Out-of-process iframe state — which iframes are OOP per `Page.getFrameTree` + process info.

## BB. Audio routing + Web Audio module detail

- **[T]** Default output device name + sample rate + channel count from `system_profiler SPAudioDataType` (sha256'd if device name is user-identifying).
- **[T]** Default input device name + sample rate + channel count.
- **[T]** AudioContext sample rates probe — try `new AudioContext({sampleRate: x})` for x ∈ {8000, 11025, 22050, 32000, 44100, 48000, 88200, 96000, 192000} → which succeed.

## CC. Property-trap deeper

- **[W]** `property_trap.js` records every read access with `(o, p, t)`.
- **[T]** Stack trace on every trapped access — `new Error().stack` captured to log the caller chain (currently only the access itself is logged, not the call site).
- **[T]** Caller URL + line + column on every trapped access (parsed from the stack).
- **[T]** Calling frame URL on every trapped access (`frameElement.src` for the caller frame, if iframe).
- **[T]** Wrap ALL writable properties on `Window.prototype` and `Document.prototype` (not just the read-side `wrapGetters`).

## DD. Page lifecycle deeper

- **[T]** `document.prerendering` state (`true` if cross-origin prerender candidate).
- **[T]** `document.wasDiscarded` state (true if restored from BFCache after discard).
- **[T]** BFCache restoration count — count of `pageshow` events with `persisted:true`.
- **[T]** Soft-navigation entries — `PerformanceObserver({type:'soft-navigation'})`.
- **[T]** `unloadEventStart`/`unloadEventEnd` from PerformanceNavigationTiming.
- **[T]** `redirectCount` from PerformanceNavigationTiming.

## EE. WebDriver / automation leak detection points

The pwning surface bot detectors check — every one of these is a fingerprint channel because absence/presence is the signal:

- **[W]** `navigator.webdriver` value (we spoof this; capture what page sees).
- **[T]** `window.cdc_adoQpoasnfa76pfcZLmcfl_Array` + `_Promise` + `_Symbol` (Chromedriver leak).
- **[T]** `window.$cdc_asdjflasutopfhvcZLmcfl_` (other Chromedriver leak).
- **[T]** `window.callPhantom`, `window._phantom` (PhantomJS leak).
- **[T]** `window.Buffer`, `window.process`, `window.global`, `window.require` exposure (Electron / NWJS leak).
- **[T]** `navigator.permissions.query({name:'notifications'})` returning `denied` while `Notification.permission` is `default` (Chromedriver leak).
- **[T]** `WebDriver` interface global presence.
- **[T]** Outer-vs-inner dimensions ratio (`outerWidth - innerWidth`, `outerHeight - innerHeight`) — headless tends to 0.
- **[T]** Battery API defaults (level=1, charging=true) on headless / docker.
- **[T]** `chrome.runtime` presence (headless lacks it; stock Chrome has it).
- **[T]** Plugin list size = 0 (headless default) vs N (stock).
- **[T]** Iframe `contentWindow.chrome` presence (matches `window.chrome`).
- **[T]** `navigator.languages.length` >= 2 (headless default is 1).
- **[T]** `Function.prototype.toString.call(navigator.webdriver getter)` — native vs monkeypatched.
- **[T]** Hairline test — render a 1-pixel-wide line at sub-pixel position, read back, compare to expected (HiDPI / DPR consistency check that bots often fail).

## FF. Process spawning context

- **[T]** Process tree from node up — `ps -o pid,ppid,command --ppid <parent>` recursively to PID 1.
- **[T]** Parent process command (Terminal.app, iTerm2, VSCode, Cursor, Claude Code CLI, systemd, launchd, ssh-session).
- **[T]** Controlling terminal — `tty` of the node process + parent shell.
- **[T]** Session leader — `ps -o sess` of node, parent shell, terminal app.
- **[T]** SSH connection markers — `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` env vars presence + sha256.
- **[T]** TMUX / screen session markers — `TMUX`, `STY` env vars.
- **[T]** Detached vs attached state — `tty -s` exit status.

## HH. CPU instruction-set + microarch detection from JS

- **[T]** WebAssembly SIMD feature probe (`v128.const`, `i8x16.shuffle`, etc.) via short module validation.
- **[T]** WebAssembly threads / atomics probe (Atomics + SharedArrayBuffer + Memory({shared:true})).
- **[T]** FMA (fused multiply-add) presence — `Math.fround(a*b+c)` vs `Math.fround(Math.fround(a*b)+c)` divergence on AMD64 / ARM64.
- **[T]** AVX-512 / NEON-aware path detection via WebGL ANGLE renderer string + Chrome `chrome://system/`.
- **[T]** CPU core count via `navigator.hardwareConcurrency`; physical-vs-logical via `sysctl hw.physicalcpu` + `sysctl hw.logicalcpu`.
- **[T]** CPU brand string — `sysctl -n machdep.cpu.brand_string` (macOS).
- **[T]** CPU family/model/stepping — `sysctl machdep.cpu.{family,model,stepping}`.
- **[T]** CPU feature flags — `sysctl machdep.cpu.features` + `extfeatures` + `leaf7_features`.
- **[T]** Apple Silicon detection — `sysctl hw.optional.arm.FEAT_*` capability flags.
- **[T]** Performance cores vs efficiency cores — `sysctl hw.perflevel0.physicalcpu` + `hw.perflevel1.physicalcpu` (Apple Silicon).
- **[T]** SHA-NI / AES-NI / SSE/AVX presence (x86) via `sysctl machdep.cpu.features`.

## II. macOS security state

- **[T]** System Integrity Protection — `csrutil status`.
- **[T]** Gatekeeper — `spctl --status`; `spctl --assess` on the Chromium binary.
- **[T]** Sealed System Volume — `csrutil authenticated-root status`.
- **[T]** AMFI (Apple Mobile File Integrity) — `nvram boot-args | grep amfi_get_out_of_my_way`.
- **[T]** Boot args — `nvram boot-args` full.
- **[T]** Recovery mode markers — `bputil -d` (Apple Silicon DFU/recovery state).
- **[T]** Secure Boot mode (Full / Medium / Reduced) — `bputil -d` (Apple Silicon).
- **[T]** XProtect version — `defaults read /System/Library/CoreServices/XProtect.bundle/Contents/Info.plist`.
- **[T]** MRT (Malware Removal Tool) version.
- **[T]** TCC (Transparency Consent and Control) DB approvals — `sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "select service, client, allowed from access"` (sha256'd entries; presence matters).
- **[T]** FileVault state — `fdesetup status`.
- **[T]** Find My state — `defaults read /Library/Preferences/com.apple.icloud.findmymac`.
- **[T]** MDM enrollment — `profiles show -type enrollment`.

## JJ. Browser IPC / process-model fingerprints

- **[T]** Per-renderer process site URL — `SystemInfo.getProcessInfo` returns child processes; cross-reference with `Target.getTargets` to map renderer pid → frame URL.
- **[T]** Out-of-process iframes count — count of OOPIF frames in `Page.getFrameTree`.
- **[T]** GPU process attach state — single GPU process per browser, capture its pid + cpuTime + memoryUsage delta over session.
- **[T]** Utility process count + their service names (from CDP child target list).
- **[T]** Network service process state — separate-vs-in-browser-process.
- **[T]** Mojo connection counts per-process (best-effort from `chrome://tracing/` if enabled).

## KK. Print API + paper sizes

- **[T]** `window.print` capability + `media='print'` matchMedia.
- **[T]** Paper-size set probe via `@page` CSS rule with various sizes (A4, Letter, Legal, A3, B4, ...) → which renders match expected.
- **[T]** `chrome.printerProvider` (extension API — capability probe only).
- **[T]** CUPS printer list — `lpstat -a` (count + sha256 of names).

## LL. Notification system state

- **[T]** `Notification.permission` value.
- **[T]** `Notification.maxActions` (max action buttons supported).
- **[T]** Per-origin notification permission — via CDP `Browser.grantPermissions` / `resetPermissions` interrogation.
- **[T]** macOS Do Not Disturb / Focus state — `defaults read com.apple.ncprefs dnd_prefs`.
- **[T]** Notification Center delivered count — `sqlite3 ~/Library/Application\ Support/com.apple.notificationcenter/db2/db ...` (count only, no content).

## MM. Animation deeper

- **[T]** `document.timeline.currentTime` vs `performance.now()` skew at session start + end.
- **[T]** Per-Animation `effect.getKeyframes()` + `effect.getTiming()` + `effect.composite`.
- **[T]** `Animation.replaceState` ('active' / 'persisted' / 'removed').
- **[T]** `Animation.pending` state.
- **[T]** Web Animations API capability — `Element.animate` return value chain test.
- **[T]** CSS scroll-driven animation — `animation-timeline` property support, `view-timeline` support.

## NN. CSS rendering quirks per-platform

- **[T]** `-webkit-*` / `-moz-*` / `-ms-*` / `-o-*` prefixed property support matrix via `CSS.supports`.
- **[T]** `font-smoothing` rendered output (`-webkit-font-smoothing: antialiased` vs `subpixel-antialiased`).
- **[T]** Sub-pixel positioning rendering — render a 0.5px wide div with background-color, sample pixel via canvas.
- **[T]** `image-rendering: pixelated` vs `crisp-edges` vs `auto` differences via canvas readback.
- **[T]** `box-shadow` blur quality (varies by GPU compositor backend).
- **[T]** `filter: blur(Npx)` rendered output.
- **[T]** `backdrop-filter` capability + rendered output.

## OO. Bytecode cache + V8 codecache

- **[T]** Detect script bytecode cache hit — for repeat-visited scripts, `Resource Timing` `decodedBodySize > 0` but execution time markedly faster.
- **[T]** Per-script `Debugger.scriptParsed` event timing relative to network arrival (cached scripts parse instantly).
- **[T]** `chrome://disk-cache/` size proxy via NetLog parsing.

## PP. Site isolation

- **[T]** Per-frame `securityOrigin` from `Page.frameNavigated` already W; expand to: per-frame storage partition key, per-frame is-cross-origin-isolated, per-frame agent cluster ID.
- **[T]** Per-process site URL lock — `SystemInfo.getProcessInfo` per renderer with its assigned site origin.
- **[T]** Site isolation feature state — `chrome://process-internals/#site-isolation` equivalent via NetLog headers.

## QQ. Speculation rules / prerendering

- **[T]** `<script type="speculationrules">` enumeration per frame.
- **[T]** `document.prerendering` boolean at every page state change.
- **[T]** Prerender activation events — `prerenderingchange` event log.
- **[T]** `chrome://predictors/` data via CDP (best-effort).

## RR. Browser auto-fill state

- **[T]** Chromium autofill suggestion availability for known field names (`username`, `password`, `email`, `name`, `cc-number`, ...) — capability probe only, no read.
- **[T]** Password manager presence — detect via `document.querySelector('input[autocomplete="current-password"]')` getting suggestions.
- **[T]** Saved-payment-method presence — `PaymentRequest({...}).canMakePayment()` true vs false (capability only).

## SS. Power efficiency / battery saver

- **[T]** macOS Low Power Mode — `pmset -g | grep lowpowermode`.
- **[T]** `navigator.connection.saveData` flag.
- **[T]** `prefers-reduced-motion` / `prefers-reduced-data` / `prefers-reduced-transparency` matchMedia results.
- **[T]** Thermal pressure — `pmset -g therm` (already in `_instHostSnapshots` but should be polled, not just one-shot).
- **[T]** CPU throttling state — `sysctl hw.cpufrequency` + perf-core P-state from `powermetrics`.

## TT. CDP capability gaps + chrome:// pages

- **[T]** `Page.setBypassCSP` capability probe (verifies devtools-attached state).
- **[T]** `Network.setRequestInterception` capability probe.
- **[T]** `Network.emulateNetworkConditions` current state (offline/online + bandwidth limit).
- **[T]** `Audits.SameSiteCookieIssueReason` enumeration per cookie issue event.
- **[T]** `Browser.getHistograms` with `delta:true` polled every 30s (so we see *change* counts not just all-time).
- **[T]** `chrome://flags` exposed feature flags — parse `Browser.getBrowserCommandLine` for `--enable-features=` / `--disable-features=` and split into individual flag names.
- **[T]** `chrome://components/` versions — Widevine CDM version, Origin Trials Config version, MEI Preload version.
- **[T]** `chrome://policy/` applied enterprise policies (best-effort).
- **[T]** `chrome://discards/` recently-discarded tab list.
- **[T]** `chrome://memory-internals/` per-process memory dump.
- **[T]** `chrome://network-errors/` last error if any.

## UU. Per-trajectory deeper

- **[T]** Trajectory file source — full sha256 + first-line shebang + module imports list (which atoms it pulls).
- **[T]** Trajectory argv — exact env vars + cli args the trajectory was invoked with (decoded).
- **[T]** Trajectory branch trace — which conditional branches the trajectory hit (instrumentation via wrapper or `--inspect-brk` + coverage).

## VV. Repeatability + determinism markers

- **[T]** Random-seed values exposed via `Math.random` wrap (we count calls; also dump the first-N return values so a re-run with the same seed can be verified).
- **[T]** Persona generation RNG seed (already named in F) + every `Math.random()` consumed during persona resolution + every `Date.now()`.
- **[T]** Proxy assignment seed — which row of the proxy pool was picked + why.
- **[T]** Account row picked seed — which `social_accounts` row was claimed + the random tiebreaker if any.

## WW. Hardware enclave + crypto chip state

- **[T]** Apple Secure Enclave presence — `system_profiler SPiBridgeDataType` (T2/M-series chip info).
- **[T]** Touch ID / Face ID enrollment state — `bioutil -r -s` (count only).
- **[T]** Apple Pay availability — `defaults read com.apple.passd` (presence of stored wallets, count only).
- **[T]** Hardware-backed WebCrypto operations — for `crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, false, ['sign'])` check `extractable:false` works (Secure-Enclave-backed in Safari; software-backed elsewhere).
- **[T]** WebAuthn platform authenticator — `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` (true → Touch ID/Windows Hello/Android Strongbox bound).

## XX. DOM mass + structural metrics

- **[T]** Per-frame `document.documentElement.outerHTML.length` (total HTML byte count, ungzipped) at every major page state.
- **[T]** Per-frame DOM node count by tag (`document.querySelectorAll('*').length` + by-tag histogram).
- **[T]** Per-frame stylesheet count + rule count (`document.styleSheets[*].cssRules.length`).
- **[T]** Per-frame iframe depth (max nesting level).
- **[T]** Per-frame ShadowRoot count (open + closed).
- **[T]** Per-frame `<script>` count + total script byte size.
- **[T]** ARIA tree depth + role distribution histogram.

## YY. Service Worker installed scripts

- **[T]** Per active SW: `getRegistration().active.scriptURL` + sha256 of fetched script content + dependent imports (importScripts).
- **[T]** SW installed cache contents — for each cache in `caches.keys()`, list `await caches.open(name).then(c=>c.keys())` URLs.
- **[T]** SW navigationPreload state + `getState()` value.
- **[T]** SW updateViaCache value.

## ZZ. Detached browsing contexts

- **[T]** Background pages / popups still alive at session close (CDP `Target.getTargets`).
- **[T]** Documents in BFCache count (from `Page.lifecycleEvent` 'persisted' transitions).
- **[T]** Fenced frames count (`<fencedframe>` tag enumeration + `chrome://process-internals/`).

## AAA. Per-renderer GC events

- **[T]** From Tracing categories `v8` + `disabled-by-default-v8.runtime_stats`: every minor-GC + major-GC event, GC type (Scavenger/MarkCompact/MinorMC), duration, memory before/after.
- **[T]** V8 compile / optimize / deoptimize events from Tracing.
- **[T]** Heap-snapshot growth between captures (start vs end retained-size delta per object type).

## BBB. Cookie store distribution

- **[T]** Per-host: cookie count, total cookie-name-byte-length, total cookie-value-byte-length, SameSite distribution (None/Lax/Strict counts), partition-key distribution. *Counts only* — no contents.
- **[T]** Cookie max age distribution histogram.

## CCC. WebRTC internals

- **[T]** `chrome://webrtc-internals/` equivalent dump — every PeerConnection's full event log: createOffer/setLocalDescription/setRemoteDescription/addIceCandidate timings, every ICE state transition, every DTLS state, every stats report.
- **[T]** Every `RTCStatsReport.values()` snapshot at session close.

## DDD. NetLog source-dep map

- **[T]** From NetLog: which `SOCKET` source created which `HTTP2_SESSION`, which session sent which `URL_REQUEST`. Build a graph of connection reuse per host.
- **[T]** Per-host connection count + max concurrent streams used.
- **[T]** TLS 1.3 0-RTT use + replay-rejection markers from NetLog.

## EEE. Deprecated-but-still-checked APIs

- **[T]** PNaCl detection — `navigator.mimeTypes['application/x-pnacl']` (deprecated; presence-checked by some classifiers).
- **[T]** AppCache (`window.applicationCache`) presence — deprecated, removed in newer Chromes; absence is a fingerprint.
- **[T]** `document.all` truthiness behavior (legacy HostObject quirk — `typeof document.all === 'undefined'` AND `Boolean(document.all) === false`).
- **[T]** `escape`/`unescape` global function presence.
- **[T]** `Image()` / `HTMLImageElement.prototype` constructor signature.

## FFF. CSP nonce + hash extraction

- **[T]** Per page: every `<script nonce>` value (logged from CSP).
- **[T]** Per page: every `style-src 'sha256-…'` / `script-src 'sha256-…'` value from CSP header.
- **[T]** `report-to` / `report-uri` endpoint per CSP directive.

## GGG. Shared workers state

- **[T]** Per shared worker: scriptURL, name, connections count, port count.
- **[T]** SharedArrayBuffer cross-context capability — verify post + receive across worker boundary.

## HHH. Long task attribution

- **[T]** From `PerformanceObserver({type:'longtask'})`: every long task with `attribution[].containerType` (iframe/script/window), `containerName`, `containerSrc`, `containerId`.
- **[T]** Per-script long-task aggregate (which script caused most blocking time).

## III. Document picture-in-picture

- **[T]** `documentPictureInPicture.window` state.
- **[T]** PIP capability — `document.pictureInPictureEnabled`.
- **[T]** Video PIP state on every `<video>` element (`webkitSupportsPresentationMode('picture-in-picture')` matrix).

## JJJ. Cookie Store API + StorageEvents

- **[T]** `cookieStore.getAll()` per origin (counts only).
- **[T]** `cookieStore.addEventListener('change')` event log.

## KKK. Routing + firewall

- **[T]** Full routing table — `netstat -rn` (already W partial); expand to per-AF route + per-route metric/MTU.
- **[T]** `pfctl -sa` — full pf rule set + state count (macOS).
- **[T]** `iptables -L` / `nft list ruleset` — full ruleset (Linux).
- **[T]** Per-interface stats from `netstat -i`.

## LLL. SSL trust store

- **[T]** System-trusted root CAs — `security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain` (sha256 of cert chain, count only).
- **[T]** User-added trusted roots — `security find-certificate -a -p` (count + sha256).
- **[T]** Chromium-bundled NSS root store version (from `chrome://components/` Certificate-Verifier component).

## MMM. Containerization / VM / sandbox detection

- **[T]** Docker container markers — `/.dockerenv` file presence.
- **[T]** Linux container markers — `cat /proc/1/cgroup | grep -E 'docker|kubepods|lxc'`.
- **[T]** Hypervisor presence — CPUID hypervisor bit via `sysctl machdep.cpu.features` (`VMM`/`HYPERVISOR`).
- **[T]** Specific hypervisor — `system_profiler SPHardwareDataType` model identifier (`VirtualMachine`, `Parallels`, `VMware`).
- **[T]** WSL detection — `uname -r` (contains "microsoft").
- **[T]** ARM-on-Rosetta detection — `sysctl sysctl.proc_translated` (1 → process running under Rosetta 2).

## NNN. Browser features Chromium build emits

- **[T]** `chrome://flags/` parse from argv flags + chrome://gpu features list.
- **[T]** Origin trial tokens registered globally (from `chrome://origin-trials/`).
- **[T]** Field trial group assignment from `--force-fieldtrials=` argv flag.
- **[T]** Variation header value sent on requests (`X-Client-Data` header).

## OOO. Sandbox dimensions

- **[T]** macOS process sandbox profile — `sandbox-exec` profile name applied (none, `kBrowserHelperRendererSandboxProfile`, etc.) via `ps -o sandbox`.
- **[T]** Code-signing entitlements of Chromium binary — `codesign -d --entitlements - <binary>`.
- **[T]** Renderer-process sandbox layer (App Sandbox / seatbelt / Bionic / pid namespace) per child process.

## PPP. Per-process resource counters

- **[T]** Per Chromium child process: open file descriptors, sockets, threads count, peak memory.
- **[T]** Per process: `getrusage()` equivalent — CPU time, page faults (major + minor), context switches, max RSS.

## QQQ. Browser update channel + version detail

- **[T]** Browser channel — Stable / Beta / Dev / Canary inferred from `Browser.getVersion` product string + `userAgent.product` formatting differences.
- **[T]** Build commit short sha — `chrome://version/` "Revision" line.
- **[T]** Mojo platform identifier from CDP `Browser.getVersion`.
- **[T]** Locale built into the binary — `chrome://version/` "Variations Seed Signature" + "Command Line".

## RRR. HSTS + HPKP state

- **[T]** Per-domain HSTS state — `chrome://net-internals/#hsts` query equivalent via NetLog (which domains have STS pinned, max-age, includeSubdomains).
- **[T]** HPKP pinning state (deprecated but legacy state may persist).
- **[T]** Expect-CT state per domain.
- **[T]** Public Key Pinning Reports state.

## SSS. QUIC session resumption + 0-RTT

- **[T]** QUIC session resumption — from NetLog, whether the QUIC handshake reused a saved session.
- **[T]** 0-RTT data sent + accepted/rejected per request.
- **[T]** Connection migration events (NAT rebinding tolerance).
- **[T]** ECN markings observed.
- **[T]** QUIC version negotiated per connection.

## TTT. WebSocket extensions

- **[T]** Per-WS connection: `permessage-deflate` extension negotiation params (server_max_window_bits, client_max_window_bits, server_no_context_takeover, client_no_context_takeover).
- **[T]** Per-WS connection: subprotocol negotiated.
- **[T]** Frame opcode distribution per connection.

## UUU. Resource hints + preloads

- **[T]** Per-page `<link rel=preload>` count + per-as-type distribution; per-preload hit/miss (PerformanceResourceTiming `responseStart` near `requestStart`).
- **[T]** `<link rel=prefetch>` count + hits.
- **[T]** `<link rel=modulepreload>` count + hits.
- **[T]** `<link rel=preconnect>` count + per-origin success.
- **[T]** `<link rel=dns-prefetch>` count.
- **[T]** Speculation rules JSON content per `<script type="speculationrules">`.

## VVV. Service Worker conflict log

- **[T]** Per origin: multiple SW registrations vs single — conflict count.
- **[T]** Scope-vs-scriptURL mismatches.
- **[T]** SW update fetched-but-not-activated count.

## WWW. WebPush subscription state

- **[T]** Per active SW: `pushManager.getSubscription()` state — endpoint sha256 + applicationServerKey sha256 + expirationTime.
- **[T]** Per origin: push permission state.

## XXX. WebAuthn credential flags

- **[T]** Per registered credential: `rk` (resident key), `uv` (user verified), `up` (user presence), `bs` (backup state), `be` (backup eligible) flags.
- **[T]** `PublicKeyCredential.getClientCapabilities()` (recent) — full capability dump.
- **[T]** Conditional UI availability per Public Key field.

## YYY. SubresourceWebBundle / Bundle Preloading

- **[T]** `<script type="webbundle">` enumeration + scope/resources counts.
- **[T]** Webbundle hit/miss per resource served from a bundle.

## ZZZ. WebGPU device limits per requestDevice

- **[T]** Per `navigator.gpu.requestDevice({requiredFeatures, requiredLimits})` call: which features were requested, which granted, which limits granted at what value.
- **[T]** WGSL feature support — try compiling a known WGSL shader containing every optional feature (`f16`, `subgroups`, `derivative_uniformity`).

## AAAA. SharedArrayBuffer cross-context transfer

- **[T]** `postMessage` SAB transfer capability across worker boundary — verify the worker sees the same byte view.
- **[T]** `crossOriginIsolated === true` required state for SAB.
- **[T]** Atomics.wait/notify wakeup latency across contexts.

## BBBB. Cross-origin isolation source attribution

- **[T]** Per frame: is it COI because of header (COEP+COOP), feature flag, or both?
- **[T]** COEP report-only count (would-be-blocked subresources if enforcement were on).

## CCCC. Mojo JS exposure

- **[T]** `Mojo` global presence (only in `--enable-blink-features=MojoJS` builds).
- **[T]** Detect any leaked Mojo interface globals.
- **[T]** `chrome.intercept` / `chrome.send` (internal-page-only) presence.

## DDDD. Client Hints sent on every request

- **[T]** Per outbound request: full Client Hints header set — `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`, `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Arch`, `Sec-CH-UA-Bitness`, `Sec-CH-UA-Model`, `Sec-CH-UA-Full-Version-List`, `Sec-CH-UA-WoW64`, `Sec-CH-UA-Form-Factor`, `Sec-CH-Prefers-Color-Scheme`, `Sec-CH-Prefers-Reduced-Motion`, `Sec-CH-Prefers-Reduced-Transparency`, `Sec-CH-DPR`, `Sec-CH-Viewport-Width`, `Sec-CH-Viewport-Height`, `Sec-CH-Width`, `Sec-CH-Save-Data`, `Sec-CH-ECT`, `Sec-CH-Downlink`, `Sec-CH-RTT`.
- **[T]** Per outbound request: `Sec-Fetch-Site`, `Sec-Fetch-Mode`, `Sec-Fetch-Dest`, `Sec-Fetch-User` values.
- **[T]** Per outbound request: `Accept-Language` value + order; `Accept` value + order.
- **[T]** Per outbound request: `Referer` (full vs origin vs none) + `Referrer-Policy` resolved.
- **[T]** Per outbound request: `X-Client-Data` (Chrome field trial) header value.
- **[T]** Per outbound request: `Priority` header (RFC 9218).

## EEEE. Server Timing entries

- **[T]** Per response: every `Server-Timing` header value parsed (name + dur + desc).
- **[T]** `PerformanceServerTiming` entries on every PerformanceResourceTiming.

## FFFF. Event Timing detail

- **[T]** Per `PerformanceEventTiming` entry: `interactionId`, `target` selector path, `processingStart`, `processingEnd`, `startTime`, `duration`.
- **[T]** Interaction-to-Next-Paint computation per interaction.

## GGGG. Pointer + Wheel event detail

- **[T]** Per pointer event: ratio of `coalescedEvents().length` to base event count.
- **[T]** Per pointer event: `predictedEvents().length`.
- **[T]** Wheel event `deltaMode` distribution (0=PIXEL, 1=LINE, 2=PAGE).
- **[T]** Wheel event deltaX/Y/Z distribution histograms.

## HHHH. Paint + interactivity metrics

- **[T]** `PerformancePaintTiming.firstPaint` and `firstContentfulPaint` values.
- **[T]** Time-to-interactive (TTI) heuristic computation.
- **[T]** LCP candidate element selector + size + loadTime + renderTime.
- **[T]** CLS shifts — for each layout-shift entry: value, sources[] (element selector + previousRect + currentRect).

## IIII. Cookie attribute behavior

- **[T]** Attempt to read HttpOnly cookies via document.cookie — confirmed empty (presence is the fingerprint).
- **[T]** Per cookie: SameSite (None/Lax/Strict), partitioned (true/false), secure, path, max-age, sourceScheme, sourcePort.
- **[T]** First-party-sets membership per cookie.

## JJJJ. Storage Access API

- **[T]** `document.requestStorageAccess()` outcome per origin — granted / denied / prompt-shown.
- **[T]** `document.hasStorageAccess()` state at session start.
- **[T]** Per-origin storage access permission via CDP `Browser.grantPermissions` introspection.

## KKKK. Login Status API + IdP state

- **[T]** `navigator.login.setStatus()` capability + per-origin state.
- **[T]** FedCM (Federated Credential Management) availability — `navigator.credentials.get({identity: {...}})` capability.
- **[T]** Per-IdP login status from FedCM cache.

## LLLL. Topics API + Protected Audience + Attribution

- **[T]** `document.browsingTopics()` returned topic list per epoch.
- **[T]** Protected Audience auctions — every `navigator.runAdAuction()` call args + outcome.
- **[T]** Attribution Reporting — `<a attributionsrc>` + `fetch(..., {attributionReporting:...})` log.

## MMMM. Per-request body sniffing

- **[T]** Per POST request: body sniffed content-type (form-data / json / text / binary) regardless of declared Content-Type.
- **[T]** Per response: sniffed content-type vs declared.
- **[T]** Per request: cors preflight count, preflight cache hit/miss.

## NNNN. Header ordering signature

- **[T]** Per outbound request: exact order of headers as they appear on the wire (HTTP/1.x) or in HPACK encoder (HTTP/2). Headers SET don't appear in the same order; the order itself is a Chromium-version fingerprint.

## OOOO. SVG / MathML rendering

- **[T]** Render a known SVG with filter/gradient/mask chain → rasterize via OffscreenCanvas → hash bytes.
- **[T]** Render a known MathML expression → DOM measurement (each child element's bounding rect width/height).
- **[T]** MathML capability test — `document.createElement('math')` instanceof MathMLElement.

## PPPP. Print-style media + paged-media

- **[T]** `@media print` rules applied — render via `Page.printToPDF` and hash bytes.
- **[T]** Paged Media support — `@page :first { ... }` rule recognition.
- **[T]** CSS pagination — `break-before/-after/-inside` honored.

## QQQQ. Document language + writing system

- **[T]** `document.documentElement.lang` value per frame.
- **[T]** `document.dir` value (ltr/rtl/auto).
- **[T]** Inferred-language per text node (Intl.Locale.maximize on detected scripts).

## RRRR. iCloud / continuity / handoff state

- **[T]** iCloud account presence — `defaults read MobileMeAccounts` (count + sha256 of account ids).
- **[T]** Handoff state — `defaults read com.apple.coreservices.useractivityd ActivityAdvertisingAllowed`.
- **[T]** AirDrop visibility — `defaults read com.apple.sharingd DiscoverableMode`.
- **[T]** Continuity Camera + Sidecar enrollment count.

## SSSS. Chromium internal pages (chrome://*) we can scrape via CDP

- **[T]** `chrome://gpu/` — Page.navigate + DOMSnapshot.captureSnapshot → full feature/driver/extension dump.
- **[T]** `chrome://version/` — Page.navigate + dump.
- **[T]** `chrome://system/` — full system page (incl. lspci/lsusb on linux).
- **[T]** `chrome://histograms/` — full histogram dump (richer than `Browser.getHistograms`).
- **[T]** `chrome://serviceworker-internals/` — every registered SW across all origins.
- **[T]** `chrome://media-internals/` — every media element + decoder state.
- **[T]** `chrome://net-internals/#dns` — DNS host resolver cache.
- **[T]** `chrome://net-internals/#sockets` — open sockets + connection pool state.
- **[T]** `chrome://net-internals/#alt-svc` — Alt-Svc cache.
- **[T]** `chrome://net-internals/#quic` — active QUIC sessions.
- **[T]** `chrome://policy/` — applied enterprise policies.
- **[T]** `chrome://components/` — installed components + versions (Widevine CDM, MEI Preload, etc.).
- **[T]** `chrome://process-internals/` — process model state.
- **[T]** `chrome://blob-internals/` — active Blob URLs.
- **[T]** `chrome://indexeddb-internals/` — per-origin IDB databases.
- **[T]** `chrome://quota-internals/` — per-origin storage quota.
- **[T]** `chrome://device-log/` — device events log.
- **[T]** `chrome://accessibility/` — a11y tree for every tab.
- **[T]** `chrome://predictors/` — autocomplete + omnibox predictors.
- **[T]** `chrome://flags/` — current feature flag state.
- **[T]** `chrome://settings/cookies/detail/` per origin — cookie detail.
- **[T]** `chrome://discards/` — recently discarded tab list.
- **[T]** `chrome://download-internals/` — recent download events.
- **[T]** `chrome://attribution-internals/` — Attribution Reporting state.
- **[T]** `chrome://private-aggregation-internals/` — private aggregation reports.

## TTTT. Render-process pipeline

- **[T]** Per-page Blink LayoutTree size — `Memory.getDOMCounters` already W; add layout-tree-node count via CDP `DOM.getDocument` walk.
- **[T]** CC (compositor) layer count + layer tree depth — `LayerTree.layerTreeDidChange` event.
- **[T]** GPU command buffer activity from Tracing `gpu.memory` category.
- **[T]** Per-frame paint count + invalidation rect count from `disabled-by-default-devtools.timeline.frame` category.

## UUUU. Pipeline cache fingerprint

- **[T]** WebGL shader pipeline cache — same shader compiled twice within session, measure compile-time delta (first compile slow, cached fast). Hash both timings.
- **[T]** WebGPU pipeline cache — same trick with `createComputePipeline` / `createRenderPipeline`.
- **[T]** V8 script cache — same script eval'd twice, measure parse-time delta.

## VVVV. Input entropy / scripted-vs-human detection

- **[T]** Mouse trajectory velocity profile — for every human/automated click, compute the velocity histogram and acceleration variance of the mouse path (humans show jitter; scripts show smooth Bezier or sharp lines).
- **[T]** Inter-keystroke timing distribution — mean, stddev, p95, p99 (humans show bimodal; scripts show normal/uniform).
- **[T]** Mouse-pause distribution before clicks (humans pause, scripts don't).
- **[T]** Scroll-wheel jitter — wheel events fired evenly (scripts) vs unevenly (humans).
- **[T]** Pointer-event pressure values (humans on trackpad/stylus emit varying pressure; scripts always emit 0 or 0.5).
- **[T]** Touch event radius variance (real touches vary; synthesized touches are constant).

## WWWW. Coordinate / DPR rounding fingerprint

- **[T]** `window.devicePixelRatio` exact value (1.0/1.25/1.5/2.0/3.0 etc).
- **[T]** Sub-pixel layout — render a 1px line at `transform: translateX(0.5px)`, sample via getBoundingClientRect, check rounding.
- **[T]** `getBoundingClientRect()` returning sub-pixel values vs integer-rounded.
- **[T]** `window.innerWidth` vs `document.documentElement.clientWidth` divergence (scrollbar width fingerprint).
- **[T]** Scrollbar dimensions — render a forced-scrollbar element, measure width (0 = overlay scrollbars, 15px = classic, varies by OS).

## XXXX. Content encoding negotiation

- **[T]** Per outgoing request `Accept-Encoding` header value + order (`gzip, deflate, br, zstd` ordering varies by Chrome version).
- **[T]** Per incoming response `Content-Encoding` value distribution across responses.
- **[T]** Per response: actual decoded size vs declared `Content-Length` discrepancy.

## YYYY. WebCodecs API

- **[T]** `VideoEncoder.isConfigSupported({codec, ...})` matrix across known codec strings.
- **[T]** `VideoDecoder.isConfigSupported` matrix.
- **[T]** `AudioEncoder.isConfigSupported` + `AudioDecoder.isConfigSupported` matrices.
- **[T]** `ImageDecoder.isTypeSupported(mime)` matrix.

## ZZZZ. WebTransport metrics

- **[T]** Per WebTransport session: datagram MTU negotiated, stream count, bytes per stream.
- **[T]** Connection migration events on WT (QUIC).
- **[T]** RTT and congestion-control state from `WebTransport.connection`.

## AAAAA. Origin Private FS enumeration

- **[T]** Per origin: `navigator.storage.getDirectory()` root handle, recursive `entries()` enumeration — every file name + size + mtime + sha256 (count + sha256 of names only if privacy-sensitive).

## BBBBB. Detection-evasion sanity links (must not leak)

- **[T]** Confirm trajectory never navigates to known fingerprint-test domains during a real session (creepjs.com, fingerprintjs.com, browserleaks.com, abrahamjuliot.github.io/creepjs, deviceandbrowserinfo.com, audiofp.com). Logged as a non-event invariant — if it ever happens, alert.

## CCCCC. Browser-extension-blocked URLs visible from page

- **[T]** Pixel for known blocked endpoints (Google Analytics, Doubleclick, Facebook Pixel) — outgoing request fired vs not. Absence of these requests is a fingerprint (adblock-style filtering signal).
- **[T]** `chrome.webRequest`-blocked URLs visible via NetLog `URL_REQUEST_BLOCKED` events.

## DDDDD. Cross-run determinism diff harness

- **[T]** Two-run mode: run the same trajectory twice with same persona+proxy seed, diff every captured channel pair-wise (already mostly done via `diff.mjs`; add: persistence of the inst.json deltas as a stored "determinism signature" so we know which channels are noisy vs stable).

## EEEEE. JS engine GC + JIT internals

- **[T]** Number of GC cycles during session (from Tracing `v8` category) — minor + major counts.
- **[T]** V8 optimization tier counts from `disabled-by-default-v8.runtime_stats` — Ignition/Sparkplug/Maglev/Turbofan invocations.
- **[T]** V8 deoptimization events count + per-function deopt reasons.
- **[T]** Inline cache (IC) hit/miss ratios from V8 runtime stats.
- **[T]** Lazy parse vs eager parse statistics.

## FFFFF. Sandbox + namespacing dimensions (Linux)

- **[T]** PID namespace ID per Chromium child (Linux only).
- **[T]** Mount namespace ID per Chromium child.
- **[T]** Network namespace ID.
- **[T]** seccomp filter applied (yes/no + filter sha256).
- **[T]** Capability bounding set (Linux capabilities) per process.
- **[T]** apparmor / SELinux label per process.

## GGGGG. macOS-specific user-state attributes

- **[T]** Logon time of current user — `last $USER | head -1`.
- **[T]** Idle time — `ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1e9; exit}'`.
- **[T]** Number of windows currently open (NSApplication-level) — `osascript -e 'tell application "System Events" to get count of every window of every process'` (read-only, but blocked by AppleScript rule — keep as conceptual only; use private CGWindowList APIs via Node N-API if needed).
- **[T]** Active app frontmost — `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`.
- **[T]** Number of desktops + active desktop index.

## HHHHH. Network namespace / VPN detection

- **[T]** Active VPN — `scutil --nwi | grep -i vpn`; `ifconfig | grep -E 'utun|tun|ppp'`.
- **[T]** Tailscale presence — `ifconfig utun*` + tailscale-specific routes.
- **[T]** WireGuard interfaces.
- **[T]** ProxySwitcher / system proxy state — `scutil --proxy`.

## IIIII. Browser developer-tools detection (the page side)

- **[T]** `window.outerHeight - window.innerHeight` exceeds typical browser chrome by N pixels → devtools open (page-side detector).
- **[T]** `console.log` triggering DevTools-only behavior (e.g., %c style strings rendering via console).
- **[T]** `Function.prototype.toString` toString invocation count (devtools attached invokes more).
- **[T]** `Object.getOwnPropertyNames(console)` length differs when devtools-attached.

## JJJJJ. Per-resource priority + scheduling

- **[T]** Per-request `Priority` header value (high/medium/low + incremental).
- **[T]** Per-request RFC 9218 priority signals.
- **[T]** Resource fetch order across the page — first-N requests in order; identifies which discovery method (parser-blocking vs preload-scanner vs script-injected) found which URL.

## KKKKK. Mach-O binary introspection (macOS)

- **[T]** Chromium main binary: `otool -l <bin>` load commands, segments + sections, codesign blob, entitlements (`codesign -d --entitlements - <bin>`), embedded `Info.plist`, bundle identifier + version.
- **[T]** Chromium frameworks under `Chromium.app/Contents/Frameworks/`: per-framework load commands + UUID + linker version.
- **[T]** Per Chromium child binary (Helper, Helper (GPU), Helper (Plugin), Helper (Renderer)): sha256 + codesign team-id + entitlements.
- **[T]** weles dist `.mjs` files: sha256 + line count + first-byte-of-source hash (catches subtle build divergence).

## LLLLL. Per-Chromium-process Mach task info

- **[T]** `task_info()` per Chromium child pid: virtual_size, resident_size, max_resident_size, suspend_count, policy, faults, pageins, copy_on_write_faults, threads_count.
- **[T]** Thread-level info per process — `proc_pidinfo` PROC_PIDTHREADINFO for each thread: scheduler policy, priority, run state.
- **[T]** `mach_port_dump` count of ports owned per task.

## MMMMM. Filesystem extended attributes

- **[T]** Chromium binary xattrs — `xattr -lx <binary>` full dump (com.apple.quarantine flags, com.apple.metadata:kMDItemWhereFroms, com.apple.lastuseddate, com.apple.cs.CodeDirectoryHash).
- **[T]** weles workdir xattrs (`~/.work/inst/*.json`) for Spotlight-tagged files.
- **[T]** Per file in `recordings/<label>/`: xattr inventory (provenance tags).

## NNNNN. Chromium variation seed + synthetic trials

- **[T]** `chrome://variations/` — full variation seed value + every active field trial group assignment.
- **[T]** `chrome://histograms/UMA.SyntheticTrials` — which synthetic field trials are active for this session.
- **[T]** `chrome://field-trial-internals/` — field-trial-to-group assignments.
- **[T]** `chrome://variations/#permanent` — permanently-saved variation seed.

## OOOOO. Chrome stored profile + Local State

- **[T]** `~/Library/Application Support/Google/Chrome/Local State` (or Chromium profile dir): JSON dump of profile names, default profile, ML model versions, optimization-guide hint cache, machine-id.
- **[T]** Per-profile `Preferences` JSON — sha256 of contents + key-by-key inventory (no values).
- **[T]** `Network Persistent State` — HTTP/QUIC server config cache.
- **[T]** `Network Action Predictor` DB row count.
- **[T]** `Top Sites` DB row count.
- **[T]** `Favicons` DB size + entry count.

## PPPPP. Default-app handler registration (macOS LaunchServices)

- **[T]** `defaults read com.apple.LaunchServices/com.apple.launchservices.secure` — for `http://` / `https://` / `mailto:` / `ftp://` / `feed:` / `sms:` / `tel:` schemes, which app is registered.
- **[T]** Default browser identity — `defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers`.

## QQQQQ. macOS keyboard + input source list

- **[T]** `defaults read com.apple.HIToolbox AppleEnabledInputSources` — every input method configured.
- **[T]** Selected input source via `defaults read com.apple.HIToolbox AppleSelectedInputSources`.
- **[T]** Keyboard repeat rate + initial delay — `defaults read NSGlobalDomain KeyRepeat` + `InitialKeyRepeat`.
- **[T]** Dead keys + diacritic enabled — `defaults read NSGlobalDomain ApplePressAndHoldEnabled`.

## RRRRR. macOS accessibility-enabled apps (TCC.db)

- **[T]** Apps with Accessibility approval — count via `sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "select count(*) from access where service='kTCCServiceAccessibility' and allowed=1"`.
- **[T]** Apps with Screen Recording approval (count only).
- **[T]** Apps with Full Disk Access approval (count only).
- **[T]** Apps with Microphone / Camera / Contacts / Calendars approval (counts).

## SSSSS. CPU governor / scaling policy

- **[T]** macOS — `sysctl machdep.xcpm.*` for performance state machine state.
- **[T]** `sysctl hw.cpufrequency` + `hw.cpufrequency_min` + `hw.cpufrequency_max`.
- **[T]** Apple Silicon P-state and E-state — `powermetrics --samplers cpu_power -n 1 -i 100`.

## TTTTT. DNS-over-HTTPS state

- **[T]** Chrome Secure DNS setting — from `chrome://flags/#dns-over-https` + Local State JSON `dns_over_https.mode` / `templates`.
- **[T]** System DNS provider per resolver scope — `scutil --dns` already partly W; expand to per-scope server addresses + flags.
- **[T]** DoH provider templates known to Chrome — `chrome://settings/security` configured value.
- **[T]** Per outbound DNS query: was it resolved via DoH or plaintext? (from NetLog `HOST_RESOLVER_IMPL_REQUEST` events).

## UUUUU. TLS deeper

- **[T]** ECH (Encrypted Client Hello) status per connection — sent vs absent; retry-config received from server.
- **[T]** TLS Channel ID extension presence (deprecated but probed).
- **[T]** HelloRetryRequest occurrences per session (server forces curve renegotiation).
- **[T]** TLS False Start used (yes/no).
- **[T]** Per cert chain: SCT (Signed Certificate Timestamp) count + delivery method (TLS ext vs OCSP vs cert).
- **[T]** OCSP staple present per cert chain + freshness.
- **[T]** CRL fetch events from NetLog.
- **[T]** TLS Application-Layer Protocol Settings (ALPS) negotiated values.

## VVVVV. Per-Chromium component install versions

- **[T]** From `chrome://components/`: Widevine CDM, MEI Preload, File-Type Policies, Crowd Deny, Subresource Filter, Recovery, First Party Sets, Trust Token Key Commitments, TrustedVault, Origin Trials Config, Optimization Hints, Safety Tips, Pkix Error List, Real-Time URL Lookup Service Allowlist, Federated Learning of Cohorts, Floc Component, Probabilistic Reveal Tokens — component-name → version pairs.

## WWWWW. WebRTC capabilities exhaustive

- **[T]** `RTCRtpSender.getCapabilities('video').codecs` — per codec: `mimeType`, `clockRate`, `numChannels`, `sdpFmtpLine`, `parameters`.
- **[T]** Same for `audio` kind.
- **[T]** `RTCRtpReceiver.getCapabilities` — same axes.
- **[T]** `getCapabilities().headerExtensions` — full RTP extension URI list.
- **[T]** Custom RTP header extensions registered.

## XXXXX. WebRTC SCTP + data channel stats

- **[T]** Per DataChannel: maxRetransmits, maxPacketLifeTime, ordered, protocol, priority, label.
- **[T]** Per SCTP transport: maxChannels, state.
- **[T]** Per data channel send: byte count + packet count over session.

## YYYYY. First-Party-Sets + storage partitioning state

- **[T]** `chrome://first-party-sets/` content.
- **[T]** Per third-party origin embedded in a first-party context: partition key value, partitioned-cookie count, storage partition existence.
- **[T]** Per origin: storage access permission grants from CDP `Storage.getStorageKeyForFrame` introspection.

## ZZZZZ. macOS dictionaries / spell-check / voices

- **[T]** Installed dictionaries — `ls ~/Library/Dictionaries/` + `ls /Library/Dictionaries/`.
- **[T]** Preferred spell-check languages — `defaults read NSGlobalDomain NSPreferredLanguages` + `NSSpellCheckerLanguages`.
- **[T]** Installed speech voices — `say -v ?` count (no content).
- **[T]** Selected speech voice — `defaults read com.apple.speech.synthesis.general.prefs SelectedVoiceName`.

## AAAAAA. Permissions-Policy applied-vs-requested diff

- **[T]** Per frame: requested permissions-policy directives (from `<iframe allow="...">` + Permissions-Policy header) vs effective ones reported by `Page.getPermissionsPolicyState`. Diff surfaces enforcement deltas.

## BBBBBB. macOS network profile / managed config

- **[T]** Managed configuration profiles — `profiles -P -v` (count + sha256 of names; presence indicates MDM-enrolled).
- **[T]** Network locations — `networksetup -listlocations`.
- **[T]** VPN configurations — `networksetup -listallvpns`.
- **[T]** Network priority order — `networksetup -listnetworkserviceorder`.

## CCCCCC. Multi-touch / Magic input device capabilities

- **[T]** Trackpad gesture state — `defaults read com.apple.AppleMultitouchTrackpad` (every gesture toggle).
- **[T]** Magic Mouse buttons — `defaults read com.apple.AppleMultitouchMouse`.
- **[T]** Paired input devices — `system_profiler SPBluetoothDataType` (count + device-type tally).
- **[T]** Trackpad / Mouse haptic feedback strength — `defaults read NSGlobalDomain com.apple.trackpad.forceClick` + `com.apple.trackpad.scaling`.

## DDDDDD. Subresource integrity + report-only violations

- **[T]** Per page: SRI hash mismatches detected (from `Network.responseReceived` + a `SecurityPolicyViolation` event).
- **[T]** CSP report-only directives that would have blocked, but didn't (from CDP `Audits.issueAdded` with `code:'CSPViolation'` + `isReportOnly:true`).

## EEEEEE. Browser ML model versions

- **[T]** Optimization Guide model versions in Local State.
- **[T]** TFLite model versions Chromium has downloaded (passwords leak detector, segmentation models, intent classifier).
- **[T]** ML model load events from `chrome://components/`.

## FFFFFF. Per-origin permission grants exhaustive

- **[T]** Per origin, the resolved state of every Permission API name — geolocation/notifications/push/midi/camera/microphone/background-sync/idle-detection/persistent-storage/payment-handler/screen-wake-lock/system-wake-lock/storage-access/window-management/local-fonts/clipboard-read/clipboard-write/usb/serial/hid/bluetooth/keyboard-lock/pointer-lock/ambient-light-sensor/accelerometer/gyroscope/magnetometer/orientation/proximity (and any others surfaced by `navigator.permissions.query`).
- **[T]** Per origin: how many permissions are "granted" vs "denied" vs "prompt".

## GGGGGG. Network protocol fallback chain

- **[T]** Per connection: h3 attempted vs falling back to h2 vs h1.1 — from NetLog `QUIC_SESSION` events.
- **[T]** Alt-Svc cache state (from `chrome://net-internals/#alt-svc`).
- **[T]** Per host: protocol distribution histogram across all session connections.

## HHHHHH. WebCryptoKey extractability + usage

- **[T]** Per `crypto.subtle.generateKey` call: `extractable` flag + `keyUsages` array — Secure-Enclave-backed iff `extractable:false` and algorithm is ECDSA P-256 on Apple Silicon.
- **[T]** Per key: which key it is — `algorithm.name` + `algorithm.namedCurve` + `algorithm.modulusLength` + `algorithm.hash`.

## IIIIII. Page-side animation frame timing

- **[T]** Distribution of `requestAnimationFrame` callback durations (when the JS work in each frame's rAF callback exceeds 16.67ms it drops frames — drop count is fingerprintable).
- **[T]** Inter-rAF delta distribution (display refresh rate is observable from this).
- **[T]** When tab is hidden, `requestAnimationFrame` throttles to 1Hz — capture this transition.

## JJJJJJ. iframe content reading via CDP across origins

- **[T]** Per OOPIF: separate `Runtime.evaluate` via the child session can read content even across-origin (CDP bypasses SOP for the attached debugger). Per OOPIF, dump `document.documentElement.outerHTML.length`.
- **[T]** Cross-origin iframe IPC events from `Tracing` `disabled-by-default-mojom`.

## KKKKKK. Per-tab state across the browser

- **[T]** Tab count and per-tab URL (when more than the trajectory's tab exists).
- **[T]** Per-tab discarded state (`chrome://discards/`).
- **[T]** Per-tab last-visible time.

## LLLLLL. Page sources of randomness consumed

- **[T]** Every call to `crypto.getRandomValues` — log byte length + return-value sha256 + caller stack.
- **[T]** Every call to `Math.random` — log count + caller stack + first-N return values for determinism replay.
- **[T]** Every `Date.now()` / `performance.now()` call — log return value to enable session replay against the same clock.

## MMMMMM. Page DOM ID + class entropy

- **[T]** Per-page: hash distribution of element id attribute values + class attribute values across the visible DOM. Fingerprints page builder version (e.g. LinkedIn's class naming changes per deploy).
- **[T]** Per-page: sha256 of `document.documentElement.outerHTML` byte stream (deduped, normalized for noise) — quick PASS/FAIL DOM equivalence check.

## NNNNNN. WebView / chrome:// scrape full set

- **[T]** Beyond SSSS list: `chrome://crashes/`, `chrome://dino/`, `chrome://prefs-internals/`, `chrome://safe-browsing/`, `chrome://signed-exchange-internals/`, `chrome://management/`, `chrome://media-engagement/`, `chrome://nacl/`, `chrome://gcm-internals/`, `chrome://invalidations/`, `chrome://identity-internals/`, `chrome://interstitials/`, `chrome://chrome-urls/` (lists every accessible chrome:// page — recursively scrape).

## OOOOOO. CDN + cache attribution per response

- **[T]** Per response: `Server` header value (nginx/cloudflare/cloudfront/akamai/fastly/varnish identification).
- **[T]** Per response: `Via` header (chain of intermediaries).
- **[T]** Per response: `X-Cache`, `X-Cache-Hits`, `Age`, `X-Served-By`, `X-Timer`, `CF-Ray`, `CF-Cache-Status`, `X-Amz-Cf-Id`, `X-Akamai-Edge-Time`, `X-Fastly-Trace`, `X-Vercel-Cache` headers.
- **[T]** Per origin: cached-vs-origin ratio (cache hit rate).
- **[T]** Per response: cache-control directive parsed (max-age, s-maxage, public, private, immutable, no-store, must-revalidate, stale-while-revalidate, stale-if-error).

## PPPPPP. Per-form autocomplete + field metadata

- **[T]** Per `<form>` on page: `action` URL, `method`, `enctype`, `novalidate`, `target`, `autocomplete` attribute.
- **[T]** Per `<input>` / `<textarea>` / `<select>` in each form: `type`, `name`, `autocomplete` value, `required`, `maxlength`, `pattern`, `placeholder`, `inputmode`, `enterkeyhint`, `spellcheck`.
- **[T]** Per `<label>`: associated control id, `for` attribute.

## QQQQQQ. Color profile / display ICC

- **[T]** Per attached display: ICC profile name + sha256 of profile bytes — `system_profiler SPDisplaysDataType` + `colorsync --profile`.
- **[T]** Browser color profile setting — `chrome://settings/colors` configured value.
- **[T]** Per page: `<meta name="color-scheme">` declared values.
- **[T]** Browser-rendered color depth per visual — `screen.colorDepth`, `pixelDepth`, `matchMedia('(color: 8)')` matrix.

## RRRRRR. ARIA + accessibility tree mass

- **[T]** Per page: full a11y tree via CDP `Accessibility.getFullAXTree` already named in C; expand to: per-AX node, role + name + description + value + state + landmark designation.
- **[T]** Per page: ARIA-live region count + politeness distribution.
- **[T]** Per page: ARIA-hidden subtree count + collective node count under aria-hidden.
- **[T]** Reduced motion / high contrast / screen reader presence — `chrome://accessibility/` toggles state.

## SSSSSS. Per-resource hash + content type

- **[T]** Every external `<script src>` URL: sha256 of fetched body (deduped, saved under `recordings/<label>/scripts/`).
- **[T]** Every external `<link rel=stylesheet>`: sha256 of fetched body.
- **[T]** Every external `<img src>` / `<video src>` / `<audio src>`: sha256 (deduped, optional save for the visual-trace bundle).
- **[T]** Per page: total transferred bytes / decoded bytes / compression ratio.

## TTTTTT. Preload-scanner discovery log

- **[T]** Resources the Preload Scanner discovered AND fetched (Resource Timing `initiatorType:'link'` with `transferSize`).
- **[T]** Resources discovered AND NOT fetched (preload candidates that page never used — invisible to standard observation but appears in `Resource Hints` with `initialPriority` set).
- **[T]** Per-resource initiator chain (which script line added each resource).

## UUUUUU. Per-page heap of detached DOM nodes

- **[T]** From HeapProfiler: detached HTMLElement count at session close (memory-leak signature is fingerprintable).
- **[T]** Closure scope leak counts per script.

## VVVVVV. Renderer crash + reload events

- **[T]** Renderer crash count over session (from `Page.crash` event subscription if devtools-attached, else `Inspector.targetCrashed`).
- **[T]** Network service crash count (renderer survives but new network process spawns).
- **[T]** GPU process crash count.
- **[T]** Utility process restart count.

## WWWWWW. Resource budget per Lite Mode / Save Data

- **[T]** `navigator.connection.saveData` state at session start.
- **[T]** Resource decisions made under Save Data — which images downgraded, which preloads skipped.
- **[T]** Server-side Data-Saver-Hint sent per request (HTTPS-Lite proxy is dead but the Save-Data header is fingerprintable).

## XXXXXX. Per-element ARIA + label metadata

- **[T]** For every focusable element: `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-controls`, `role`, `tabindex`.
- **[T]** Effective accessible name (computed per AccName 1.1).

## YYYYYY. Beacon API targets

- **[T]** Every `navigator.sendBeacon(url, data)` call: full URL + body byte count + content-type.
- **[T]** Beacons sent at `pagehide` / `visibilitychange:hidden` boundaries (fingerprint analytics endpoints).

## ZZZZZZ. Clipboard contents (if permission)

- **[T]** If `clipboard-read` permission granted: `navigator.clipboard.read()` ClipboardItem array — per item, MIME types present + per-mime byte sha256.
- **[T]** If `clipboard-write` permission granted: every `write()` / `writeText()` call — content type + byte count.

## AAAAAAA. Cross-trajectory longitudinal fingerprint

- **[T]** For each WSession over time: persist a per-account "fingerprint signature" (rolling sha256 of stable channels: persona, proxy, OS, GPU, screen, locale, UA) into Supabase. Allows pre-trajectory drift detection (account suddenly served from a new fingerprint = burn signal).
- **[T]** Per-account hash chain of inst.json sha256s across N sessions — detects fingerprint drift even when individual sessions look clean.

## BBBBBBB. Browser-emitted telemetry endpoint inventory

- **[T]** Every request to known browser telemetry hosts (`clients2.google.com`, `clientservices.googleapis.com`, `update.googleapis.com`, `optimizationguide-pa.googleapis.com`, `chromewebstore.googleapis.com`, `safebrowsing.googleapis.com`) — surface presence + frequency; absence is itself a fingerprint (vanilla Chrome always sends these).
- **[T]** Per telemetry endpoint: request body size distribution.
- **[T]** Per telemetry endpoint: response handled correctly (404/200/etc.).

## CCCCCCC. Per-page Storage Access consent state

- **[T]** `document.hasStorageAccess()` result at every page state change.
- **[T]** Storage Access API permission decisions: granted/denied/prompt + persistence.

## DDDDDDD. Color font / OpenType variable axis support

- **[T]** Variable font axes presence — for each loaded font, `CSSFontFaceRule.fontVariationSettings` + `Document.fonts.check('1em SomeVarFont', 'A')`.
- **[T]** Color font (COLRv1 / sbix) support test — render a known color emoji glyph, hash output.

## EEEEEEE. SVG + canvas filter rendering matrix

- **[T]** Apply known SVG filter chain (`feGaussianBlur` + `feColorMatrix` + `feComposite` + `feMorphology` + `feDisplacementMap` + `feFlood`) to known input, rasterize, hash.
- **[T]** Apply CSS `filter: ...` chain (blur, brightness, contrast, drop-shadow, grayscale, hue-rotate, invert, opacity, saturate, sepia) to known div, capture pixel bytes via canvas readback, hash.

## FFFFFFF. Compression + parsing edge cases

- **[T]** Per response served with `gzip` / `br` / `zstd` encoding: actual decompression CPU time delta (CPU-cost fingerprint).
- **[T]** Per response: byte-stream size before vs after decompression ratio.
- **[T]** Per HTML response: tokenizer state machine duration (from Tracing `disabled-by-default-blink.feature_usage`).

## GGGGGGG. CookieJar partition key inventory

- **[T]** Per partition key: total cookies stored, per-domain cookie distribution.
- **[T]** Cross-partition leak attempts — any cookie set with a partition key that conflicts with the requesting site.

## HHHHHHH. WebGL + WebGPU error count

- **[T]** Per WebGL context: `getError()` polled after every major draw — error count over session.
- **[T]** Per WebGPU device: `uncapturedError` event log.
- **[T]** WGSL shader compilation errors with full message body.

## IIIIIII. PerformanceLongAnimationFrame (LoAF)

- **[T]** Every `PerformanceObserver({type:'long-animation-frame'})` entry: duration, scripts[] with sourceURL + invoker + executionStart.
- **[T]** Total blocking time per page state.

## JJJJJJJ. Document picture-in-picture window state deep

- **[T]** Per PiP window: dimensions, position, document.documentElement.outerHTML snapshot.
- **[T]** PiP transition events: enter, exit, resize.

## KKKKKKK. Per-script execution context fingerprint

- **[T]** Per script (from `Debugger.scriptParsed`): execution context ID + auxData (isDefault, type) + frame ancestry chain.
- **[T]** Module vs classic-script counts.
- **[T]** Worklet contexts (paint/audio/animation/layout) — per-worklet script source sha256.

## LLLLLLL. Frame timing skew via repeated paint

- **[T]** Paint timing entry distribution per frame across the session.
- **[T]** Skew between `performance.now()` and CSS animation `currentTime` at frame boundary.

## MMMMMMM. Per-event isTrusted distribution

- **[T]** For every dispatched event captured: `isTrusted` flag + dispatch path (`composedPath`). Automation generally produces `isTrusted:false` unless using CDP Input.* or weles' nativeClick path.
- **[T]** Distribution histogram of `isTrusted:true` vs `false` events per session.

## NNNNNNN. Per-frame visibility transitions

- **[T]** `IntersectionObserver` on every frame at `[0, 0.1, 0.25, 0.5, 0.75, 1.0]` thresholds → per-frame visibility timeline.
- **[T]** ViewportObserver count + activation timeline.

## OOOOOOO. macOS hot corner / Mission Control state

- **[T]** Hot corner actions — `defaults read com.apple.dock wvous-bl-corner wvous-br-corner wvous-tl-corner wvous-tr-corner`.
- **[T]** Mission Control / Expose state — `defaults read com.apple.dock mcx-expose-disabled`.
- **[T]** Spaces count + per-space app assignment — `defaults read com.apple.spaces`.

## PPPPPPP. macOS clipboard + drag state

- **[T]** Pasteboard count (NSPasteboardGeneralName) + per-board content type list — `pbpaste -Prefer txt | wc -c` (count only, no content).
- **[T]** Drag pasteboard active count.

## QQQQQQQ. Per-page Storage Access requestStorageAccessFor

- **[T]** Every `document.requestStorageAccessFor(origin)` call: origin + outcome (granted/denied/prompt).
- **[T]** Every `document.requestStorageAccess({all: true})` outcome.
- **[T]** Storage Access API headers — `Sec-Fetch-Storage-Access` value per outgoing request.

## RRRRRRR. ServiceWorker fetch interception overhead

- **[T]** Per SW-intercepted fetch: ServiceWorker fetch event start to network fetch start delta.
- **[T]** SW respondWith() resolution latency distribution.
- **[T]** SW navigation preload hit/miss per page.
- **[T]** Worker → main thread postMessage round-trip latency distribution.

## SSSSSSS. BroadcastChannel + Web Locks per-channel

- **[T]** Every BroadcastChannel: name + post count + payload byte distribution.
- **[T]** Every Web Lock held: name + mode (shared/exclusive) + duration + steal events.
- **[T]** Per-channel postMessage origin allowlist + counts.

## TTTTTTT. Per-host connection reuse + pool state

- **[T]** Per host: max simultaneous connections used in session.
- **[T]** Per host: connection-reuse count vs new-connection count.
- **[T]** Per host: HTTP/2 stream multiplexing depth distribution.
- **[T]** Connection close reasons per pool (idle timeout, server close, GOAWAY, error).

## UUUUUUU. Browser auto-update + component update events

- **[T]** Browser update check fired count per session (from NetLog `update.googleapis.com` requests).
- **[T]** Component install/update events per session (Widevine version bump, etc.).
- **[T]** Variation seed refresh events from `clients2.google.com`.

## VVVVVVV. View Transitions API usage

- **[T]** Every `document.startViewTransition(callback)` call: transition phase log (transitionStart, transitionEnd, transitionAbort).
- **[T]** ViewTransition tree snapshot at transitionStart.
- **[T]** Cross-document view transitions (recent) — every `@view-transition` declaration in CSS + outcome.

## WWWWWWW. HTTP redirect chain + cache key

- **[T]** Per request that redirected: full chain (302/301/307/308 hops, every Location header), final URL.
- **[T]** Per cached resource: cache key composition (URL + Vary header dimensions resolved + partition key).
- **[T]** Per Vary response: which client headers compose the cache key (Origin, User-Agent, Accept-Language, etc.).

## XXXXXXX. Memory pressure level transitions

- **[T]** CDP `Memory.pressureLevelChange` events per session: timestamp + new level (None/Moderate/Critical).
- **[T]** OS memory pressure — macOS `sysctl kern.memorystatus_vm_pressure_level`.
- **[T]** Per-renderer-process memory pressure response (tab discards, freezes).

## YYYYYYY. Per-Chromium-child cumulative CPU + RSS

- **[T]** Per child process: cumulative cpu_time from `SystemInfo.getProcessInfo` polled every 10s — total CPU consumed over session.
- **[T]** Per child: max resident_size observed (peak RSS).
- **[T]** Per child: total faults + page-ins delta over session.

## ZZZZZZZ. GPU command buffer + submit metrics

- **[T]** GPU process: command buffer submit count from Tracing `gpu` category.
- **[T]** GPU process: per-command-type submit count (draw, compute dispatch, copy, etc.).
- **[T]** GPU process: GPU-side scheduler queue depth over session.

## AAAAAAAA. Browser idle vs busy period histogram

- **[T]** Browser idle periods detected from `requestIdleCallback` deadline-remaining values + Tracing `disabled-by-default-cpu_profiler.runtime_stats`.
- **[T]** Cumulative idle vs busy time per session.

## BBBBBBBB. JS heap snapshot retained-size by constructor

- **[T]** From HeapProfiler snapshot at session close: per top-level constructor (Function/Promise/RegExp/Error/Array/Object/Map/Set/HTMLElement/etc.), total instance count + retained size.
- **[T]** Largest 100 retainers by retained size.
- **[T]** Detached DOM subtrees identified by retainer chain (already named in UUUUUU; here deeper — full subtree dump).

## CCCCCCCC. Per-extension content script injection

- **[T]** MutationObserver on `document.documentElement.childList` watching for nodes added by extensions post-DOMContentLoaded — log each (tagName, src, classList, id).
- **[T]** Detection of isolated-world scripts via `chrome.runtime.id` checks on detected nodes.

## DDDDDDDD. COEP / COOP report deliveries

- **[T]** Per page: every `coep-report` / `coop-report` payload from ReportingObserver — body, type, url.
- **[T]** Cross-origin embedder/opener decisions per frame.

## EEEEEEEE. Worklet pool population per frame

- **[T]** Per frame, per worklet type (animation/layout/paint/audio): which worklets are registered, their scriptURL sha256, output graph.

## FFFFFFFF. ServiceWorker lifecycle event counts

- **[T]** Per SW: install/activate/fetch/message/sync/push/notificationclick/notificationclose handler invocation counts.
- **[T]** Per SW: skipWaiting()/clients.claim() call counts and outcomes.
- **[T]** Per SW update: old-vs-new script content sha256 + dependent imports diff.

## GGGGGGGG. fetch() option distribution

- **[T]** Per `fetch(url, init)` call: full init object — method, headers, body presence, mode (cors/no-cors/same-origin/navigate), credentials (omit/same-origin/include), cache (default/no-store/reload/no-cache/force-cache/only-if-cached), redirect (follow/error/manual), referrer + referrerPolicy, integrity, keepalive, signal-bound (yes/no).
- **[T]** Distribution histograms across the session per option dimension.

## HHHHHHHH. Per-response cookie modification log

- **[T]** Every `Set-Cookie` header in every response — name (sha256'd), domain, path, expires, max-age, secure, httpOnly, sameSite, partitioned.
- **[T]** Per origin: cumulative Set-Cookie count over session.

## IIIIIIII. COEP enforcement decisions per request

- **[T]** Per outgoing request: was it blocked due to COEP enforcement? (from CDP `Network.loadingFailed` with `blockedReason:'CoepFrameResourceNeedsCoepHeader'`).
- **[T]** Per response: was it transformed by COEP (cross-origin-embedder-policy header injection)?

## JJJJJJJJ. Mixed content presence + upgrades

- **[T]** Per page: mixed-content warnings (active + passive).
- **[T]** Per resource: HSTS-upgrade applied (http→https) vs not.
- **[T]** Per resource: CSP `upgrade-insecure-requests` directive applied vs not.

## KKKKKKKK. Per Chromium utility process: which service

- **[T]** For each pid in `SystemInfo.getProcessInfo` with `type:'Utility'`: service name from `chrome://process-internals/` (network_service, audio_service, video_capture, storage_service, data_decoder, etc.).
- **[T]** Per service: cpu_time + memory.

## LLLLLLLL. macOS Time Machine / iCloud Drive state

- **[T]** Time Machine status — `tmutil status` + last backup time.
- **[T]** iCloud Drive sync state — `defaults read com.apple.bird` + `brctl status` (count of synced items).
- **[T]** iCloud Drive enabled — `defaults read MobileMeAccounts iCloudDriveEnabled`.

## MMMMMMMM. macOS Keychain access events

- **[T]** Per session: number of times Chromium accessed login.keychain — `log show --last 5m --predicate 'subsystem == "com.apple.securityd"'` (count, no contents).
- **[T]** Per session: number of Touch ID / Apple Watch unlock challenges.

## NNNNNNNN. macOS dock + menu bar state

- **[T]** Dock items count + names (`defaults read com.apple.dock persistent-apps`).
- **[T]** Dock orientation + size — `defaults read com.apple.dock orientation` + `tilesize`.
- **[T]** Dock auto-hide state — `defaults read com.apple.dock autohide`.
- **[T]** Menu bar extras count + identifier list — `defaults read NSGlobalDomain NSStatusItemSpacing` + `NSStatusItemSelectionPadding`.

## OOOOOOOO. macOS APNS + push state

- **[T]** APNS daemon process state — `ps -ef | grep apsd`.
- **[T]** APSD connection state — `log show --last 1m --predicate 'process == "apsd"'` (count).
- **[T]** Web Push registration count per origin.

## PPPPPPPP. AdAuction + Protected Audience

- **[T]** Per `navigator.runAdAuction(config)` call: full config + outcome (winner URN + bid + auction time).
- **[T]** Per FLEDGE/Protected Audience worklet: scoring + bidding logic source sha256.
- **[T]** Interest group joined/left events per origin.

## QQQQQQQQ. CSS rule type distribution

- **[T]** Per stylesheet: rule count by type — `CSSStyleRule`, `CSSMediaRule`, `CSSKeyframesRule`, `CSSFontFaceRule`, `CSSImportRule`, `CSSSupportsRule`, `CSSContainerRule`, `CSSLayerBlockRule`, `CSSScopeRule`, `CSSStartingStyleRule`, `CSSPropertyRule`, `CSSCounterStyleRule`, `CSSNamespaceRule`, `CSSPageRule`, `CSSFontFeatureValuesRule`, `CSSFontPaletteValuesRule`, `CSSPositionTryRule`, `CSSViewTransitionRule`.
- **[T]** Per `@font-face`: src URLs + unicode-range + descriptors.
- **[T]** Per `@container`: container-name + container-type.

## RRRRRRRR. HTMLImageElement / picture detail

- **[T]** Per `<img>`: `src`, `srcset` entries, `sizes`, `currentSrc`, `naturalWidth`, `naturalHeight`, `decoding` (sync/async/auto), `loading` (eager/lazy), `crossorigin`, `referrerpolicy`, `fetchpriority`.
- **[T]** Per `<picture>`: `<source>` count + per-source media/type/srcset/sizes; selected `<source>` index.

## SSSSSSSS. Custom Elements + Web Components state

- **[T]** `customElements.get` enumeration — every registered custom element name + constructor name + `observedAttributes`.
- **[T]** `customElements.whenDefined` pending registrations.
- **[T]** Per shadow root: mode (open/closed), slot count, delegatesFocus, slotAssignment.

## TTTTTTTT. Content Security Policy resolved per resource

- **[T]** Per resource loaded: which CSP directive permitted it (script-src, style-src, img-src, etc.).
- **[T]** Per resource blocked by CSP: directive + source value matched.
- **[T]** Per CSP: nonce + hash sources used count.

## UUUUUUUU. Per-WebSocket frame timing

- **[T]** Per frame on every WebSocket: send-time, receive-time, opcode, payload-len, mask flag (from decoded pcap).
- **[T]** Per-frame inter-arrival delta (used by signaling-protocol classifiers).
- **[T]** Sec-WebSocket-Protocol subprotocol negotiated per connection.

## VVVVVVVV. DataTransfer drag-and-drop events

- **[T]** Every drag event (`dragstart`, `dragenter`, `dragover`, `dragleave`, `drop`, `dragend`): DataTransfer.items types[] + files count + effectAllowed + dropEffect.
- **[T]** Per drag: source element selector + drop target selector.

## WWWWWWWW. Clipboard event capture

- **[T]** Every `paste`/`copy`/`cut` event: ClipboardEvent.clipboardData.types[] + per-type byte count (no content).
- **[T]** Synthetic vs user-initiated clipboard events (`isTrusted` flag).

## XXXXXXXX. history.pushState / replaceState log

- **[T]** Every `history.pushState(state, title, url)` call: serialized state + URL.
- **[T]** Every `history.replaceState` call: same.
- **[T]** Every `popstate` event fired: associated state.

## YYYYYYYY. PerformanceNavigationTiming per-phase

- **[T]** From the navigation entry: `unloadEventStart/End`, `redirectStart/End`, `fetchStart`, `domainLookupStart/End`, `connectStart/End`, `secureConnectionStart`, `requestStart`, `responseStart/End`, `domInteractive`, `domContentLoadedEventStart/End`, `domComplete`, `loadEventStart/End`, `transferSize`, `encodedBodySize`, `decodedBodySize`, `nextHopProtocol`, `serverTiming[]`, `redirectCount`, `criticalCHRestart`.

## ZZZZZZZZ. Document Picture-in-Picture cross-window IPC

- **[T]** Per PiP window: postMessage exchanges with main document — count + payload size distribution.
- **[T]** PiP `requestWindow` capability + outcome.
- **[T]** PiP window lifecycle event log (`pagehide`, `pageshow`, focus, blur).

## AAAAAAAAA. PaintWorklet + AudioWorklet execution

- **[T]** Per registered PaintWorklet: invocation count + output canvas pixel hash per invocation.
- **[T]** Per AudioWorkletNode: process() invocation count + accumulated CPU time.
- **[T]** Per LayoutWorklet (when shipped): invocation count.

## BBBBBBBBB. Per-form FormData iteration

- **[T]** On form submit: `new FormData(form)` iteration — every entry name (sha256'd) + entry value type (string/File/Blob) + entry size.
- **[T]** Submission method (XHR/fetch/navigation).

## CCCCCCCCC. HTMLDialogElement lifecycle

- **[T]** Per `<dialog>` element: `show()`/`showModal()`/`close()` call log + dialog returnValue.
- **[T]** Per `<dialog>`: cancel/close event fired.

## DDDDDDDDD. details/summary toggle history

- **[T]** Per `<details>` element: every `open` attribute change with timestamp.
- **[T]** `toggle` event log per `<details>`.

## EEEEEEEEE. ARIA-live region announcement queue

- **[T]** For every `aria-live` region: text content changes over session (with timestamp).
- **[T]** Politeness (off/polite/assertive) per region.

## FFFFFFFFF. IntersectionObserver / ResizeObserver registration detail

- **[T]** Per registered IntersectionObserver: rootMargin + threshold list + root selector.
- **[T]** Per ResizeObserver: target selectors + box type (border-box/content-box/device-pixel-content-box).

## GGGGGGGGG. Element transform chain

- **[T]** Per visible element: full CSS `transform` matrix + `transform-origin` + 3D rendering context.
- **[T]** Cumulative transform from root to leaf for sampled elements (composite transform identifies device-pixel snapping rules).

## HHHHHHHHH. CSS state transition log

- **[T]** Per element: `:hover` / `:focus` / `:focus-within` / `:focus-visible` / `:active` / `:visited` (cross-origin restricted) state-transition log.
- **[T]** Per element: `:checked` / `:disabled` / `:enabled` / `:read-only` / `:placeholder-shown` state-transition log.

## IIIIIIIII. Per-form-control value-change events

- **[T]** Per `<select>`: option count + selected index changes.
- **[T]** Per `<input type=range>`: value/step/min/max changes.
- **[T]** Per `<input type=color>`: value changes.
- **[T]** Per `<input type=date|time|datetime-local|month|week>`: parsed value changes.
- **[T]** Per `<input type=file>`: selected file count + total size + per-file MIME.

## JJJJJJJJJ. Media element state stream

- **[T]** Per `<video>` / `<audio>` element: `currentTime`, `duration`, `playbackRate`, `volume`, `muted`, `paused`, `played` ranges, `seekable` ranges, `buffered` ranges, `readyState`, `networkState` polled every 1s.
- **[T]** Per media element: events log (`loadstart`/`loadeddata`/`canplay`/`canplaythrough`/`play`/`pause`/`seeking`/`seeked`/`waiting`/`stalled`/`ended`/`error`/`abort`/`emptied`/`durationchange`/`timeupdate`/`ratechange`/`volumechange`).
- **[T]** Per element: `presentationMode` (inline/PiP/fullscreen).

## KKKKKKKKK. CSS transition events

- **[T]** Every `transitionstart`/`transitionrun`/`transitionend`/`transitioncancel` event: target selector + propertyName + elapsedTime + pseudoElement.

## LLLLLLLLL. CSS animation events

- **[T]** Every `animationstart`/`animationiteration`/`animationend`/`animationcancel` event: target selector + animationName + elapsedTime + pseudoElement.

## MMMMMMMMM. Speculation rules detail

- **[T]** Per page: every `<script type="speculationrules">` parsed JSON — prefetch/prerender targets + eagerness + score.
- **[T]** Prerender activation events with timing (`prerenderingchange`).
- **[T]** Prefetch hits/misses per speculation target.

## NNNNNNNNN. Edge measurement: timing-attack primitives

- **[T]** `performance.measureUserAgentSpecificMemory()` result (cross-origin-isolated only).
- **[T]** `Atomics.wait` wakeup timing across SharedArrayBuffer.
- **[T]** Tree-shaking timing of `requestAnimationFrame` skews under heavy CPU load.

## OOOOOOOOO. iOS-device fingerprint (when running via WDA over WiFi)

- **[T]** iPhone serial + UDID (sha256'd) — from WDA `/wda/device/info`.
- **[T]** iOS version + build (`ProductVersion` + `BuildVersion`).
- **[T]** Device model identifier (`iPhone15,2`).
- **[T]** Battery percentage + charge state — `/wda/batteryInfo`.
- **[T]** Locale + timezone — `/wda/device/info` country/locale fields.
- **[T]** Screen size + DPR.
- **[T]** Installed app list via pymobiledevice3 `apps list` (count + bundle-id sha256).

## PPPPPPPPP. Inter-process Mojo message rates

- **[T]** From Tracing `disabled-by-default-mojom`: per-interface message count over session, top N interfaces by message volume.
- **[T]** Per-pipe peak depth (interface_provider, network_context, frame_host, etc.).

## QQQQQQQQQ. CDM (Encrypted Media) deep

- **[T]** Per `MediaKeys` instance: server certificate sha256.
- **[T]** Per `MediaKeySession`: key statuses, expirations, key IDs (count only — not IDs).
- **[T]** Per CDM operation: time to first response.

## RRRRRRRRR. Compute Pressure observer

- **[T]** `PressureObserver({source:'cpu'}).observe` — every state change (`nominal`/`fair`/`serious`/`critical`) with timestamp.
- **[T]** Source `gpu` if shipped — same.
- **[T]** Per state: duration spent in that state over session.

## SSSSSSSSS. Per-tab document policy + permissions policy resolved diff

- **[T]** For every cross-document navigation: snapshot the resolved Permissions-Policy / Document-Policy at landing time vs at unload time.

## TTTTTTTTT. PerformanceMark + measure namespace

- **[T]** Every `performance.mark(name, options)` call: full name + detail + startTime.
- **[T]** Every `performance.measure(name, opts)` call: full args.
- **[T]** Per page: per-mark cumulative count + per-measure cumulative count + per-namespace (page-author / Chromium-internal) attribution.

## UUUUUUUUU. Per-canvas allocation footprint

- **[T]** Per `<canvas>` element creation: width × height × 4 bytes (RGBA) memory cost.
- **[T]** Per OffscreenCanvas: same.
- **[T]** Per ImageBitmap created: source + size.

## VVVVVVVVV. window.opener / cross-window references

- **[T]** `window.opener` non-null check + same-origin check.
- **[T]** `window.parent` / `window.top` cross-origin gating state.
- **[T]** Every `window.open()` call: URL + windowName + features string.

## WWWWWWWWW. console-via-CSP-blocked

- **[T]** Console errors emitted as a result of CSP violations.
- **[T]** Console errors emitted from Permissions-Policy denials.
- **[T]** Console errors emitted from cross-origin-isolated requirement failures.

## XXXXXXXXX. window.crossOriginIsolated / SharedArrayBuffer access count

- **[T]** Number of `SharedArrayBuffer` constructions per session.
- **[T]** Number of `Atomics.wait` calls + average wait duration.
- **[T]** Cross-window SAB transfer attempts (allowed iff isolated).

## YYYYYYYYY. ResizeObserver + IntersectionObserver delivery rate

- **[T]** Per observer: callback fire rate over session.
- **[T]** Coalesced-entry count vs fired-callback count (Chrome batches entries).

## ZZZZZZZZZ. Per-frame paint quad change rate

- **[T]** From Tracing `disabled-by-default-devtools.timeline.frame`: paint invalidation rect distribution + per-frame paint count.
- **[T]** Frame drop count over session.

## AAAAAAAAAA. macOS DiskArbitration events

- **[T]** Disk mount/unmount events during session — `diskutil activity` 10s sample.
- **[T]** Per-attached volume: filesystem type, mount options, owners-enabled, journaled, encrypted, UUID (sha256'd).
- **[T]** Volume insertion / ejection events from `log show --predicate 'subsystem=="com.apple.diskarbitrationd"' --last 5m`.

## BBBBBBBBBB. macOS power assertions

- **[T]** `pmset -g assertions` — every active power assertion (what's preventing sleep): process name + assertion type (PreventUserIdleSystemSleep / PreventSystemSleep / NoIdleSleepAssertion / PreventUserIdleDisplaySleep / UserIsActive).
- **[T]** Power-source state transitions during session (battery ↔ AC).
- **[T]** Display sleep / wake events during session.

## CCCCCCCCCC. macOS desktop wallpaper + theme

- **[T]** Desktop wallpaper path + sha256 of bytes — `osascript -e 'tell application "Finder" to get POSIX path of (get desktop picture as alias)'` (blocked under osascript ban; alternative: `defaults read com.apple.desktop` parses Background plist).
- **[T]** macOS appearance — `defaults read NSGlobalDomain AppleInterfaceStyle` (Dark/Light absence-or-presence).
- **[T]** Accent color — `defaults read NSGlobalDomain AppleAccentColor`.
- **[T]** Highlight color — `defaults read NSGlobalDomain AppleHighlightColor`.

## DDDDDDDDDD. macOS window server enumeration

- **[T]** `CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID)` via N-API binding — per window: ownerName, ownerPID, layer, bounds, alpha, sharingType, isOnScreen.
- **[T]** Total visible-window count.
- **[T]** Per-app window count.
- **[T]** Foreground app pid + name.

## EEEEEEEEEE. macOS Sharing preferences

- **[T]** File Sharing enabled — `launchctl print system/com.apple.smbd`.
- **[T]** Screen Sharing / Remote Management — `launchctl print system/com.apple.screensharing`.
- **[T]** Remote Login (SSH) — `systemsetup -getremotelogin`.
- **[T]** AirDrop discoverable mode — `defaults read com.apple.sharingd DiscoverableMode`.
- **[T]** Bluetooth Sharing — `defaults read com.apple.Bluetooth PrefKeyServicesEnabled`.

## FFFFFFFFFF. macOS Wi-Fi RF environment

- **[T]** Surrounding Wi-Fi networks in range — `airport -s` count (no SSIDs surfaced).
- **[T]** Wi-Fi channel utilization — `airport -I` channel + signal-to-noise.
- **[T]** Wi-Fi country code — `airport -I | grep "country code"`.

## GGGGGGGGGG. macOS Bluetooth LE scan environment

- **[T]** BLE devices discoverable from this Mac — count only via `system_profiler SPBluetoothDataType` paired devices.
- **[T]** Bluetooth adapter MAC + power state + discoverable state.

## HHHHHHHHHH. macOS NSUserDefaults full enumeration

- **[T]** `defaults domains` — full list of preference domains installed on the device (count + sha256 of names).
- **[T]** Per-domain `defaults read <domain>` size in bytes (no contents).

## IIIIIIIIII. launchd job per-state inventory

- **[T]** `launchctl list` full — every loaded job: label, last exit code, pid (or `-` if not running).
- **[T]** Per-job state distribution (running / idle / failed).
- **[T]** User-domain agents vs system-domain daemons count.

## JJJJJJJJJJ. WebRTC ICE candidate gather + type breakdown

- **[T]** Per RTCPeerConnection: gather-time delta (createOffer start → all candidates) per candidate type.
- **[T]** Per connection: host / srflx / relay / prflx candidate counts; relay-only forced (TURN-only) state.
- **[T]** Per candidate: priority value + foundation + protocol (UDP/TCP/TLS).

## KKKKKKKKKK. HTML5 form constraint validation events

- **[T]** Every `invalid` event fired on form controls (validation message + constraint that failed).
- **[T]** `form.checkValidity()` / `reportValidity()` call log.
- **[T]** Per-input: `validity` flags (badInput, customError, patternMismatch, rangeOverflow/Underflow, stepMismatch, tooLong, tooShort, typeMismatch, valueMissing).

## LLLLLLLLLL. Per-element typing-hint attributes

- **[T]** Per `<input>`/`<textarea>`: `enterkeyhint`, `inputmode`, `autocapitalize`, `autocorrect`, `spellcheck`, `autocomplete`, `name`, `id`, `placeholder`, `data-*` attribute set.
- **[T]** Detection of `<input autocomplete="one-time-code">` (WebOTP triggers).

## MMMMMMMMMM. HTML parser yield events

- **[T]** From Tracing `disabled-by-default-blink.feature_usage`: per page, the HTML parser yield event count + yield reason distribution.
- **[T]** Time spent in HTMLDocumentParser per page vs idle vs in JS execution.

## NNNNNNNNNN. V8 compile/optimize/deopt detail per function

- **[T]** From Tracing `disabled-by-default-v8.runtime_stats`: per top-N functions, compile / optimize / deopt counts.
- **[T]** Deopt reasons distribution (TypeMismatch / OutOfBounds / WrongCallTarget / etc.).
- **[T]** Inline cache transitions per call site.
- **[T]** Bailout-to-baseline counts.

## OOOOOOOOOO. BFCache eligibility reasons

- **[T]** From CDP `Page.backForwardCacheNotUsed`: per non-eligible navigation, the full `notRestoredExplanations` list with `reason` + `type` + `context`.
- **[T]** Per session: bfcache hit-rate.
- **[T]** Per page: bfcache blockers (unload listeners, BroadcastChannel handlers, IndexedDB transactions in flight, etc.).

## PPPPPPPPPP. CHIPS cookie partitioning eligibility

- **[T]** Per Set-Cookie: was `Partitioned;` attribute set? Was it required (third-party context)? Was it stripped?
- **[T]** Per origin: partitioned-vs-unpartitioned cookie count.

## QQQQQQQQQQ. FedCM / Digital Credentials API

- **[T]** `navigator.credentials.get({identity: {providers: [...]}})` calls + outcomes.
- **[T]** `navigator.credentials.get({digital: ...})` (Digital Credentials API — recent) calls + outcomes.
- **[T]** IdP login status set via `navigator.login.setStatus()` per origin.

## RRRRRRRRRR. Web App Manifest detail

- **[T]** Per page with a manifest: full manifest JSON (name, short_name, description, start_url, display, orientation, theme_color, background_color, icons array, scope, related_applications, prefer_related_applications, shortcuts, screenshots, share_target, file_handlers, protocol_handlers).
- **[T]** Per icon: src + sizes + type + purpose (any/monochrome/maskable).

## SSSSSSSSSS. Cross-Site Cookies blocked reasons

- **[T]** Per blocked cookie (via `Network.requestWillBeSentExtraInfo.associatedCookies[].blockedReasons[]` + `Network.responseReceivedExtraInfo.blockedCookies[].blockedReasons[]`): reason list (SameSiteUnspecifiedTreatedAsLax / SameSiteNoneInsecure / UserPreferences / ThirdPartyPhaseout / etc.).

## TTTTTTTTTT. Origin Trial tokens used per page

- **[T]** Per page: every Origin Trial token (from `<meta http-equiv="origin-trial">` + `Origin-Trial:` response headers).
- **[T]** Per token: decoded fields (origin, feature, expiry).
- **[T]** Token use status from `chrome://origin-trials/`.

## UUUUUUUUUU. Network Anonymization Key state

- **[T]** Per outgoing request: Network Anonymization Key (NAK) value — partitions the connection by (top-frame-site, frame-site, cross-site-flag).
- **[T]** Per connection pool: NAK distribution.
- **[T]** Same-NAK reuse stats.

## VVVVVVVVVV. Chromium snapshot file + V8 binary blobs

- **[T]** sha256 of `snapshot_blob.bin` / `v8_context_snapshot.bin` in the Chromium framework dir.
- **[T]** sha256 of `icudtl.dat`.
- **[T]** sha256 of `resources.pak`, `chrome_100_percent.pak`, `chrome_200_percent.pak`.

## WWWWWWWWWW. Embedder Skia / ANGLE / Dawn versions

- **[T]** Skia git revision — embedded in `chrome://version/` Skia field.
- **[T]** ANGLE git revision — `chrome://gpu/` ANGLE commit.
- **[T]** Dawn (WebGPU) git revision — `chrome://gpu/` Dawn commit.
- **[T]** Embedded V8 git revision — `chrome://version/` V8 field.

## XXXXXXXXXX. Per-PerformanceObserver namespace registration

- **[T]** Per page: every `PerformanceObserver` registered — supported entry types observed, buffered mode flag, `durationThreshold` (event-timing only).
- **[T]** Per observer: callback fire count + entries delivered count over session.

## YYYYYYYYYY. macOS-specific App Sandbox profile per Chromium child

- **[T]** Per Chromium child pid: `ps -o sandbox= -p <pid>` — sandbox profile name applied (e.g. `app/chrome-renderer`, `app/com.google.Chrome.helper`, `kBrowserHelperSandboxProfile`).
- **[T]** Per Chromium child: codesigning team identifier + bundle identifier inherited from parent.

## ZZZZZZZZZZ. Calendaring + reminders presence (counts only)

- **[T]** Calendar account count — `defaults read com.apple.iCal | grep CalDAVAccount | wc -l`.
- **[T]** Reminders.app data count via TCC permission state (no content).
- **[T]** Mail accounts count — `defaults read MobileMeAccounts AccountID | wc -l`.

## AAAAAAAAAAA. Audio output route preference

- **[T]** Current audio output device — `SwitchAudioSource -c` (or `system_profiler SPAudioDataType`).
- **[T]** Current audio input device — `SwitchAudioSource -t input -c`.
- **[T]** Audio device priority list — `defaults read com.apple.Music.AppleMusicLab AudioDeviceUID`.

## BBBBBBBBBBB. Ad-blocker activation state

- **[T]** Per page: known ad/tracker URLs that fired vs were blocked (compare Resource Timing entries against EasyList canonical hosts).
- **[T]** Per page: detection of in-page anti-adblock scripts via DOM query.
- **[T]** Per session: ratio of blocked-vs-fired tracker requests (presence of any blocking is itself a fingerprint).

## CCCCCCCCCCC. Tracking-protection state

- **[T]** Chrome's tracking-protection setting — from Local State JSON `tracking_protection.enabled`.
- **[T]** Per page: third-party cookies blocked count (from CDP `Audits.issueAdded` Cookie issues).
- **[T]** First-Party Set membership boundary crossings.

## DDDDDDDDDDD. Per-request privacy signals

- **[T]** Per outgoing request: `Sec-Purpose` header (prefetch / prerender variants).
- **[T]** Per outgoing request: `Sec-Browsing-Topics` header value (Topics API).
- **[T]** Per outgoing request: `DNT` header value (legacy).
- **[T]** Per outgoing request: `Sec-GPC` (Global Privacy Control) header.
- **[T]** Per outgoing request: `Sec-Cookie-Header-Compat-Mode` (deprecated but still seen).

## EEEEEEEEEEE. theme-color + meta resolution chain

- **[T]** Per page: full `<meta name="theme-color">` list with media-query qualifiers.
- **[T]** Per page: effective theme color resolved at session start.
- **[T]** Per page: `<meta name="color-scheme">` value.
- **[T]** Per page: `<meta name="viewport">` parsed (width/height/initial-scale/maximum-scale/minimum-scale/user-scalable/viewport-fit).

## FFFFFFFFFFF. ImageDecoder bytes decoded

- **[T]** Per session: total ImageDecoder bytes decoded by format (PNG/JPEG/WebP/AVIF/GIF/BMP/ICO).
- **[T]** Per format: per-image average decode time.
- **[T]** Hardware-accelerated decode hits per format.

## GGGGGGGGGGG. NetworkContext exit reasons

- **[T]** From NetLog: per-NetworkContext lifetime, end reason (browser shutdown / explicit destroy / error).
- **[T]** Per partition: how many NetworkContexts were created (Storage Partitioning creates one per partition).

## HHHHHHHHHHH. PreconnectManager events

- **[T]** From NetLog: per `<link rel=preconnect>`, time-to-connect + connection-reused-or-new.
- **[T]** Speculative preconnect events fired by Chromium itself (not in HTML).

## IIIIIIIIIII. HTTP cache transaction state distribution

- **[T]** From NetLog: per `URL_REQUEST`, HTTP cache state transitions (CACHE_OPEN_ENTRY / CACHE_READ_RESPONSE / CACHE_VALIDATE / CACHE_DOOM_ENTRY).
- **[T]** Per session: cache hit / miss / not-cacheable / not-modified-revalidation counts.

## JJJJJJJJJJJ. PerformanceMark detail field

- **[T]** Per mark: arbitrary `detail` field content sha256 (often contains correlation IDs, A/B test bucket assignments, internal site versions — high-entropy site-specific fingerprint).
- **[T]** Per measure: detail field same treatment.

## KKKKKKKKKKK. ServiceWorker bytecode cache

- **[T]** Per SW script load: was it served from V8 code cache? (parse time near 0).
- **[T]** Per SW: total code-cache bytes consumed.
- **[T]** SW update path code-cache invalidation events.

## LLLLLLLLLLL. HTTP DownloadResource events

- **[T]** Per session: every download initiated — URL, suggestedFilename, MIME, total bytes.
- **[T]** Per download: state transitions (begin / progress / cancel / complete / interrupted).
- **[T]** Save-As dialog interactions (file dialog opened, accepted, cancelled).

## MMMMMMMMMMM. ResourceFetcher prefetch attribution

- **[T]** Per resource: initiator chain — parser-blocking / preload-scanner / link-rel-preload / script-injected / fetch-API / XHR.
- **[T]** Per resource: was it fetched by main thread vs prefetcher vs background fetcher.
- **[T]** Per resource: initiator script URL + line (when discovery is JS-driven).

## NNNNNNNNNNN. GoogleUpdate component status

- **[T]** GoogleSoftwareUpdate launchd daemon state — `launchctl list com.google.keystone.daemon` last exit code.
- **[T]** Last successful check time — `defaults read com.google.Keystone.Agent lastCheckTime`.
- **[T]** Configured update channel — `defaults read com.google.Chrome KSChannelID`.

## OOOOOOOOOOO. ICE failure attribution

- **[T]** Per failed ICE candidate: `RTCIceTransport.state` transitions + failure reason.
- **[T]** Per failed checklist pair: foundation + protocol + priority.
- **[T]** TURN allocation failure reasons.

## PPPPPPPPPPP. WebSocket extension negotiation

- **[T]** Per WS handshake: `Sec-WebSocket-Extensions` header offered (client) vs accepted (server).
- **[T]** Per WS: `permessage-deflate` parameters negotiated (server_max_window_bits, client_max_window_bits, server_no_context_takeover, client_no_context_takeover).
- **[T]** Per WS: `Sec-WebSocket-Protocol` subprotocol offered vs selected.

## QQQQQQQQQQQ. HTTP/2 GOAWAY + RST_STREAM

- **[T]** Per HTTP/2 session: GOAWAY frames received — last-stream-id + error-code + opaque-data.
- **[T]** Per stream: RST_STREAM frames — stream-id + error-code.
- **[T]** Per session: PING frame round-trip times.
- **[T]** SETTINGS frame change events.

## RRRRRRRRRRR. DNSSEC validation

- **[T]** Per outgoing DNS query: `+dnssec` flag set or not (from NetLog).
- **[T]** Per DNS response: AD (Authenticated Data) bit set / not.
- **[T]** DoH provider DNSSEC behavior.

## SSSSSSSSSSS. Web App Manifest icon byte hashes

- **[T]** Per manifest icon: full byte sha256 (deduped, saved alongside manifest).
- **[T]** Per icon: rendered-at-target-DPR pixel hash (compare across runs to detect ICC-profile assignment differences).

## TTTTTTTTTTT. Prerendered page session reuse log

- **[T]** Per prerender activation: time from speculation-rules-fetch to activation; bytes fetched ahead-of-time vs used on activation.
- **[T]** Per cross-document prerender: cookies / storage isolation boundary crossings.

## UUUUUUUUUUU. ResourceRequest priority modifiers

- **[T]** Per request: initial priority + modified-by-fetchpriority + modified-by-importance.
- **[T]** Per request: Priority Hint values resolved (`fetchpriority='high'` / `'low'` / `'auto'`).
- **[T]** Per resource type: per-priority distribution (high / medium / low / very-low / lowest).

## VVVVVVVVVVV. FLEDGE / Protected Audience interest group log

- **[T]** Per origin: every `navigator.joinAdInterestGroup` call — group name, expirationTime, biddingLogicUrl, biddingWasmHelperUrl, dailyUpdateUrl, trustedBiddingSignalsUrl, trustedBiddingSignalsKeys.
- **[T]** Per origin: `leaveAdInterestGroup` + `clearOriginJoinedAdInterestGroups` calls.
- **[T]** Active interest groups at session close.

## WWWWWWWWWWW. DOM mutation origin breakdown

- **[T]** Per session: total DOM mutations classified by origin — HTML parser, script (`appendChild`/`innerHTML`/etc.), CSS animation, user interaction.
- **[T]** Per page state change: mutation rate spike attribution.

## XXXXXXXXXXX. SpeechSynthesis utterance log

- **[T]** Every `speechSynthesis.speak(utt)` call: text length, voice URI, lang, rate, pitch, volume.
- **[T]** Per utterance: events fired (start, end, error, boundary, mark).
- **[T]** SpeechSynthesisVoice list change events.

## YYYYYYYYYYY. SpeechRecognition session events

- **[T]** Every SpeechRecognition session: start time, results count, error events.
- **[T]** Recognition result confidence values distribution per session.

## ZZZZZZZZZZZ. Navigation start cause attribution

- **[T]** Per page navigation: which user-interaction or script-call initiated it — link click, form submission, location.assign / replace / href, history.go, browser back/forward, automation (CDP Page.navigate), prerender activation.
- **[T]** Per navigation: was it a soft-nav (no real navigation) vs hard-nav.

## AAAAAAAAAAAA. Sandboxed iframe attribution chain

- **[T]** Per sandboxed iframe: parent frame URL + sandbox value + creator script URL + creation timestamp.
- **[T]** Cross-document attribution — which document spawned which sandbox + what scope it has.

## BBBBBBBBBBBB. WebGPU texture / buffer allocation footprint

- **[T]** Per WebGPU device: every `createTexture` / `createBuffer` call — size, usage flags, format.
- **[T]** Per WebGPU device: cumulative GPU memory consumed over session.
- **[T]** Per WebGPU device: command-buffer submit count + per-command-type breakdown.

## CCCCCCCCCCCC. Canvas allocation tracking + lifetime

- **[T]** Every `document.createElement('canvas')` / `new OffscreenCanvas` call: timestamp + dimensions + caller stack.
- **[T]** Per canvas: lifetime (creation to GC) + peak memory.
- **[T]** Per canvas: getContext calls — context type (2d/webgl/webgl2/webgpu/bitmaprenderer) + context attributes.

## DDDDDDDDDDDD. HTTP/2 priority dependency tree

- **[T]** Per HTTP/2 session: priority dependency graph at every PRIORITY frame.
- **[T]** Per stream: weight (1-256) + exclusive flag.
- **[T]** Per session: priority-change frequency distribution.

## EEEEEEEEEEEE. CSS containment usage per page

- **[T]** Per element with `contain:` rule: which containment types (layout / paint / size / style / inline-size).
- **[T]** Per page: containment opt-in count + per-type distribution.
- **[T]** content-visibility usage — `content-visibility: auto` element count.

## FFFFFFFFFFFF. JS framework detection

- **[T]** Detect frameworks via well-known globals: `window.React`, `__REACT_DEVTOOLS_GLOBAL_HOOK__`, `window.Vue`, `__VUE_DEVTOOLS_GLOBAL_HOOK__`, `window.ng` (Angular), `window.angular`, `window.__SVELTE_DEVTOOLS_GLOBAL_HOOK__`, `window.lit` (Lit), `window.htmx`, `window.Alpine`, `window.Stimulus`, `window.jQuery`, `window.$`.
- **[T]** Per framework detected: version string from build-id / package metadata exposed.
- **[T]** Per-page React Fiber root presence + root count.

## GGGGGGGGGGGG. CMS / platform detection

- **[T]** Detect platform via meta-generator + DOM heuristics — WordPress (`<meta name="generator" content="WordPress">`), Shopify (`window.Shopify`), Squarespace (`window.Y` static), Wix (`window.wixBiSession`), Webflow, Hugo, Gatsby, Next.js (`window.__NEXT_DATA__`), Nuxt (`window.__NUXT__`), Astro, Remix, SvelteKit, Eleventy.
- **[T]** Detect e-commerce: Magento, BigCommerce, WooCommerce, Salesforce Commerce Cloud.

## HHHHHHHHHHHH. Alt-Svc advertisements per host

- **[T]** Per host: every `Alt-Svc:` response header seen — protocol (h2, h3, quic), persist=, ma= (max-age).
- **[T]** Per host: which Alt-Svc was actually used on subsequent connections (cache hit).

## IIIIIIIIIIII. V8 sandboxed pointers + CFI

- **[T]** V8 sandbox enabled state (from `--enable-features=V8VMFuture` flag).
- **[T]** CFI (control-flow integrity) violation count from `chrome://crashes/`.
- **[T]** Ignition / Sparkplug / Maglev / Turbofan tier transition counts per top-N functions (already partly in NNNNNNNN, here deeper — per-function tier history).

## JJJJJJJJJJJJ. CDP connection source attribution

- **[T]** Per attached page: who attached the CDP session — Playwright over WebSocket, devtools UI, custom inspector. Distinguish via `Inspector.targetCrashed` payload + `Browser.getVersion` response identity.
- **[T]** Per CDP session: attached features list (which domains the consumer enabled).

## KKKKKKKKKKKK. WebGL / WebGPU context loss + restore

- **[T]** Per WebGL context: `webglcontextlost` events + recovery time.
- **[T]** Per WebGPU device: `lost` Promise resolution + reason.
- **[T]** GPU process crash → context loss attribution.

## LLLLLLLLLLLL. WebAuthn attestation

- **[T]** Per `navigator.credentials.create()` call: full options (rp, user, pubKeyCredParams, authenticatorSelection, attestation, extensions).
- **[T]** Per attestation: format (`none` / `packed` / `tpm` / `android-key` / `android-safetynet` / `fido-u2f` / `apple` / `apple-appattest`).
- **[T]** Per credential created: credential ID sha256 + transports + backupEligible + backupState.

## MMMMMMMMMMMM. macOS Stage Manager state

- **[T]** Stage Manager enabled — `defaults read com.apple.WindowManager GloballyEnabled`.
- **[T]** Auto-hide menu bar — `defaults read NSGlobalDomain _HIHideMenuBar`.
- **[T]** Group windows by application — `defaults read com.apple.WindowManager AutoHide`.

## NNNNNNNNNNNN. macOS Notification Center counts

- **[T]** Pending notifications count — read from Notification Center DB metadata (count only).
- **[T]** Per-app notification permission state — `sqlite3 NotificationCenter.db` count of approved bundles.
- **[T]** Focus / Do Not Disturb active state.

## OOOOOOOOOOOO. macOS Spotlight indexed items

- **[T]** `mdutil -s /` Spotlight index status per volume (enabled / disabled).
- **[T]** Approximate indexed item count — `mdfind 'kMDItemContentType == *' | wc -l` (count only).
- **[T]** Per content-type prevalence — `mdfind 'kMDItemContentType == "public.image"' | wc -l`, `public.movie`, `public.text`, etc.

## PPPPPPPPPPPP. macOS Apple ID + iCloud sync status

- **[T]** Active iCloud account — `defaults read MobileMeAccounts Accounts | grep AccountID` (sha256'd).
- **[T]** iCloud services enabled — `defaults read MobileMeAccounts` per service: ENABLED key (Photos, Drive, Mail, Calendar, Contacts, Reminders, Notes, Safari, Keychain, FindMyMac, BackToMyMac, Bookmarks, NewsPublisher, MMShop, MMMoreInfo, ProtectedCloudStorage, iCloudDrive, FaceTime, Messages, iCloudIDP, GameCenter, HomeKit, Mail Drop).
- **[T]** Family Sharing enabled — `defaults read MobileMeAccounts FamilyMember`.

## QQQQQQQQQQQQ. Per-image decode cost

- **[T]** Per loaded image: decode CPU time from `disabled-by-default-blink.feature_usage` Tracing slot.
- **[T]** Per image: hardware-accelerated vs software-decoded (from Tracing `gpu.memory` allocations).
- **[T]** Per image: actual decode-on-load vs decode-on-display attribution.

## RRRRRRRRRRRR. HTML `<slot>` assignment events

- **[T]** Every `slotchange` event fired per ShadowRoot — slot name + assigned nodes count.
- **[T]** Per page: total slot count + slot occupancy distribution.

## SSSSSSSSSSSS. Shadow DOM + Custom Element lifecycle

- **[T]** Every `attachShadow({mode})` call — host element + mode (open/closed) + delegatesFocus + slotAssignment + serializable + clonable.
- **[T]** Every Custom Element upgrade — element tag + constructor + connectedCallback fire count.

## TTTTTTTTTTTT. document.adoptedStyleSheets membership changes

- **[T]** Per Document and per ShadowRoot: adoptedStyleSheets array — count + sha256 of each constructed stylesheet's serialized rules.
- **[T]** Mutation events on adoptedStyleSheets length over session.

## UUUUUUUUUUUU. NDC (Network Diagnostic Cause) chain per failure

- **[T]** Per network failure: full diagnostic cause chain from NetLog (NetError code + sub-cause + lower-level OS error).
- **[T]** Per ERR_*: per-error-code count distribution over session.

## VVVVVVVVVVVV. fetch() keepalive distribution

- **[T]** Per `fetch(url, {keepalive: true})` call: count of keepalive vs non-keepalive fetches.
- **[T]** Per keepalive fetch: did it survive pagehide? (Resource Timing entry presence after unload).

## WWWWWWWWWWWW. WebRTC DTLS fingerprint

- **[T]** Per PeerConnection: local DTLS fingerprint (cert sha256) + algorithm.
- **[T]** Per PeerConnection: remote DTLS fingerprint received in answer.
- **[T]** TLS cipher negotiated for DTLS-SRTP.

## XXXXXXXXXXXX. HTTP redirect total cost

- **[T]** Per redirect chain: cumulative time across hops; total bytes received across hops.
- **[T]** Per chain: HTTP-version transitions (HTTP/1.1 → HTTP/2 across hops).

## YYYYYYYYYYYY. Browser-side `navigator.userActivation`

- **[T]** Per page: `navigator.userActivation.hasBeenActive` + `isActive` at every script invocation.
- **[T]** User-activation expiry log — when did each gesture expire.

## ZZZZZZZZZZZZ. CPU instruction trace fingerprints

- **[T]** Per Chromium child: `sample <pid> 0.1` micro-sample — top stack frames + leaf-function call counts.
- **[T]** Per renderer: V8 inline-cache transitions per call site (already in NNNNNNNN — here cite call-site source URLs).

## AAAAAAAAAAAAA. Per-CSS-property paint cost histogram

- **[T]** From Tracing `disabled-by-default-blink.paint`: per CSS property triggering invalidation, cumulative paint cost over session.
- **[T]** Top-N most-expensive CSS properties for this page.

## BBBBBBBBBBBBB. Per-script GC-allowed flag

- **[T]** Per script execution context: V8 `gcAllowed` flag distribution (microtask vs task vs init).
- **[T]** Per page: GC-blocked windows (in user-script execution).

## CCCCCCCCCCCCC. WebAuthn PRF extension usage

- **[T]** Per credential created with `extensions: {prf: {...}}`: input salt + evaluated output sha256.
- **[T]** PRF eval over session count.

## DDDDDDDDDDDDD. Secure Payment Confirmation

- **[T]** Per page: `PaymentRequest({method: 'secure-payment-confirmation', ...})` calls + outcomes.
- **[T]** Per SPC credential: rpId + credentialIds + payeeOrigin.

## EEEEEEEEEEEEE. Federated Identity API state per origin

- **[T]** Per origin: registered FedCM IdP list — `IdentityProviderConfig` URLs.
- **[T]** Per IdP: login status (`logged-in` / `logged-out` / `unknown`).
- **[T]** Per `navigator.credentials.get({identity})` call: IdP + clientId requested.

## FFFFFFFFFFFFF. ReportingObserver bucket distribution

- **[T]** Per page: per-report-type cumulative count over session.
- **[T]** Per report endpoint group: delivery success count (from `Reporting-Endpoints` response header parsing).

## GGGGGGGGGGGGG. CDN-internal trace headers

- **[T]** Per response: any `cf-request-id`, `cf-bgj`, `cf-cache-status`, `cdn-loop`, `x-cache-trace`, `x-edge-location`, `x-fastly-request-id`, `surrogate-key`, `akamai-grn`, `x-vercel-id`, `x-amzn-trace-id`, `x-cloud-trace-context`, `x-google-trace-id`, `x-google-backends`, `x-google-netmon-label`, `x-azure-ref` headers.

## HHHHHHHHHHHHH. Topics API epoch transitions

- **[T]** Per page: `document.browsingTopics()` returned list per epoch crossing.
- **[T]** Per epoch boundary: which Topics were used in `Sec-Browsing-Topics` header.

## IIIIIIIIIIIII. Private Aggregation API

- **[T]** Per Protected Audience worklet / Shared Storage worklet: `privateAggregation.contributeToHistogram({bucket, value})` calls.
- **[T]** Per origin: aggregated histogram contribution counts + buckets.

## JJJJJJJJJJJJJ. Microtask queue depth

- **[T]** From Tracing `disabled-by-default-v8.runtime_stats`: microtask queue depth distribution over session.
- **[T]** Per JS task: microtask drain count.

## KKKKKKKKKKKKK. BroadcastChannel reach

- **[T]** Per BroadcastChannel: cross-tab vs same-tab post delivery — confirmed via co-attached CDP sessions counting received messages per name.
- **[T]** Per page: total BroadcastChannel + MessageChannel + Worker postMessage volume.

## LLLLLLLLLLLLL. WebTransport limits negotiated

- **[T]** Per WebTransport session: server max-data, max-stream-data, max-bidi-streams, max-uni-streams.
- **[T]** Per session: actual streams opened vs limits.

## MMMMMMMMMMMMM. Range request distribution

- **[T]** Per fetch with `Range` header: range start, range end, total resource size.
- **[T]** Per resource: number of Range fetches over session (video streaming pattern).

## NNNNNNNNNNNNN. WebRTC ICE role

- **[T]** Per PeerConnection: ICE controlling/controlled role assignment.
- **[T]** Per ICE role conflict: tiebreaker value sent + received.

## OOOOOOOOOOOOO. COEP variants

- **[T]** Per frame: COEP value resolved (`unsafe-none` / `require-corp` / `credentialless`).
- **[T]** Per cross-origin subresource: required CORP header present vs absent.

## PPPPPPPPPPPPP. Locale fallback chain consulted

- **[T]** Per `Intl.DateTimeFormat()` constructor: locale resolution chain (requested locale → fallback chain → resolved).
- **[T]** Per page: `lang` attribute vs `Accept-Language` divergence.

## QQQQQQQQQQQQQ. CSPRNG draws

- **[T]** Per page: total bytes drawn from `crypto.getRandomValues` over session.
- **[T]** Per origin: per-byte-count call distribution.

## RRRRRRRRRRRRR. SystemDarkMode listener attachment

- **[T]** Per page: `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)` count.
- **[T]** OS dark-mode transition events during session (rare but captureable).

## SSSSSSSSSSSSS. Per-document Eyedropper / EyeDropper API

- **[T]** Eyedropper open count per page.
- **[T]** Per eyedrop: sampled sRGB value.

## TTTTTTTTTTTTT. Compute Pressure source `gpu` (when shipped)

- **[T]** PressureObserver with source `gpu` — state transitions.
- **[T]** GPU pressure observer attached vs not (capability-only check).

## UUUUUUUUUUUUU. Per-page `<dialog popover>` show events

- **[T]** Every `<el popover>` element: showPopover / hidePopover / togglePopover invocation log.
- **[T]** Per page: total popovers shown.

## VVVVVVVVVVVVV. Embedded font subsetting fingerprint

- **[T]** Per `@font-face` rule: range of characters actually used on the page (subset detection).
- **[T]** Per font file fetched: byte size vs decoded glyph count (subsetted fonts have small byte sizes).

## WWWWWWWWWWWWW. SourceMap discovery

- **[T]** Per script with `sourceMappingURL` directive: URL fetched + size + content sha256.
- **[T]** Per stylesheet with sourcemap: same.
- **[T]** Per source map: linked source URLs.

## XXXXXXXXXXXXX. Per-tab Audio playback state

- **[T]** Per tab: `Page.isAudible` state transitions (CDP audible event).
- **[T]** Per `<audio>`/`<video>` autoplay decision outcome (allowed / blocked-by-policy).

## YYYYYYYYYYYYY. Custom URL scheme handler registration

- **[T]** Per page: `navigator.registerProtocolHandler(scheme, url)` calls.
- **[T]** Per scheme: registered handler count.

## ZZZZZZZZZZZZZ. NavigationPreloadManager state

- **[T]** Per ServiceWorker: `registration.navigationPreload.{enable,disable,getState,setHeaderValue}` state.
- **[T]** Per navigation: navigation preload hit vs SW network request.

## AAAAAAAAAAAAAA. Path MTU discovery events

- **[T]** Per outbound TCP connection: PMTUD events from NetLog `TCP_CONNECT` blackhole detection.
- **[T]** Per connection: discovered MTU value.
- **[T]** Per session: PMTUD failure count.

## BBBBBBBBBBBBBB. Browser-issued OCSP requests

- **[T]** Per cert chain validation: OCSP query fired vs stapled-only.
- **[T]** Per OCSP responder URL: latency + response status.
- **[T]** OCSP cache hit / miss per session.

## CCCCCCCCCCCCCC. WebPush endpoint format

- **[T]** Per push subscription: endpoint URL host (`fcm.googleapis.com` / `web.push.apple.com` / `updates.push.services.mozilla.com`).
- **[T]** Per subscription: applicationServerKey sha256 + p256dh + auth secret presence.
- **[T]** VAPID claim verification on push receipt.

## DDDDDDDDDDDDDD. WebUSB device descriptor depth

- **[T]** Per `navigator.usb` granted device: full USB descriptor — bcdUSB, deviceClass, deviceSubClass, deviceProtocol, vendorId, productId, productName (sha256'd), manufacturerName (sha256'd), serialNumber (sha256'd).
- **[T]** Per device: full configuration descriptor — interfaces array, endpoints, alternate settings.

## EEEEEEEEEEEEEE. WebHID report descriptor

- **[T]** Per `navigator.hid` granted device: full HID report descriptor bytes (sha256).
- **[T]** Per device: vendorId + productId + collections array + reportIds.
- **[T]** Per device: inputReport / outputReport / featureReport events log.

## FFFFFFFFFFFFFF. WebSerial port detail

- **[T]** Per `navigator.serial` granted port: usbVendorId, usbProductId, bluetoothServiceClassId, productName (sha256'd).
- **[T]** Per port: open events + baudRate + dataBits + stopBits + parity + bufferSize + flowControl.

## GGGGGGGGGGGGGG. Bluetooth GATT services

- **[T]** Per `navigator.bluetooth` granted device: GATT service UUIDs advertised.
- **[T]** Per service: characteristics + descriptors.
- **[T]** Per characteristic: read/write/notify operations log.

## HHHHHHHHHHHHHH. WebNFC tag interaction

- **[T]** `NDEFReader.scan()` calls + reading events with NDEF record types.
- **[T]** `NDEFReader.write()` payload byte sizes.

## IIIIIIIIIIIIII. EME (Encrypted Media) sessions per element

- **[T]** Per `<video>` element using EME: `MediaKeys` instance + session count.
- **[T]** Per session: `keyStatuses` Map iteration with keyId sha256 + status.
- **[T]** Per session: license request + response byte counts.

## JJJJJJJJJJJJJJ. A/B testing cookie distribution heuristic

- **[T]** Detect known A/B platforms via cookie name patterns — Optimizely (`optimizely_*`), VWO (`_vwo_*`), Google Optimize (`_gaexp`), Adobe Target (`mbox`), LaunchDarkly (`ld_*`), Statsig (`statsig.stable_id`), Split.io.
- **[T]** Per platform detected: bucket assignment value sha256 (to see if account is in known A/B groups).

## KKKKKKKKKKKKKK. JavaScript module dependency graph

- **[T]** Per page: every `import()` dynamic-import call + resolved URL + parent module URL.
- **[T]** Per page: full ES module dependency graph from `Debugger.scriptParsed` events + import-meta-url.
- **[T]** Per page: import-map JSON content (`<script type="importmap">`).

## LLLLLLLLLLLLLL. Subresource attributes deep

- **[T]** Per `<script>`: `crossorigin` value (anonymous/use-credentials), `type` (classic/module/importmap/speculationrules/webbundle), `defer`, `async`, `nomodule`, `nonce` (sha256'd), `integrity`, `referrerpolicy`, `fetchpriority`.
- **[T]** Per `<link>`: `crossorigin`, `as`, `imagesrcset`, `imagesizes`, `fetchpriority`, `blocking`.
- **[T]** Per `<iframe>`: `allowfullscreen`, `allowpaymentrequest`, `allow`, `csp`, `referrerpolicy`, `loading`, `sandbox`, `srcdoc`.

## MMMMMMMMMMMMMM. Referrer policy cascade

- **[T]** Per outgoing request: resolved referrer policy + which scope it came from (meta tag / link rel / element attribute / fetch init / page default).
- **[T]** Per page: referrer-policy distribution (no-referrer / no-referrer-when-downgrade / origin / origin-when-cross-origin / same-origin / strict-origin / strict-origin-when-cross-origin / unsafe-url).

## NNNNNNNNNNNNNN. Blob URL lifecycle

- **[T]** Per `URL.createObjectURL(blob)` call: source MIME + size + caller stack.
- **[T]** Per `URL.revokeObjectURL` call: matched against creation log (unmatched = leaks).
- **[T]** Blob URL active count at session close.

## OOOOOOOOOOOOOO. MutationRecord type distribution

- **[T]** Per MutationObserver callback fire: MutationRecord type (childList / attributes / characterData) counts.
- **[T]** Per attribute mutation: attributeName + oldValue presence.

## PPPPPPPPPPPPPP. Animation effect detail

- **[T]** Per `Element.animate(keyframes, options)` call: full keyframes array + timing object (delay/duration/iterations/iterationStart/direction/easing/composite/fill).
- **[T]** Per Animation: effect.getKeyframes() detail.

## QQQQQQQQQQQQQQ. Document timeline drift

- **[T]** At session start, middle, and close: `document.timeline.currentTime` vs `performance.now()` vs `Date.now()` snapshot — drift histogram.
- **[T]** Per long animation: timeline-vs-perf drift over its lifetime.

## RRRRRRRRRRRRRR. WebAuthn largeBlob storage

- **[T]** Per credential with `largeBlob` extension: read/write outcomes + payload byte sizes.
- **[T]** Per credential: hmac-secret extension support.

## SSSSSSSSSSSSSS. WebOTP transport

- **[T]** Per `navigator.credentials.get({otp: {transport: ['sms']}})` call: outcome + retrieval time.
- **[T]** Per OTP credential: detected source (SMS / email).

## TTTTTTTTTTTTTT. WebRTC stats time-series

- **[T]** Per PeerConnection: every `getStats()` poll — outboundRtp packetsSent / bytesSent / framesPerSecond / framesEncoded / qualityLimitationDurations / qualityLimitationResolutionChanges.
- **[T]** Per PeerConnection: candidatePair bytesSent / bytesReceived / currentRoundTripTime / availableOutgoingBitrate timeseries.
- **[T]** Per codec: codecParams (clockRate, channels, sdpFmtpLine) negotiated.

## UUUUUUUUUUUUUU. UA-CH high-entropy values delivery

- **[T]** Per response: `Critical-CH`, `Accept-CH`, `Vary` headers parsed.
- **[T]** Per origin: cached UA-CH high-entropy values delivered on subsequent navigations.

## VVVVVVVVVVVVVV. Per-page `<input>` autofill suggestion fingerprint

- **[T]** Per autofill-eligible input (`autocomplete='cc-number'`, `'tel'`, `'street-address'`, etc.): whether Chrome offered any suggestion — fingerprintable because the count of saved entries determines suggestion availability.
- **[T]** Per page: autofill profile counts probed indirectly.

## WWWWWWWWWWWWWW. Per-page Trust Token redemption attempts

- **[T]** Per `fetch(url, {trustToken: {type: 'redemption', issuer}})` call: outcome (accepted / rejected) + issuer origin.
- **[T]** Per origin: stored Trust Token count.

## XXXXXXXXXXXXXX. Per-page SharedStorage operations

- **[T]** Per Shared Storage operation: append/clear/delete/entries/get/keys/set + caller worklet origin.
- **[T]** Per origin: stored entries count.

## YYYYYYYYYYYYYY. Per-page CookieStore subscribe events

- **[T]** Per `cookieStore.addEventListener('change')`: log every cookie change event with cookie name (sha256) + type (changed/deleted).

## ZZZZZZZZZZZZZZ. Per Chromium-internal: BackgroundFetch state

- **[T]** Per origin: BackgroundFetch registration list — id, downloadTotal, uploadTotal, downloaded, uploaded, result, failureReason.

## AAAAAAAAAAAAAAA. Per-page WebGL texture upload byte count

- **[T]** Per WebGL context: cumulative bytes uploaded via `texImage2D` / `texSubImage2D` / `compressedTexImage2D` over session, broken down by internalformat.
- **[T]** Per context: bytes uploaded via `bufferData` / `bufferSubData` by usage hint (STATIC_DRAW / DYNAMIC_DRAW / STREAM_DRAW).

## BBBBBBBBBBBBBBB. WebGPU buffer / texture lifecycle

- **[T]** Per WebGPU device: every `createBuffer` / `createTexture` size + usage flags + format + mip-level count.
- **[T]** Per resource: `destroy()` call log; resources still alive at session close.

## CCCCCCCCCCCCCCC. Per-frame BodyStream tee count

- **[T]** Per `Response.body.tee()` call: caller stack + downstream consumers.
- **[T]** Per ReadableStream: pull / cancel events log.
- **[T]** Per stream: byte count flowed through over session.

## DDDDDDDDDDDDDDD. AbortController + AbortSignal usage

- **[T]** Per AbortController: abort() call log + reason value.
- **[T]** Per AbortSignal: timeout signal vs manual signal classification.
- **[T]** Per fetch with `signal:`: did it abort? With what reason?

## EEEEEEEEEEEEEEE. Per-element `inert` attribute and focus trap

- **[T]** Per page: elements with `inert` attribute count.
- **[T]** Focus-trap shifts as a result of inert attribute changes.

## FFFFFFFFFFFFFFF. Per-element `popovertarget` + `popovertargetaction`

- **[T]** Per `<button>` / `<input>` with `popovertarget`: target id + action (show/hide/toggle).
- **[T]** Popover-target invocation log.

## GGGGGGGGGGGGGGG. Per-document `document.head.children` discovery order

- **[T]** Per page: ordered list of every direct child of `<head>` (tagName + attribute-key sha256s).
- **[T]** Per page: head-mutation events after initial parse.

## HHHHHHHHHHHHHHH. Per-page `<script>` execution order trace

- **[T]** Per page: order of script execution (parser-discovered, defer, async, dynamic-import, module) — captured from Tracing `disabled-by-default-v8.runtime_stats`.
- **[T]** Per script: parser-blocking vs deferred vs async classification.

## IIIIIIIIIIIIIII. Per-page render-blocking resources

- **[T]** Per resource: `renderBlockingStatus` from Resource Timing (`blocking` / `non-blocking`).
- **[T]** Per page: count of render-blocking resources at FCP.

## JJJJJJJJJJJJJJJ. Per-page reactive framework hydration state

- **[T]** Detection of hydration markers — `data-island`, `data-hydrate`, `data-react-helmet`, server-rendered HTML islands.
- **[T]** Per page: hydration timing (server vs client render boundary).

## KKKKKKKKKKKKKKK. Per-page Critical CSS inlining

- **[T]** Per page: presence of `<style>` blocks before `<link rel=stylesheet>` (critical CSS pattern).
- **[T]** Per inline `<style>`: byte size distribution.

## LLLLLLLLLLLLLLL. Per-page `<link rel=alternate>` / `<link rel=canonical>`

- **[T]** Per page: full enumeration of `<link>` relations — `canonical`, `alternate`, `me`, `webmention`, `pingback`, `manifest`, `mask-icon`, `apple-touch-icon`, `shortcut icon`, `search`, `next`, `prev`, `dns-prefetch`, `preconnect`, `preload`, `prefetch`, `modulepreload`.
- **[T]** Per `<link rel=alternate>`: hreflang values for i18n routing.

## MMMMMMMMMMMMMMM. Per-page open-graph + Twitter card metadata

- **[T]** Per page: every `og:*` and `twitter:*` meta tag (no content for sensitive ones; presence/absence is the fingerprint).
- **[T]** Per page: structured data (`<script type="application/ld+json">`) blob sha256.

## NNNNNNNNNNNNNNN. Per-image `<source>` selection observed

- **[T]** Per `<picture>`: which `<source>` Chrome selected (currentSrc) for the current viewport / DPR.
- **[T]** Per `<img srcset>`: which descriptor was chosen.

## OOOOOOOOOOOOOOO. Per-script `nomodule` fallback decision

- **[T]** Per page: was the `<script nomodule>` path executed (legacy browser) or `<script type=module>` path?
- **[T]** Module-script vs classic-script execution count per page.

## PPPPPPPPPPPPPPP. Per Chromium child: thread name list

- **[T]** Per Chromium process: thread name list via `ps -M <pid>` or `proc_pidinfo` PROC_PIDLISTTHREADS — surfaces presence of Compositor / IO / GpuMemoryThread / TaskScheduler threads.
- **[T]** Per process: thread state distribution (running / waiting / blocked).

## QQQQQQQQQQQQQQQ. Per-tab page-visibility ratio

- **[T]** Per session: ratio of visible vs hidden time per tab — `document.hidden` toggles + duration in each state.
- **[T]** Per tab: minimized vs background-tab attribution.

## RRRRRRRRRRRRRRR. Per-page WebSocket binaryType usage

- **[T]** Per WebSocket: `binaryType` value (`blob` vs `arraybuffer`) + receive byte distribution.
- **[T]** Per WS: send / receive imbalance (one-way vs bi-directional traffic shape).

## SSSSSSSSSSSSSSS. Per-page `BFCache:cache-control: no-store` blockers

- **[T]** Per blocked-bfcache page: was the blocker `Cache-Control: no-store` on the document?
- **[T]** Per page: per-blocker reason histogram.

## TTTTTTTTTTTTTTT. Per-page Content-Length vs actual decoded size mismatch

- **[T]** Per response: declared Content-Length vs actual bytes received.
- **[T]** Per response: Transfer-Encoding chunked extension parameters (rare but fingerprintable).

## UUUUUUUUUUUUUUU. Per outbound WebSocket / SSE: per-message-deflate stats

- **[T]** Per WS with permessage-deflate negotiated: compression ratio (compressed/uncompressed byte ratio per message).
- **[T]** Per SSE connection: bytes sent + lines per second.

## VVVVVVVVVVVVVVV. Per-page `disabled` attribute toggle log

- **[T]** Per form control: `disabled` attribute toggle events with timestamp.
- **[T]** Per page: disabled-state transition rate.

## WWWWWWWWWWWWWWW. Per-page MessagePort transfer

- **[T]** Per `port.postMessage` call: transfer array (transferred objects) types.
- **[T]** Per `MessageChannel`: lifetime + total message count + total byte volume.

## XXXXXXXXXXXXXXX. Per-page `<iframe srcdoc>` content sha256

- **[T]** Per iframe-srcdoc: byte sha256 of srcdoc content (deduped — same srcdoc on multiple iframes counted once).
- **[T]** Per page: srcdoc vs src iframe count.

## YYYYYYYYYYYYYYY. Per-page DocumentTimeline + scroll-timeline state

- **[T]** Per scroll-timeline: source element + axis + scroll-state at session start vs end.
- **[T]** Per view-timeline: target element + axis + inset.

## ZZZZZZZZZZZZZZZ. Per-page WebSocket Sec-WebSocket-Key entropy

- **[T]** Per WS handshake: `Sec-WebSocket-Key` (16-byte base64) — verify entropy + confirm random origin.
- **[T]** Per WS: server `Sec-WebSocket-Accept` matches expected SHA-1 derivation.

## AAAAAAAAAAAAAAAA. CSS @property registrations

- **[T]** Per page: every `@property --name { syntax: ...; inherits: ...; initial-value: ...; }` rule (registered custom properties).
- **[T]** Per page: `CSS.registerProperty()` programmatic calls.

## BBBBBBBBBBBBBBBB. Dialog modal state log

- **[T]** Per `<dialog>` element: `showModal()` open count, time-open distribution.
- **[T]** Per modal: keyboard close event (Esc), inert-overlay flag.

## CCCCCCCCCCCCCCCC. SpeechSynthesisUtterance queue state

- **[T]** `speechSynthesis.pending`, `.speaking`, `.paused` polled at session boundaries.
- **[T]** Per utterance: queue position at speak() time + actual start time delta.

## DDDDDDDDDDDDDDDD. Permissions API onchange event log

- **[T]** Per permission name: `.onchange` events fired during session (state transitions).
- **[T]** Per permission: initial state captured + delta over session.

## EEEEEEEEEEEEEEEE. Auto-play policy resolution per `<video>`/`<audio>`

- **[T]** Per element: `play()` Promise outcome — resolved / rejected (autoplay blocked).
- **[T]** Per page: autoplay-allowed origin (user-activation captured / pre-granted via Media Engagement Index / muted).

## FFFFFFFFFFFFFFFF. TaskController + TaskSignal state

- **[T]** Per `TaskController({priority, signal})`: priority transitions over session.
- **[T]** Per scheduled task: `scheduler.postTask(task, {priority, delay, signal})` log with outcome.

## GGGGGGGGGGGGGGGG. ScrollTimeline + ViewTimeline registration

- **[T]** Per page: every `new ScrollTimeline({source, axis})` constructor call.
- **[T]** Per page: every `@view-timeline` / `view-timeline: ...` CSS declaration parsed.
- **[T]** Animation-timeline assignments via JS or CSS.

## HHHHHHHHHHHHHHHH. CSS @layer cascade ordering

- **[T]** Per stylesheet: `@layer name1, name2, name3;` declarations + per-layer rule count.
- **[T]** Per page: layer stacking order resolved.

## IIIIIIIIIIIIIIII. CSS @scope rules

- **[T]** Per stylesheet: every `@scope (selector) to (selector) { ... }` block + scope rule count.

## JJJJJJJJJJJJJJJJ. CSS nesting rule depth

- **[T]** Per stylesheet: max nesting depth across all rules.
- **[T]** Per stylesheet: nested-rule count.

## KKKKKKKKKKKKKKKK. CSS @import URL chain

- **[T]** Per stylesheet: full `@import` chain (parent → import → import → …).
- **[T]** Per chain: cyclic detection + chain length.

## LLLLLLLLLLLLLLLL. View Transitions name registry

- **[T]** Per page: every `view-transition-name: foo;` declaration — name + element selector.
- **[T]** Per transition: which pairs participated.

## MMMMMMMMMMMMMMMM. Anchor positioning declarations

- **[T]** Per page: every `anchor-name: --foo` declaration + every `position-anchor: --foo` reference.
- **[T]** Per anchor: positioning fallback chain (`@position-try`).

## NNNNNNNNNNNNNNNN. CSS subgrid usage

- **[T]** Per page: count of grid containers using `subgrid` (rows or columns).
- **[T]** Per subgrid: parent grid + subgrid axis.

## OOOOOOOOOOOOOOOO. CSS Color Module Level 4 functions

- **[T]** Per page: usage of `color-mix()`, `color()`, `oklch()`, `oklab()`, `lab()`, `lch()`, `hwb()`, `color-contrast()` functions — count per function.
- **[T]** Per page: color-space references (`srgb`, `display-p3`, `rec2020`, `prophoto-rgb`, `xyz`).

## PPPPPPPPPPPPPPPP. CSS Houdini Typed OM usage

- **[T]** Per page: `Element.computedStyleMap()` calls — count + caller stack.
- **[T]** Per page: `Element.attributeStyleMap.set()` / `.get()` / `.delete()` calls.
- **[T]** `CSS.number()`, `CSS.px()`, `CSS.em()`, etc. usage per page.

## QQQQQQQQQQQQQQQQ. font-display strategy distribution

- **[T]** Per `@font-face` rule: `font-display` value (`auto`/`block`/`swap`/`fallback`/`optional`) — distribution across loaded fonts.
- **[T]** Per font: actual swap/fallback events observed during load.

## RRRRRRRRRRRRRRRR. Lazy-loading boundary breaches

- **[T]** Per `<img loading=lazy>` / `<iframe loading=lazy>`: time when it entered viewport relative to page load.
- **[T]** Per lazy resource: was it fetched before viewport entry? (chromium can hint-fetch lazy resources).

## SSSSSSSSSSSSSSSS. Reporting API endpoint groups

- **[T]** Per response: `Reporting-Endpoints` header parsed — group name → URL mappings.
- **[T]** Per group: delivery attempts + successes.

## TTTTTTTTTTTTTTTT. Navigation API entries

- **[T]** Per page: `navigation.entries()` full list — id, url, key, sameDocument, state.
- **[T]** Per navigation: `navigate` event log with destination, downloadRequest, formData, hashChange, info, signal.

## UUUUUUUUUUUUUUUU. NoState Prefetch hits

- **[T]** Per resource: was it from `chrome://nostate-prefetch` (zero-state warm-up)? — discoverable from NetLog `URL_REQUEST` source flags.
- **[T]** Per page: NoState Prefetch hit rate.

## VVVVVVVVVVVVVVVV. DOM ID collision detection

- **[T]** Per page: count of duplicate `id` attribute values (spec violation but common; site signature).
- **[T]** Per page: count of empty `id` attributes.

## WWWWWWWWWWWWWWWW. Selector engine fingerprint

- **[T]** Per page: `document.querySelectorAll('*').length` (total element count).
- **[T]** Per page: `document.querySelectorAll(':is(h1,h2,h3,h4,h5,h6)').length`, `:has(...)` selector usage count, `:where(...)` count.
- **[T]** Per page: time to execute a known complex selector (selector-engine performance is fingerprintable).

## XXXXXXXXXXXXXXXX. Resource source-of-discovery histogram

- **[T]** Per page: per-resource origination — Preload Scanner (initiator: 'link rel=preload'), Parser-blocking (initiator: 'parser'), Script-injected (initiator: 'script'), Fetch API (initiator: 'fetch'), XHR (initiator: 'xmlhttprequest'), Other.
- **[T]** Per origin: discovery method distribution.

## YYYYYYYYYYYYYYYY. Document Picture-in-Picture window state

- **[T]** Per PiP window: width × height + opening element selector.
- **[T]** Per PiP window: cross-document copy reference graph (which DOM nodes were moved).

## ZZZZZZZZZZZZZZZZ. JSON.stringify replacer + reviver call log

- **[T]** Per `JSON.stringify(value, replacer)` call where replacer is a function: replacer invocation count + caller stack.
- **[T]** Per `JSON.parse(text, reviver)` call: reviver invocation count.

## AAAAAAAAAAAAAAAAA. CSS @counter-style + @font-feature-values + @font-palette-values

- **[T]** Per page: every `@counter-style` rule (system/symbols/additive-symbols/range/pad/speak-as).
- **[T]** Per page: every `@font-feature-values` rule + `@font-palette-values` rule.
- **[T]** Per page: usage of `font-variant-alternates` / `font-palette` / `font-synthesis`.

## BBBBBBBBBBBBBBBBB. CSS @keyframes registry

- **[T]** Per page: every `@keyframes name { ... }` rule with name + key count + property set animated.
- **[T]** Per page: `animation-name` reference count per keyframes name.

## CCCCCCCCCCCCCCCCC. CSS @container query usage

- **[T]** Per element: `container-name: ...` + `container-type: ...` declarations.
- **[T]** Per stylesheet: `@container <name>? (<query>) { ... }` rule count.
- **[T]** Container query evaluator results sampled per breakpoint.

## DDDDDDDDDDDDDDDDD. CSS @starting-style declarations

- **[T]** Per page: every `@starting-style { ... }` block + transitioning property set.

## EEEEEEEEEEEEEEEEE. CSS @page rules

- **[T]** Per page: every `@page` (paged-media) rule + per-margin-box rules (`@top-left`, `@bottom-right`, etc.).

## FFFFFFFFFFFFFFFFF. CSS @namespace + @supports detail

- **[T]** Per stylesheet: `@namespace` declarations.
- **[T]** Per page: every `@supports (...)` block + parsed condition + matched/unmatched outcome.

## GGGGGGGGGGGGGGGGG. CSS media query parsing detail

- **[T]** Per stylesheet: every `@media (...)` block — full media query string sha256 + matched/unmatched at session start.
- **[T]** Per page: media-query change events fired during session.

## HHHHHHHHHHHHHHHHH. Per-element pseudoclass match counts

- **[T]** Per page: count of elements matching `:user-invalid`, `:user-valid`, `:modal`, `:picture-in-picture`, `:fullscreen`, `:open`, `:closed`, `:defined`, `:placeholder-shown`, `:placeholder`, `:autofill`, `:state(...)`.
- **[T]** Per page: counts vary with site state (modal open → `:modal` matches; placeholder shown → `:placeholder-shown` matches).

## IIIIIIIIIIIIIIIII. Shadow DOM ::part / ::slotted usage

- **[T]** Per page: count of `::part(foo)` rule references + `part=` attribute usage.
- **[T]** Per page: count of `::slotted(...)` rules in shadow trees.
- **[T]** Per page: `:host` + `:host-context(...)` rule count.

## JJJJJJJJJJJJJJJJJ. HTMLVideoElement.requestVideoFrameCallback

- **[T]** Per `<video>` with `requestVideoFrameCallback`: per-frame metadata — presentationTime, expectedDisplayTime, presentedFrames, processingDuration, captureTime, receiveTime, rtpTimestamp, width, height, mediaTime.
- **[T]** Per video: dropped frames / corrupted frames count over session.

## KKKKKKKKKKKKKKKKK. MediaSource lifecycle

- **[T]** Per `MediaSource`: SourceBuffer list per type, appendBuffer byte counts, append duration distribution.
- **[T]** Per MediaSource: state transitions (closed/open/ended).
- **[T]** Per SourceBuffer: `appendWindowStart`, `appendWindowEnd`, `timestampOffset`, `mode` (segments/sequence).

## LLLLLLLLLLLLLLLLL. MediaSession state + metadata

- **[T]** Per page: registered MediaSession action handlers (play/pause/seekbackward/seekforward/previoustrack/nexttrack/skipad/stop/seekto/togglemicrophone/togglecamera/togglehang).
- **[T]** Per page: MediaSession metadata — title, artist, album, artwork (count + first artwork sha256), chapterInfo array.
- **[T]** Per page: position state polled — duration / playbackRate / position.

## MMMMMMMMMMMMMMMMM. Web Animations composite ordering

- **[T]** Per running animation: composite mode (`replace` / `add` / `accumulate`).
- **[T]** Per element with multiple animations: composite-order resolution.

## NNNNNNNNNNNNNNNNN. CSS image-rendering / image-orientation distribution

- **[T]** Per page: usage count of `image-rendering: pixelated` / `crisp-edges` / `smooth` / `auto` / `optimizeSpeed` / `optimizeQuality`.
- **[T]** Per page: `image-orientation: from-image` vs `none` usage count.

## OOOOOOOOOOOOOOOOO. CSS text-wrap balance/pretty + hyphens

- **[T]** Per page: usage count of `text-wrap: balance|pretty|stable|nowrap`.
- **[T]** Per page: `hyphens: auto|none|manual` distribution + hyphenation dictionary loaded for the page's `lang`.

## PPPPPPPPPPPPPPPPP. CSS contain-intrinsic-size + content-visibility

- **[T]** Per element with `content-visibility: auto`: skipped-rendering count + render-when-visible transitions.
- **[T]** Per element with `contain-intrinsic-size`: declared size vs actual size after layout.

## QQQQQQQQQQQQQQQQQ. CSS color-scheme value

- **[T]** Per page: declared `color-scheme: light dark | only light | only dark` value.
- **[T]** Resolved color scheme at session start (light vs dark).

## RRRRRRRRRRRRRRRRR. Chromium internal password manager state

- **[T]** From Local State / Profile DB: saved-password count per origin (presence only).
- **[T]** From Profile DB: saved-address count + saved-payment count.
- **[T]** Password generation suggestions offered per field.

## SSSSSSSSSSSSSSSSS. Browser-extension store activation

- **[T]** Loaded extensions list — `chrome://extensions/` enumerated via CDP `Page.navigate`.
- **[T]** Per extension: id, name, version, manifest version, permissions list, host_permissions list, enabled state.

## TTTTTTTTTTTTTTTTT. Per-page IndexedDB schema enumeration

- **[T]** Per origin: `indexedDB.databases()` returns DB list — name + version.
- **[T]** Per DB: object store names list + key paths + auto-increment flags + index names + index key paths.
- **[T]** Per DB: row count per object store (counts only).

## UUUUUUUUUUUUUUUUU. Per-page Cache Storage detail

- **[T]** Per origin: `caches.keys()` cache name list.
- **[T]** Per cache: `cache.keys()` request URL count + per-URL response sha256.
- **[T]** Per cache: total stored bytes.

## VVVVVVVVVVVVVVVVV. Per-page IDBObjectStore index lookup pattern

- **[T]** From CDP `IndexedDB.requestData`: per-object-store cursor traversal pattern observed during session.
- **[T]** Per IDB transaction: read-only vs read-write distribution.

## WWWWWWWWWWWWWWWWW. Per-page Storage quota usage detail

- **[T]** Per origin: `navigator.storage.estimate()` — `quota`, `usage`, `usageDetails` per category (caches, indexedDB, fileSystem, serviceWorkerRegistrations).
- **[T]** Per origin: storage pressure events.

## XXXXXXXXXXXXXXXXX. Per-page Origin Private FS deep

- **[T]** Per origin: full recursive enumeration of OPFS root via `getDirectoryHandle` + `entries()` — file name sha256, byte size, last modified.
- **[T]** Per file: SyncAccessHandle usage count.

## YYYYYYYYYYYYYYYYY. Per-page Trusted Types policy creation log

- **[T]** Per page: every `trustedTypes.createPolicy(name, rules)` call — policy name + sha256 of rules object.
- **[T]** Per page: per-policy `createHTML` / `createScript` / `createScriptURL` invocation counts.

## ZZZZZZZZZZZZZZZZZ. Per-page DocumentPictureInPicture API state deep

- **[T]** Per call to `documentPictureInPicture.requestWindow({width, height, disallowReturnToOpener})`: full options + outcome.
- **[T]** Per active PiP doc: cross-document message channel established (yes/no) + message volume.

## AAAAAAAAAAAAAAAAAA. Sensor API readings stream

- **[T]** Per `Accelerometer` / `Gyroscope` / `Magnetometer` / `AmbientLightSensor` / `GravitySensor` / `LinearAccelerationSensor` / `AbsoluteOrientationSensor` / `RelativeOrientationSensor`: every reading event — timestamp + values (x/y/z/quaternion).
- **[T]** Per sensor: sample frequency requested vs actual delivered.

## BBBBBBBBBBBBBBBBBB. Geolocation watch results stream

- **[T]** Per `navigator.geolocation.watchPosition(success, error, options)` call: every successful position result — coords.{latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed} + timestamp.
- **[T]** Per watch: error events (PERMISSION_DENIED / POSITION_UNAVAILABLE / TIMEOUT) count.

## CCCCCCCCCCCCCCCCCC. Battery state event stream

- **[T]** Per `navigator.getBattery()` resolved BatteryManager: `levelchange` + `chargingchange` + `chargingtimechange` + `dischargingtimechange` events log over session.

## DDDDDDDDDDDDDDDDDD. DeviceMotion / DeviceOrientation event stream

- **[T]** Every `devicemotion` event: acceleration.{x,y,z}, accelerationIncludingGravity, rotationRate.{alpha,beta,gamma}, interval.
- **[T]** Every `deviceorientation` event: alpha, beta, gamma, absolute.
- **[T]** Per page: event delivery rate distribution.

## EEEEEEEEEEEEEEEEEE. IdleDetector event stream

- **[T]** Per `IdleDetector({threshold}).start()`: every state change — userState (active/idle) + screenState (locked/unlocked).
- **[T]** Per detector: threshold value + cumulative idle time over session.

## FFFFFFFFFFFFFFFFFF. WakeLock sentinel state stream

- **[T]** Per `navigator.wakeLock.request('screen')`: sentinel acquired event + `release` event.
- **[T]** Per sentinel: `released` Promise resolution timestamp.

## GGGGGGGGGGGGGGGGGG. Vibration API call log

- **[T]** Per `navigator.vibrate(pattern)` call: pattern array + caller stack.
- **[T]** Per page: vibration total call count.

## HHHHHHHHHHHHHHHHHH. ScreenOrientation event stream

- **[T]** Per `screen.orientation.change` event: previous type → new type (portrait-primary/portrait-secondary/landscape-primary/landscape-secondary).
- **[T]** Per page: orientation lock attempts and outcomes.

## IIIIIIIIIIIIIIIIII. Media-query change event stream

- **[T]** Per registered `matchMedia(query).addEventListener('change', ...)`: every state-change event with new matches state.
- **[T]** Per page: per-query change count + final state.

## JJJJJJJJJJJJJJJJJJ. PerformanceObserver subType buffering

- **[T]** Per observer: `buffered:true` initial entries delivered count.
- **[T]** Per observer: post-registration entries delivered count.
- **[T]** Per observer: callback invocation latency distribution.

## KKKKKKKKKKKKKKKKKK. Browser certificate verifier configuration

- **[T]** Built-in cert verifier vs platform cert verifier — from `chrome://flags` `#use-chromium-certificate-verifier` state.
- **[T]** Per cert chain validation: which verifier produced the result.

## LLLLLLLLLLLLLLLLLL. Storage Access permission UI invocation

- **[T]** Per page: `document.requestStorageAccess()` call → did the browser show a UI prompt vs auto-grant vs auto-deny?
- **[T]** Per origin: cached storage-access decisions.

## MMMMMMMMMMMMMMMMMM. SpeechRecognition language fallback

- **[T]** Per SpeechRecognition session: requested `lang` vs actually used.
- **[T]** Per session: continuous/interimResults/maxAlternatives settings.

## NNNNNNNNNNNNNNNNNN. Network status change event stream

- **[T]** `online` / `offline` event log per session.
- **[T]** `navigator.connection.change` event log — every transition (type / effectiveType / downlink / rtt / saveData change).

## OOOOOOOOOOOOOOOOOO. CookieStore change events stream

- **[T]** Per `cookieStore` subscription: every `change` event with changed/deleted arrays (name + value-sha256 only).

## PPPPPPPPPPPPPPPPPP. Document visibility change stream

- **[T]** Every `visibilitychange` event — visibilityState before/after + timestamp.
- **[T]** Per session: visible/hidden ratio + transition count.

## QQQQQQQQQQQQQQQQQQ. Page lifecycle event stream

- **[T]** Every `freeze` / `resume` / `pageshow` / `pagehide` event — persisted flag + timestamp.

## RRRRRRRRRRRRRRRRRR. Pointer hover capability changes

- **[T]** Per session: `matchMedia('(hover: hover)')` / `(any-hover: hover)` / `(pointer: fine|coarse|none)` / `(any-pointer: ...)` matches state + change events.

## SSSSSSSSSSSSSSSSSS. Prefers-color-scheme change event stream

- **[T]** Per session: `matchMedia('(prefers-color-scheme: dark)')` state changes (rare, but happens at OS dark/light transitions).
- **[T]** Per session: similar for `prefers-reduced-motion`, `prefers-reduced-data`, `prefers-reduced-transparency`, `prefers-contrast`, `forced-colors`, `inverted-colors`.

## TTTTTTTTTTTTTTTTTT. Geolocation accuracy distribution

- **[T]** Per Geolocation result: accuracy histogram in meters across all results returned.
- **[T]** Source attribution (GPS / Wi-Fi / IP / coarse) inferred from accuracy bucket.

## UUUUUUUUUUUUUUUUUU. Per-page Vibrate / TouchEvent.force distribution

- **[T]** Per touch event: force value histogram.
- **[T]** Per touch event: radiusX / radiusY / rotationAngle distribution.

## VVVVVVVVVVVVVVVVVV. ServiceWorker controllerchange event stream

- **[T]** Per page: every `navigator.serviceWorker.controllerchange` event — new controller scriptURL + reason.

## WWWWWWWWWWWWWWWWWW. Per-page InputDeviceCapabilities

- **[T]** Per input event: `sourceCapabilities.firesTouchEvents` value.
- **[T]** Per page: source capabilities distribution across all input events.

## XXXXXXXXXXXXXXXXXX. Permissions API state-change event stream

- **[T]** Per Permission registered: every `.onchange` event — name + previous state + new state + timestamp.

## YYYYYYYYYYYYYYYYYY. PressureObserver state-change event stream

- **[T]** Every PressureObserver delivery — source + state + timestamp.
- **[T]** Per session: time-in-state distribution (nominal / fair / serious / critical).

## ZZZZZZZZZZZZZZZZZZ. Compositor delegated-ink point stream

- **[T]** Per page using `navigator.ink.requestPresenter(delegatePresenter, element)`: hint points emitted + presenter state.
- **[T]** Delegated ink trail capability + active state.

## AAAAAAAAAAAAAAAAAAA. WebGL / WebGL2 extension presence matrix

- **[T]** Per WebGL context: presence test for every documented extension — `ANGLE_instanced_arrays`, `EXT_blend_minmax`, `EXT_color_buffer_float`, `EXT_color_buffer_half_float`, `EXT_disjoint_timer_query`, `EXT_disjoint_timer_query_webgl2`, `EXT_float_blend`, `EXT_frag_depth`, `EXT_shader_texture_lod`, `EXT_sRGB`, `EXT_texture_compression_bptc`, `EXT_texture_compression_rgtc`, `EXT_texture_filter_anisotropic`, `EXT_texture_norm16`, `KHR_parallel_shader_compile`, `OES_draw_buffers_indexed`, `OES_element_index_uint`, `OES_fbo_render_mipmap`, `OES_standard_derivatives`, `OES_texture_float`, `OES_texture_float_linear`, `OES_texture_half_float`, `OES_texture_half_float_linear`, `OES_vertex_array_object`, `OVR_multiview2`, `WEBGL_color_buffer_float`, `WEBGL_compressed_texture_astc`, `WEBGL_compressed_texture_etc`, `WEBGL_compressed_texture_etc1`, `WEBGL_compressed_texture_pvrtc`, `WEBGL_compressed_texture_s3tc`, `WEBGL_compressed_texture_s3tc_srgb`, `WEBGL_debug_renderer_info`, `WEBGL_debug_shaders`, `WEBGL_depth_texture`, `WEBGL_draw_buffers`, `WEBGL_lose_context`, `WEBGL_multi_draw`, `WEBGL_video_texture`.

## BBBBBBBBBBBBBBBBBBB. CSS clip-path type distribution

- **[T]** Per page: usage count of each `clip-path` function — `inset()`, `circle()`, `ellipse()`, `polygon()`, `path()`, `xywh()`, `rect()`, `shape()`.
- **[T]** Per page: SVG referenced clip-paths (`url(#foo)`) count.

## CCCCCCCCCCCCCCCCCCC. CSS mask + mix-blend / background-blend usage

- **[T]** Per page: count of elements with `mask-image` / `-webkit-mask-image` set; mask source distribution.
- **[T]** Per page: `mix-blend-mode` value distribution (per mode: normal/multiply/screen/overlay/darken/lighten/color-dodge/color-burn/hard-light/soft-light/difference/exclusion/hue/saturation/color/luminosity/plus-lighter).
- **[T]** Per page: `background-blend-mode` distribution.

## DDDDDDDDDDDDDDDDDDD. CSS filter / backdrop-filter function distribution

- **[T]** Per page: usage count of each `filter` function — `blur()`, `brightness()`, `contrast()`, `drop-shadow()`, `grayscale()`, `hue-rotate()`, `invert()`, `opacity()`, `saturate()`, `sepia()`, `url()`.
- **[T]** Per page: `backdrop-filter` function distribution.

## EEEEEEEEEEEEEEEEEEE. CSS transition-property distribution

- **[T]** Per page: transitioned property name histogram across all `transition-property` declarations.
- **[T]** Per page: transition-timing-function distribution (linear / ease / ease-in / ease-out / ease-in-out / steps() / cubic-bezier() / linear()).

## FFFFFFFFFFFFFFFFFFF. CSS will-change / contain / isolation usage

- **[T]** Per page: elements declaring `will-change: foo, bar` — properties hinted.
- **[T]** Per page: `contain` value distribution (already in EEEEEEEEEEEE — here per element count + per-axis split).
- **[T]** Per page: `isolation: isolate` element count.

## GGGGGGGGGGGGGGGGGGG. CSS scroll-* properties

- **[T]** Per page: `overscroll-behavior` value distribution.
- **[T]** Per page: `scroll-snap-type` + `scroll-snap-align` usage count.
- **[T]** Per page: `scroll-padding` + `scroll-margin` declarations.
- **[T]** Per page: `scrollbar-gutter` / `scrollbar-width` / `scrollbar-color` usage.
- **[T]** Per page: `scroll-behavior: smooth` usage count.

## HHHHHHHHHHHHHHHHHHH. CSS touch-action / pointer-events / user-select

- **[T]** Per page: `touch-action` value distribution (auto / none / pan-x / pan-y / pinch-zoom / manipulation).
- **[T]** Per page: `pointer-events` value distribution.
- **[T]** Per page: `user-select` value distribution (auto / none / text / all / contain).

## IIIIIIIIIIIIIIIIIII. WebRTC RTCConfiguration detail

- **[T]** Per PeerConnection: `iceTransportPolicy` (all/relay), `bundlePolicy` (balanced/max-bundle/max-compat), `rtcpMuxPolicy` (require), `iceCandidatePoolSize`.
- **[T]** Per PeerConnection: `iceServers` URLs (sha256'd if private TURN) + credential type.

## JJJJJJJJJJJJJJJJJJJ. Web Audio graph topology

- **[T]** Per AudioContext: node count by type — Oscillator / Gain / BiquadFilter / DynamicsCompressor / Delay / Convolver / Analyser / IIRFilter / WaveShaper / ScriptProcessor / AudioWorklet / ChannelSplitter / ChannelMerger / Panner / StereoPanner / MediaElementSource / MediaStreamSource / MediaStreamDestination.
- **[T]** Per context: connection graph — for each node, list of `connect()` targets.

## KKKKKKKKKKKKKKKKKKK. WebCodecs codec resolution

- **[T]** Per `VideoEncoder.configure({codec})` call: resolved encoder name + hardware-vs-software (`hardwareAcceleration` field).
- **[T]** Per `VideoDecoder.configure({codec})` call: resolved decoder name + hardware-vs-software.
- **[T]** Per `AudioEncoder` / `AudioDecoder` configure: same.

## LLLLLLLLLLLLLLLLLLL. ImageDecoder format support matrix

- **[T]** `ImageDecoder.isTypeSupported(mime)` matrix across every known image mime.
- **[T]** Per page: ImageDecoder instances + bytes decoded by format.

## MMMMMMMMMMMMMMMMMMM. CSS counter-set / counter-reset / counter-increment

- **[T]** Per page: declared counter names + reset/increment patterns.
- **[T]** Per page: `counter()` / `counters()` function usage in `content:`.

## NNNNNNNNNNNNNNNNNNN. CSS @page margin box rules

- **[T]** Per page: every `@page` rule's margin-box children (`@top-left`, `@top-center`, `@top-right`, `@bottom-left`, `@bottom-center`, `@bottom-right`, `@left-top`, `@left-middle`, `@left-bottom`, `@right-top`, `@right-middle`, `@right-bottom`).

## OOOOOOOOOOOOOOOOOOO. SVG element type distribution

- **[T]** Per page: per SVG element tag count (`svg`, `path`, `circle`, `rect`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `defs`, `g`, `use`, `symbol`, `clipPath`, `mask`, `filter`, `linearGradient`, `radialGradient`, `pattern`, `marker`, `foreignObject`, `image`, `animate`, `animateTransform`, `animateMotion`).
- **[T]** Per page: SVG filter primitive count (`feGaussianBlur`, `feColorMatrix`, `feComposite`, `feMorphology`, `feDisplacementMap`, `feFlood`, `feOffset`, `feMerge`, `feBlend`, `feTurbulence`, `feConvolveMatrix`, `feSpecularLighting`, `feDiffuseLighting`, `feDistantLight`, `fePointLight`, `feSpotLight`).

## PPPPPPPPPPPPPPPPPPP. MathML element distribution

- **[T]** Per page: per MathML element count (`math`, `mrow`, `mn`, `mi`, `mo`, `mfrac`, `msup`, `msub`, `msubsup`, `munder`, `mover`, `munderover`, `msqrt`, `mroot`, `mtable`, `mtr`, `mtd`, `mtext`, `mspace`, `mstyle`, `merror`, `mphantom`, `menclose`, `mfenced`).

## QQQQQQQQQQQQQQQQQQQ. HTML semantic element distribution

- **[T]** Per page: count of every HTML element tag — full inventory of `body.querySelectorAll('*')` grouped by tagName.
- **[T]** Top-N least common tags per page (rare tags identify framework versions).

## RRRRRRRRRRRRRRRRRRR. ARIA role distribution

- **[T]** Per page: count of elements with each explicit `role=` attribute — `button`/`link`/`navigation`/`main`/`banner`/`contentinfo`/`complementary`/`region`/`article`/`section`/`form`/`search`/`status`/`alert`/`dialog`/`menu`/`menuitem`/`tab`/`tabpanel`/`tabs`/`textbox`/`combobox`/`listbox`/`option`/`tree`/`treegrid`/`grid`/`row`/`gridcell`/...

## SSSSSSSSSSSSSSSSSSS. HTML data-* attribute usage

- **[T]** Per page: total `data-*` attribute count + per-attribute-name frequency histogram (sha256'd attribute name keys, count values).

## TTTTTTTTTTTTTTTTTTT. HTML form per-input value entropy

- **[T]** Per `<input>`: declared input type + max-length + observed value length distribution.
- **[T]** Per page: total form-control count + per-type breakdown.

## UUUUUUUUUUUUUUUUUUU. Page CSP report-uri / report-to deliveries

- **[T]** Per response with CSP `report-uri` or `report-to`: endpoint URL + reports delivered count.
- **[T]** Per page: violation report queue depth at session close.

## VVVVVVVVVVVVVVVVVVV. Content-Security-Policy header value parsing

- **[T]** Per response with CSP: full directive set parsed — `default-src` / `script-src` / `script-src-elem` / `script-src-attr` / `style-src` / `style-src-elem` / `style-src-attr` / `img-src` / `font-src` / `connect-src` / `frame-src` / `child-src` / `worker-src` / `manifest-src` / `media-src` / `object-src` / `prefetch-src` / `base-uri` / `form-action` / `frame-ancestors` / `navigate-to` / `report-uri` / `report-to` / `require-trusted-types-for` / `trusted-types` / `upgrade-insecure-requests` / `block-all-mixed-content`.

## WWWWWWWWWWWWWWWWWWW. NEL (Network Error Logging) report deliveries

- **[T]** Per response with `NEL:` header: policy + report-to group + sampling-rate + success-fraction + failure-fraction.
- **[T]** Per origin: NEL reports delivered count (network errors observed).

## XXXXXXXXXXXXXXXXXXX. HTTP cookie partitioning + first-party-set membership outcomes

- **[T]** Per outgoing request: per-cookie partition decision (sent / blocked / partitioned).
- **[T]** Per FPS membership: same-set vs cross-set boundary crossings.

## YYYYYYYYYYYYYYYYYYY. Per-page `Origin-Agent-Cluster: ?1` header parsing

- **[T]** Per page: `Origin-Agent-Cluster` response header value (when present).
- **[T]** Per frame: origin-keyed agent cluster vs site-keyed.

## ZZZZZZZZZZZZZZZZZZZ. Per-page TransformStream / TextDecoderStream usage

- **[T]** Per page: every `new TransformStream(transformer)` call + `readableStrategy` / `writableStrategy` highwater mark.
- **[T]** Per page: every `TextDecoderStream` / `TextEncoderStream` / `CompressionStream` / `DecompressionStream` instance — codec + bytes processed.

## AAAAAAAAAAAAAAAAAAAA. HTTP security response headers full set

- **[T]** Per response: parsed value of every security header — `Strict-Transport-Security`, `Expect-CT`, `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `X-Permitted-Cross-Domain-Policies`, `X-Download-Options`, `X-DNS-Prefetch-Control`, `Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Window-Policy`, `Referrer-Policy`, `Permissions-Policy`, `Document-Policy`, `Reporting-Endpoints`, `Speculation-Rules`, `Critical-CH`, `Accept-CH`, `Origin-Agent-Cluster`.

## BBBBBBBBBBBBBBBBBBBB. HTTP standard response headers full set

- **[T]** Per response: value of every standard header — `Server`, `Date`, `Content-Type`, `Content-Length`, `Content-Encoding`, `Content-Language`, `Content-Location`, `Content-Disposition`, `Content-Range`, `Vary`, `ETag`, `Last-Modified`, `Cache-Control`, `Expires`, `Age`, `Pragma`, `Via`, `Server-Timing`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Connection`, `Accept-Ranges`, `Allow`.

## CCCCCCCCCCCCCCCCCCCC. HTTP/3 + QUIC observable detail

- **[T]** Per QUIC session: QUIC version negotiated; Initial packet size distribution; Handshake round-trip count.
- **[T]** Per QUIC session: CONNECTION_CLOSE frame error code distribution.
- **[T]** Per QUIC session: STATELESS_RESET count observed.
- **[T]** Per QUIC session: 0-RTT data sent / accepted.

## DDDDDDDDDDDDDDDDDDDD. HTTP/2 :authority + :scheme + :method observation

- **[T]** Per HTTP/2 stream: pseudo-header `:authority` value vs Host header divergence.
- **[T]** Per HTTP/2 stream: `:scheme` (http/https) value distribution.
- **[T]** Per HTTP/2 stream: `:method` value distribution.

## EEEEEEEEEEEEEEEEEEEE. IME composition event log

- **[T]** Per `<input>` / `<textarea>` / `contenteditable`: composition session log — `compositionstart` + per-`compositionupdate` data + `compositionend` final value.
- **[T]** Per page: IME usage count + active input source attribution.

## FFFFFFFFFFFFFFFFFFFF. Blink rendering pipeline phase counts

- **[T]** From Tracing `disabled-by-default-blink.invalidation`: per page, style-invalidation count + layout-invalidation count + paint-invalidation count.
- **[T]** Per page: full-document-layout count (forced synchronous layout).

## GGGGGGGGGGGGGGGGGGGG. Compositor commit timing

- **[T]** From Tracing `cc`: per page, BeginMainFrame → CommitMainFrame interval distribution.
- **[T]** Per page: PaintToCompositor texture upload byte counts.

## HHHHHHHHHHHHHHHHHHHH. CSS custom property registration + reads

- **[T]** Per page: registered custom properties (`--foo: bar;`) count + their distinct values.
- **[T]** Per page: `getPropertyValue('--foo')` call distribution.

## IIIIIIIIIIIIIIIIIIII. macOS QoS class per Chromium child

- **[T]** Per Chromium child process: `task_policy_get` QoS class — UserInteractive / UserInitiated / Default / Utility / Background.
- **[T]** Per process: scheduler policy (`getpriority`/`nice` value).

## JJJJJJJJJJJJJJJJJJJJ. macOS APFS snapshot state

- **[T]** Per session: `tmutil listlocalsnapshots /` count.
- **[T]** macOS APFS snapshot retention configuration.

## KKKKKKKKKKKKKKKKKKKK. Browser window zoom + page scale

- **[T]** Per tab: page zoom level (`chrome://settings/zoom` per-host value).
- **[T]** Per tab: pinch-zoom state via `visualViewport.scale`.
- **[T]** Default zoom for each origin.

## LLLLLLLLLLLLLLLLLLLL. Browser accessibility flags

- **[T]** Per browser: a11y-mode enabled (VoiceOver / NVDA / TalkBack / JAWS detection via `chrome://accessibility/` flags).
- **[T]** Per browser: tab caret browsing enabled.
- **[T]** Per browser: large-cursor enabled.

## MMMMMMMMMMMMMMMMMMMM. Per Chromium child: process inheritance graph

- **[T]** Per Chromium child pid: parent pid chain from spawn time → browser process root.
- **[T]** Per process: spawn-time argv (captured via `ps -o command= -p <pid>` at first detection).

## NNNNNNNNNNNNNNNNNNNN. macOS Activity Monitor classification

- **[T]** Per process: Activity Monitor "App" vs "Background" classification (from `task_policy`).
- **[T]** Per process: App Nap state.

## OOOOOOOOOOOOOOOOOOOO. Per outgoing request: header order verification

- **[T]** Per HTTP/1.1 request: literal byte order of headers as sent on the wire (from pcap decode).
- **[T]** Per HTTP/2 request: HPACK literal/indexed/never-indexed flag per header (from frame decode).

## PPPPPPPPPPPPPPPPPPPP. WebRTC sdp.bandwidth lines + ssrc identifiers

- **[T]** Per RTCPeerConnection: SDP `b=` line values per media stream.
- **[T]** Per peer connection: SSRC list per media stream.
- **[T]** Per SSRC: rtcp-fb (feedback) capability negotiated.

## QQQQQQQQQQQQQQQQQQQQ. Per-page Origin-Agent-Cluster ?0 / ?1 negotiation

- **[T]** Per frame: explicit OAC opt-in vs default site-keyed agent cluster.
- **[T]** Per page: OAC-induced separate AgentClusterIds (visible via `SharedArrayBuffer` postMessage failures).

## RRRRRRRRRRRRRRRRRRRR. Page-side ICU collation table fingerprint

- **[T]** Per page: `'a'.localeCompare('ä', locale)` matrix across 50+ test pairs and locales — surfaces ICU version-specific collation differences.
- **[T]** Per page: `Intl.Segmenter` grapheme/word/sentence breakpoint patterns on known input — fingerprints ICU break-iterator data version.

## SSSSSSSSSSSSSSSSSSSS. Page-side Unicode normalization edges

- **[T]** Per page: `'ﬁ'.normalize('NFD')` and similar edge cases — surfaces ICU normalization data version.
- **[T]** Per page: `String.prototype.toLocaleLowerCase('tr-TR')` Turkish-i edge case behavior.

## TTTTTTTTTTTTTTTTTTTT. Page-side Intl.Segmenter graphemes test

- **[T]** Per page: segmenter outputs for known mixed-script test strings — emoji ZWJ sequences, combining marks, etc.

## UUUUUUUUUUUUUUUUUUUU. Page-side time-zone observed offsets

- **[T]** Per page: `new Date('2020-06-21T12:00:00Z').toString()` vs `toLocaleString()` — surfaces TZ database version differences.
- **[T]** Per page: historical date timezone offset query (e.g. 1900-01-01 → tz offset reflects LMT vs zone-name distinction).

## VVVVVVVVVVVVVVVVVVVV. Per session WebKitCommitGuestProcess events (Linux/Android only)

- **[T]** Per Linux/Android Chromium session: zygote process spawn events from `ps`.
- **[T]** Process-spawn-time delta distribution per child type.

## WWWWWWWWWWWWWWWWWWWW. Per-page CSS `@media print` rules

- **[T]** Per stylesheet: `@media print { ... }` rules + page-scoped declarations.
- **[T]** Per page: media-type='print' rule count.

## XXXXXXXXXXXXXXXXXXXX. Per-page `<base href>` and `<base target>`

- **[T]** Per page: `<base>` element href + target values.
- **[T]** Per page: baseURI resolution at every cross-document navigation.

## YYYYYYYYYYYYYYYYYYYY. Per-page favicon discovery sequence

- **[T]** Per page: favicon candidates discovered (rel='icon', rel='shortcut icon', rel='apple-touch-icon', rel='mask-icon').
- **[T]** Per candidate: byte sha256 + dimensions.

## ZZZZZZZZZZZZZZZZZZZZ. Per-page TimingHistogram delta polling

- **[T]** `Browser.getHistograms({delta:true})` polled every 30s — emits per-histogram count change since previous poll.
- **[T]** Per histogram: top-N most-active over session.

## AAAAAAAAAAAAAAAAAAAAA. WebTransport per-datagram event stream

- **[T]** Per WebTransport datagram sent + received: byte count + timestamp + sequence.
- **[T]** Per stream: open + close + abort events with stream ID + final error code.

## BBBBBBBBBBBBBBBBBBBBB. WebRTC RTCRtpTransceiver direction state

- **[T]** Per RTCRtpTransceiver: direction (sendrecv/sendonly/recvonly/inactive/stopped) at creation + after each setLocalDescription/setRemoteDescription.
- **[T]** Per transceiver: mid identifier + currentDirection.

## CCCCCCCCCCCCCCCCCCCCC. Legacy fullscreen API presence

- **[T]** Per page: `webkitRequestFullscreen` / `mozRequestFullScreen` / `msRequestFullscreen` presence (vendor-prefixed legacy API surface).
- **[T]** Per page: `webkitFullscreenElement` / `mozFullScreenElement` / `msFullscreenElement` references.

## DDDDDDDDDDDDDDDDDDDDD. Legacy animation API presence

- **[T]** `mozRequestAnimationFrame` / `webkitRequestAnimationFrame` / `msRequestAnimationFrame` global presence.
- **[T]** `webkitCancelAnimationFrame` etc. presence.

## EEEEEEEEEEEEEEEEEEEEE. Legacy MS Pointer event presence

- **[T]** `MSPointerEvent` / `MSGesture` / `msMaxTouchPoints` global presence (legacy IE/Edge surface).
- **[T]** `navigator.msPointerEnabled` value.

## FFFFFFFFFFFFFFFFFFFFF. CSS font-kerning + ligatures + variant detail

- **[T]** Per page: `font-kerning: normal|none|auto` usage count.
- **[T]** Per page: `font-variant-ligatures: ...` usage (common-ligatures / discretionary-ligatures / historical-ligatures / contextual).
- **[T]** Per page: `font-variant-numeric` usage (lining-nums / oldstyle-nums / proportional-nums / tabular-nums / diagonal-fractions / stacked-fractions / ordinal / slashed-zero).
- **[T]** Per page: `font-variant-caps` usage (small-caps / all-small-caps / petite-caps / all-petite-caps / unicase / titling-caps).
- **[T]** Per page: `font-feature-settings` declarations.

## GGGGGGGGGGGGGGGGGGGGG. CDN cache-control + edge-cache headers

- **[T]** Per response: `Cdn-Cache-Control`, `Surrogate-Control`, `Edge-Control`, `CF-Cache-Control` headers parsed.
- **[T]** Per response: `Surrogate-Key`, `X-VCL-Version`, `X-Origin-Cache-Control` headers.

## HHHHHHHHHHHHHHHHHHHHH. Per-page NEL report success / failure sampling

- **[T]** Per response with NEL: per-policy success-fraction + failure-fraction.
- **[T]** Per origin: actual reports queued + delivered + dropped.

## IIIIIIIIIIIIIIIIIIIII. chrome://predictors/ autocomplete + resource

- **[T]** `chrome://predictors/#autocomplete` table contents (URL prediction cache).
- **[T]** `chrome://predictors/#resource-prefetch` table contents.
- **[T]** `chrome://predictors/#loading` table contents.

## JJJJJJJJJJJJJJJJJJJJJ. chrome://media-internals/ players

- **[T]** Active media players list — per player: pipeline state, decoder name, codec, video resolution, audio format.
- **[T]** Per player: decode error count + render frame drop count.

## KKKKKKKKKKKKKKKKKKKKK. chrome://device-log/ events

- **[T]** Per session: device-log entries since boot — USB/Bluetooth/HID/network device events.

## LLLLLLLLLLLLLLLLLLLLL. Per-page form field count by type

- **[T]** Per `<form>`: count of `<input>` by type (text/password/email/tel/url/number/date/time/datetime-local/color/range/file/checkbox/radio/submit/reset/button/image/search/hidden).
- **[T]** Per form: presence of file input + accept attribute + multiple flag.

## MMMMMMMMMMMMMMMMMMMMM. Per page: shorthand vs longhand CSS usage

- **[T]** Per stylesheet: shorthand declaration count (`margin`, `padding`, `border`, `background`, `font`, `transition`, `animation`) vs longhand count.
- **[T]** Per page: distribution.

## NNNNNNNNNNNNNNNNNNNNN. Per page: vendor-prefixed CSS usage

- **[T]** Per stylesheet: `-webkit-*` / `-moz-*` / `-ms-*` / `-o-*` prefixed property count.
- **[T]** Per page: prefix-vs-standard usage ratio.

## OOOOOOOOOOOOOOOOOOOOO. Per page: CSS units distribution

- **[T]** Per page: distribution of length units used — px, em, rem, %, vw, vh, vi, vb, vmin, vmax, svw, svh, lvw, lvh, dvw, dvh, ch, ex, cm, mm, in, pt, pc, Q, fr, cap, ic, lh, rlh.
- **[T]** Per page: angle units (deg/rad/grad/turn), time units (s/ms), resolution units (dpi/dpcm/dppx).

## PPPPPPPPPPPPPPPPPPPPP. Page-side timing-attack: GPU draw latency

- **[T]** Render a known WebGL scene, measure draw-to-pixel-readback latency via `Sync` objects (fingerprints GPU model + driver).
- **[T]** Multi-pass shader compile-to-link latency.

## QQQQQQQQQQQQQQQQQQQQQ. Page-side timing-attack: AudioContext jitter

- **[T]** Per AudioContext: scheduled-time vs actual-time delta on `start(when)` calls (audio clock vs system clock drift).
- **[T]** Per AudioContext: `outputLatency` value evolution over session.

## RRRRRRRRRRRRRRRRRRRRR. Page-side `Promise` microtask priority test

- **[T]** Test execution order of mixed `queueMicrotask` + Promise.then() + MutationObserver callbacks — surfaces V8 task queue priority.

## SSSSSSSSSSSSSSSSSSSSS. Per-page `<script>` source URL distinct count

- **[T]** Per page: distinct external script URL count.
- **[T]** Per page: distinct origin count among script sources (cross-origin script load distribution).

## TTTTTTTTTTTTTTTTTTTTT. Per-page UMA opt-in state (Chromium telemetry)

- **[T]** UMA enabled — from Local State `user_experience_metrics.reporting_enabled`.
- **[T]** Crash reporting enabled — from Local State `user_experience_metrics.client_id` presence.

## UUUUUUUUUUUUUUUUUUUUU. Per-page error console event stream

- **[T]** Per page: every error logged to console — message text + stack trace + filename + line + column.
- **[T]** Per error type: aggregated count.

## VVVVVVVVVVVVVVVVVVVVV. Per-page `Blob`/`File` construction byte distribution

- **[T]** Per `new Blob([...], {type})` call: total byte size + MIME.
- **[T]** Per `new File([...], name, {type})` call: same + filename sha256.

## WWWWWWWWWWWWWWWWWWWWW. Per-page `URL.canParse` + `URL.parse` usage

- **[T]** Per `URL.canParse(input, base)` call: input + outcome.
- **[T]** Per `URL.parse(input, base)` call: outcome.

## XXXXXXXXXXXXXXXXXXXXX. Per-page Encoding/Decoding text usage

- **[T]** Per `new TextDecoder(label, opts)` call: label + fatal flag + ignoreBOM flag.
- **[T]** Per `new TextEncoder()` call: actually-emitted encoding (always utf-8 by spec; capability sanity).
- **[T]** Per encoder/decoder: bytes processed over session.

## YYYYYYYYYYYYYYYYYYYYY. Per-page CSS `:nth-*` selector usage

- **[T]** Per stylesheet: `:nth-child` / `:nth-of-type` / `:nth-last-child` / `:nth-last-of-type` selector count.
- **[T]** Per stylesheet: complex `nth-*` arguments (3n+1, even, odd, etc.).

## ZZZZZZZZZZZZZZZZZZZZZ. Per-page `<details>` + `<summary>` count + toggle log

- **[T]** Per page: `<details>` element count, with default-open count.
- **[T]** Per page: `toggle` event log per `<details>` (already named in DDDDDDDDD — here per-element timing).

## AAAAAAAAAAAAAAAAAAAAAA. eBPF system-call instrumentation (Linux only)

- **[T]** Per Chromium child pid on Linux: `bpftrace` 5-second sample of syscalls — count by syscall name.
- **[T]** Per child: cgroup memberships from `/proc/<pid>/cgroup`.

## BBBBBBBBBBBBBBBBBBBBBB. Apple Silicon NEON / SVE / SME extension presence

- **[T]** `sysctl hw.optional.arm.FEAT_*` full enumeration — every documented optional feature flag.
- **[T]** Per child: NEON instruction usage estimation from `sample` CPU profile.

## CCCCCCCCCCCCCCCCCCCCCC. Per V8 isolate identifier

- **[T]** Per renderer: `Runtime.getIsolateId` value at first attach.
- **[T]** Per session: isolate-id stability across navigations (changes on cross-site navigation due to site isolation).

## DDDDDDDDDDDDDDDDDDDDDD. Per renderer-process worker thread count

- **[T]** Per renderer: ThreadPoolForegroundWorker / Background / IO / Compositor / GpuMemoryThread thread count from `proc_pidinfo`.
- **[T]** Per thread: stack peak depth from `sample`.

## EEEEEEEEEEEEEEEEEEEEEE. Per-tab Resource Timing buffer overflow events

- **[T]** Per page: `PerformanceObserverEntryList.getEntriesByType('resource')` length vs `performance.getEntries().length` to detect buffer overflow.
- **[T]** Per page: `resourcetimingbufferfull` event fires + post-overflow entries dropped.

## FFFFFFFFFFFFFFFFFFFFFF. Page DOM-mutation throttling under tab-discard

- **[T]** Per tab: throttling applied when hidden — `requestAnimationFrame` throttled to 1Hz, setTimeout clamped to >=1000ms, etc.
- **[T]** Per tab: discard-and-reload events.

## GGGGGGGGGGGGGGGGGGGGGG. Per origin: cross-origin window.opener gate

- **[T]** Per page: was `window.opener` blocked by COOP / noopener?
- **[T]** Per page: `window.open(url, name, 'noopener')` count.

## HHHHHHHHHHHHHHHHHHHHHH. Per page: BeforeUnloadEvent + UnloadEvent registration

- **[T]** Per page: number of `beforeunload` listeners registered + their distinct caller stacks.
- **[T]** Per page: `unload` listeners count (deprecated; presence blocks BFCache).
- **[T]** Per page: `pagehide` listeners count (BFCache-compatible alternative).

## IIIIIIIIIIIIIIIIIIIIII. Per page: ResizeObserver-throttled callbacks

- **[T]** Per ResizeObserver: callback delivery latency under high mutation rate (Chrome batches via rAF).

## JJJJJJJJJJJJJJJJJJJJJJ. Per Chromium child: V8 codecache disk size

- **[T]** Per Chromium child: V8 codecache file size in profile-dir `Code Cache/js/` + `Code Cache/wasm/` + `Code Cache/webuijs/`.

## KKKKKKKKKKKKKKKKKKKKKK. Per Chromium child: GPU memory residence

- **[T]** Per GPU process: total resident GPU memory + per-context attribution from `chrome://gpu/`.
- **[T]** Per renderer: estimated GPU memory used.

## LLLLLLLLLLLLLLLLLLLLLL. Per page: PaymentMethodData detail

- **[T]** Per `PaymentRequest` constructor: methodData array — supportedMethods + data object.
- **[T]** Per method: supportedNetworks, supportedTypes, allowedAuthMethods.

## MMMMMMMMMMMMMMMMMMMMMM. Per-page Service Worker scope conflict between extensions

- **[T]** Per origin: SW registration scope vs extension-injected SW scope collision detection.

## NNNNNNNNNNNNNNNNNNNNNN. Per-page WebAssembly memory growth

- **[T]** Per `WebAssembly.Memory` instance: pages grown over session.
- **[T]** Per Memory: shared flag + maximum (declared) vs current.

## OOOOOOOOOOOOOOOOOOOOOO. Per-page Atomics.notify wakeup latency

- **[T]** Per `Atomics.notify(view, index, count)` call: wakeup count returned.
- **[T]** Per `Atomics.wait` resolution: wait duration + reason (`ok` / `not-equal` / `timed-out`).

## PPPPPPPPPPPPPPPPPPPPPP. Per-page Element.animate composite chain

- **[T]** Per element with multiple Animation instances: composite chain resolution (replace/add/accumulate ordering).
- **[T]** Per Animation: `replaceState` transitions.

## QQQQQQQQQQQQQQQQQQQQQQ. Per-page constructed stylesheet usage

- **[T]** Per `new CSSStyleSheet()` call: caller stack + replace/replaceSync usage.
- **[T]** Per stylesheet: adoptedStyleSheets membership count.

## RRRRRRRRRRRRRRRRRRRRRR. Per-page `<input type=file>` accept attribute pattern

- **[T]** Per file input: accept attribute MIME pattern.
- **[T]** Per file input: `multiple` flag, `webkitdirectory` flag, `capture` attribute.

## SSSSSSSSSSSSSSSSSSSSSS. Per-page Drag-and-Drop file count

- **[T]** Per drop event: `dataTransfer.files.length` + per-file size sum.
- **[T]** Per drop event: `dataTransfer.types[]` enumeration.

## TTTTTTTTTTTTTTTTTTTTTT. Per response: `Server-Timing` parsed entries

- **[T]** Per response with `Server-Timing` header: every metric — name + dur + desc.
- **[T]** Per host: top-N most-used Server-Timing metrics.

## UUUUUUUUUUUUUUUUUUUUUU. Per-page `Reporting-Endpoints` header parse

- **[T]** Per response: `Reporting-Endpoints` header parsed — endpoint-group → URL mappings.
- **[T]** Per group: reports delivered count.

## VVVVVVVVVVVVVVVVVVVVVV. Per-page `Speculation-Rules` header parse

- **[T]** Per response: `Speculation-Rules` header parsed — rule URL.
- **[T]** Per spec rule: outcomes (prefetched / prerendered / not used).

## WWWWWWWWWWWWWWWWWWWWWW. Per-page `Variable-Cookie` (deprecated CDN feature) presence

- **[T]** Per response: presence of CDN-feature headers — `Variable-Cookie`, `Edge-Control`, `Surrogate-Capability`.

## XXXXXXXXXXXXXXXXXXXXXX. Per-page HTML5 dataset attribute access

- **[T]** Per page: every `element.dataset.fooBar` access (DOM API → camelCase attribute lookup) — call count + caller stack.

## YYYYYYYYYYYYYYYYYYYYYY. Per-page MicroDataExtractor schema.org markup

- **[T]** Per page: itemprop/itemscope/itemtype attribute count.
- **[T]** Per page: top-level itemtype URIs (schema.org/Person, schema.org/Article, etc.).

## ZZZZZZZZZZZZZZZZZZZZZZ. Per-page RDFa attribute usage

- **[T]** Per page: vocab/typeof/property/about/resource RDFa attribute count.

## AAAAAAAAAAAAAAAAAAAAAAA. WebRTC encoded transform per-frame metadata

- **[T]** Per encoded video frame via `RTCRtpScriptTransform`: temporalIndex / spatialIndex / dependencies / type (key/delta).
- **[T]** Per encoded audio frame: synchronizationSource + contributingSources.

## BBBBBBBBBBBBBBBBBBBBBBB. WebTransport reliable + unreliable stream split

- **[T]** Per WebTransport session: bidi vs uni stream count + per-direction byte volume.
- **[T]** Per session: datagram vs stream byte ratio.

## CCCCCCCCCCCCCCCCCCCCCCC. Page-side Trusted Types violation log

- **[T]** Every Trusted Types violation event: sink name (innerHTML / scriptElement.src / etc.) + caller stack + sample of disallowed string.
- **[T]** Per page: per-sink violation count.

## DDDDDDDDDDDDDDDDDDDDDDD. Page-side eval / Function() call log

- **[T]** Every `eval(code)` call: caller stack + code length sha256.
- **[T]** Every `new Function(code)` call: same.
- **[T]** Per page: dynamic-code execution call count + CSP `unsafe-eval` outcome.

## EEEEEEEEEEEEEEEEEEEEEEE. Page-side new Worker(scriptUrl) construction log

- **[T]** Every `new Worker(url, options)` call: scriptURL + options.type (classic/module) + name + credentials.
- **[T]** Every `new SharedWorker(url, options)` call: same.

## FFFFFFFFFFFFFFFFFFFFFFF. Page-side WeakRef + FinalizationRegistry usage

- **[T]** Per page: count of `new WeakRef(target)` calls.
- **[T]** Per page: count of `new FinalizationRegistry(cleanup)` + `.register()` / `.unregister()` calls.

## GGGGGGGGGGGGGGGGGGGGGGG. Page-side SharedArrayBuffer + Atomics throughput

- **[T]** Per session: total `Atomics.add/sub/store/load/exchange` calls + per-op distribution.
- **[T]** Per SAB: byteLength + grow operations + transfer log.

## HHHHHHHHHHHHHHHHHHHHHHH. Page-side `requestIdleCallback` deadline use

- **[T]** Per `requestIdleCallback` invocation: timeRemaining() at callback start vs end.
- **[T]** Per callback: didTimeout flag value.

## IIIIIIIIIIIIIIIIIIIIIII. Page-side `queueMicrotask` call log

- **[T]** Per page: total `queueMicrotask(fn)` calls + caller stack distribution.

## JJJJJJJJJJJJJJJJJJJJJJJ. Page-side `structuredClone` usage

- **[T]** Per `structuredClone(value, transfer)` call: input byte estimate + transfer array length.
- **[T]** Per call: success vs DataCloneError outcome.

## KKKKKKKKKKKKKKKKKKKKKKK. Page-side BlobURL.createObjectURL revocation gap

- **[T]** Per session: createObjectURL count vs revokeObjectURL count delta (URL handle leaks).
- **[T]** Per blob URL: lifetime until revocation.

## LLLLLLLLLLLLLLLLLLLLLLL. Page-side Range API usage

- **[T]** Per `document.createRange()` call: caller stack.
- **[T]** Per range: extractContents/cloneContents/deleteContents/insertNode call log.
- **[T]** Per page: Range API call count.

## MMMMMMMMMMMMMMMMMMMMMMM. Page-side Selection API mutation

- **[T]** Per session: `window.getSelection()` access count.
- **[T]** Per session: `selection.addRange()` / `removeAllRanges()` / `selectAllChildren()` / `modify()` call log.

## NNNNNNNNNNNNNNNNNNNNNNN. Page-side `document.execCommand` legacy usage

- **[T]** Per page: every `document.execCommand(name, ...)` call (deprecated but still works) — command name + arg.
- **[T]** Per page: `document.queryCommandSupported`/`queryCommandEnabled`/`queryCommandValue` calls.

## OOOOOOOOOOOOOOOOOOOOOOO. Page-side `document.designMode` usage

- **[T]** Per page: `document.designMode` value reads + writes.
- **[T]** Per `contenteditable` element: edit session count + total mutations.

## PPPPPPPPPPPPPPPPPPPPPPP. Per-page `inputmode=numeric` virtual-keyboard hint

- **[T]** Per `<input inputmode="...">` element: declared inputmode value distribution (none/text/tel/url/email/numeric/decimal/search).
- **[T]** Per page: virtualkeyboard policy attribute (`virtualkeyboardpolicy="manual"`).

## QQQQQQQQQQQQQQQQQQQQQQQ. Per-page `<details name>` exclusive accordion group

- **[T]** Per page: count of `<details name="group-name">` exclusive accordions per group.
- **[T]** Per group: toggle event coordination behavior.

## RRRRRRRRRRRRRRRRRRRRRRR. Per page invokers attribute

- **[T]** Per `<button invoketarget="...">` element: invoketarget id + invokeaction value.
- **[T]** Per page: invoker attribute usage count.

## SSSSSSSSSSSSSSSSSSSSSSS. Page-side `MathML` operator behavior

- **[T]** Per `<mo>` element rendered: stretch behavior + lspace + rspace + form value.
- **[T]** Per math expression: MathML rendering passes count.

## TTTTTTTTTTTTTTTTTTTTTTT. Per-page CSS @position-try fallback

- **[T]** Per page: every `@position-try --name { ... }` rule + per-rule property set.
- **[T]** Per anchored element: position-try-fallback chain.

## UUUUUUUUUUUUUUUUUUUUUUU. CSS `align-content` / `place-content` modern values

- **[T]** Per page: count of `align-content: stretch | baseline | first baseline | last baseline | safe center | unsafe center`.
- **[T]** Per page: `place-content` / `place-items` / `place-self` usage count.

## VVVVVVVVVVVVVVVVVVVVVVV. CSS `text-decoration-skip-ink` + `text-underline-offset`

- **[T]** Per page: usage count of `text-decoration-skip-ink`, `text-underline-offset`, `text-decoration-thickness`, `text-decoration-style`.
- **[T]** Per page: text-rendering value (`auto`/`optimizeSpeed`/`optimizeLegibility`/`geometricPrecision`).

## WWWWWWWWWWWWWWWWWWWWWWW. CSS `caret-color` distribution

- **[T]** Per page: distinct `caret-color` values declared.
- **[T]** Per page: rendered caret color per focused control.

## XXXXXXXXXXXXXXXXXXXXXXX. CSS `accent-color` distribution

- **[T]** Per page: distinct `accent-color` values declared.
- **[T]** Per page: rendered accent color per form control.

## YYYYYYYYYYYYYYYYYYYYYYY. Page-side `Element.scrollIntoView` call log

- **[T]** Per call: behavior (auto/smooth/instant) + block (start/center/end/nearest) + inline.
- **[T]** Per page: total scrollIntoView calls.

## ZZZZZZZZZZZZZZZZZZZZZZZ. Page-side `Element.attachInternals()` ElementInternals

- **[T]** Per custom element registering form-associated internals: attachInternals() call log.
- **[T]** Per internals: form validation states reported.

## AAAAAAAAAAAAAAAAAAAAAAAA. CSS `@layer` ordering observation

- **[T]** Per page: declared `@layer` order vs resolved cascade order.
- **[T]** Per page: layer-internal rule count.

## BBBBBBBBBBBBBBBBBBBBBBBB. CSS `@scope (root) to (limit)` resolution

- **[T]** Per page: every `@scope` rule's resolved scope nodes count + limit nodes count.

## CCCCCCCCCCCCCCCCCCCCCCCC. Page-side `Element.replaceChildren` usage

- **[T]** Per page: every `Element.replaceChildren(...)` call (modern DOM) — caller stack + node count.
- **[T]** Per page: legacy innerHTML reassignment vs replaceChildren ratio.

## DDDDDDDDDDDDDDDDDDDDDDDD. Page-side `DOMTokenList.supports` query log

- **[T]** Per page: every `element.classList.supports`, `relList.supports`, `sandbox.supports` capability probe — token + outcome.

## EEEEEEEEEEEEEEEEEEEEEEEE. Page-side `Element.toggleAttribute` call log

- **[T]** Per page: every `Element.toggleAttribute(name, force)` call — name + force flag + outcome.

## FFFFFFFFFFFFFFFFFFFFFFFF. Page-side `Element.matches` / `closest` call log

- **[T]** Per page: total `matches(selector)` call count.
- **[T]** Per page: total `closest(selector)` call count.
- **[T]** Per page: selector text distribution (sha256 of selector strings).

## GGGGGGGGGGGGGGGGGGGGGGGG. Page-side `Document.elementsFromPoint` call log

- **[T]** Per call: (x, y) + returned element count + caller stack.
- **[T]** Per page: hit-test calls per second.

## HHHHHHHHHHHHHHHHHHHHHHHH. Page-side `Range.getBoundingClientRect` call log

- **[T]** Per Range object: getBoundingClientRect call count + caller stack.

## IIIIIIIIIIIIIIIIIIIIIIII. Page-side `getComputedStyle` per-property reads

- **[T]** Per page: `getComputedStyle(el).getPropertyValue(name)` calls — property name distribution.
- **[T]** Per page: `getComputedStyle(el, pseudo)` pseudo-element argument distribution.

## JJJJJJJJJJJJJJJJJJJJJJJJ. Page-side `Element.scrollLeft/Top` reads

- **[T]** Per page: `scrollLeft` / `scrollTop` reads — caller stack + element selector.
- **[T]** Per page: scroll-position read frequency.

## KKKKKKKKKKKKKKKKKKKKKKKK. Page-side `Element.clientWidth/Height` reads

- **[T]** Per page: layout-triggering property reads — `clientWidth`, `clientHeight`, `offsetWidth`, `offsetHeight`, `scrollWidth`, `scrollHeight`, `offsetTop`, `offsetLeft`, `offsetParent`.

## LLLLLLLLLLLLLLLLLLLLLLLL. Page-side `Element.innerText` reads

- **[T]** Per page: `innerText` reads (layout-triggering) — caller stack + element selector.
- **[T]** Per page: `outerText` reads.

## MMMMMMMMMMMMMMMMMMMMMMMM. Page-side `CaretPosition` API

- **[T]** Per `document.caretPositionFromPoint(x, y)` / `document.caretRangeFromPoint` call: returned offsetNode + offset.

## NNNNNNNNNNNNNNNNNNNNNNNN. Page-side `Element.focus({preventScroll})` log

- **[T]** Every `Element.focus(options)` call: preventScroll flag + focusVisible flag.
- **[T]** Per page: total focus() / blur() call counts.

## OOOOOOOOOOOOOOOOOOOOOOOO. Page-side `Element.scroll()` call log

- **[T]** Every `Element.scroll(x, y)` / `scrollTo` / `scrollBy(opts)` call: arguments + behavior.

## PPPPPPPPPPPPPPPPPPPPPPPP. Page-side `Element.animate` shorthand vs longhand call

- **[T]** Per page: `Element.animate(keyframes, durationOrOpts)` calls — shorthand-duration vs full-options usage ratio.

## QQQQQQQQQQQQQQQQQQQQQQQQ. Page-side `KeyframeEffect` standalone construction

- **[T]** Per `new KeyframeEffect(target, keyframes, opts)` + `new Animation(effect, timeline)` construction: caller stack.

## RRRRRRRRRRRRRRRRRRRRRRRR. Page-side `MutationObserver.takeRecords` calls

- **[T]** Per MutationObserver: `takeRecords()` call count (drains records without callback fire).

## SSSSSSSSSSSSSSSSSSSSSSSS. Page-side `requestSubmit()` vs form.submit() ratio

- **[T]** Per page: form.requestSubmit() calls vs form.submit() calls.

## TTTTTTTTTTTTTTTTTTTTTTTT. Page-side `<form rel=help|noreferrer|noopener>` attribute usage

- **[T]** Per `<form>`: rel attribute tokens distribution.

## UUUUUUUUUUUUUUUUUUUUUUUU. Page-side `Element.checkVisibility()` call log

- **[T]** Per call: checkOpacity / checkVisibilityCSS / contentVisibilityAuto / opacityProperty / visibilityProperty options + outcome.

## VVVVVVVVVVVVVVVVVVVVVVVV. Per-page `Document.startViewTransition()` outcome chain

- **[T]** Per call: returned ViewTransition lifecycle — ready / finished / updateCallbackDone / skipTransition / readyState transitions.

## WWWWWWWWWWWWWWWWWWWWWWWW. Per-page `Document.exitFullscreen()` / `exitPictureInPicture()` / `exitPointerLock()` log

- **[T]** Per call: caller stack + outcome (Promise resolved/rejected).

## XXXXXXXXXXXXXXXXXXXXXXXX. Per-page `Element.setHTMLUnsafe` / `setHTML` log

- **[T]** Per call: input string sha256 + sanitizer options (when setHTML with Sanitizer).

## YYYYYYYYYYYYYYYYYYYYYYYY. Per-page `Document.parseHTMLUnsafe` log

- **[T]** Per call: input string sha256 + caller stack.

## ZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page `Document.fragmentDirective` URL fragment

- **[T]** Per page: `:~:text=` / `:~:selector=` URL fragment directives present + scrolled-to element.

## AAAAAAAAAAAAAAAAAAAAAAAAA. Per-page `Document.adoptedStyleSheets.push` event log

- **[T]** Per push/splice/pop: array length delta + caller stack.

## BBBBBBBBBBBBBBBBBBBBBBBBB. Per-page CSSStyleSheet `replace` vs `replaceSync` ratio

- **[T]** Per constructed CSSStyleSheet: replace vs replaceSync usage count.

## CCCCCCCCCCCCCCCCCCCCCCCCC. Per-page `Element.attributeStyleMap.set/append` log

- **[T]** Per element with Typed OM: attributeStyleMap mutations log.

## DDDDDDDDDDDDDDDDDDDDDDDDD. Per-page CSS `paint-order` attribute usage (SVG)

- **[T]** Per SVG element with `paint-order`: declared value (`normal` / `fill stroke markers` / etc.).

## EEEEEEEEEEEEEEEEEEEEEEEEE. Per-page SVG `<feImage>` xlink:href fetch outcome

- **[T]** Per `<feImage>`: referenced URL + load outcome.
- **[T]** Per SVG with external references: fetch error count.

## FFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Web Audio `decodeAudioData` outcome

- **[T]** Per `AudioContext.decodeAudioData(arrayBuffer)` call: input byte size + decoded AudioBuffer duration + sample rate + channels.

## GGGGGGGGGGGGGGGGGGGGGGGGG. Per-page `<audio preload>` strategy distribution

- **[T]** Per `<audio>` / `<video>`: preload attribute value (`none` / `metadata` / `auto`).
- **[T]** Per page: distribution.

## HHHHHHHHHHHHHHHHHHHHHHHHH. Per-page `<source media>` query selection

- **[T]** Per `<source media="...">` element: which media query the browser matched.

## IIIIIIIIIIIIIIIIIIIIIIIII. Per-page `<track kind=subtitles|captions|descriptions|chapters|metadata>` usage

- **[T]** Per `<track>` element: kind + src + label + srclang.
- **[T]** Per video: total track count + per-kind distribution.

## JJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page `Element.requestVideoFrameCallback` registered count

- **[T]** Per `<video>`: registered rVFC callback count + cumulative invocations.

## KKKKKKKKKKKKKKKKKKKKKKKKK. Per-page `HTMLImageElement.decode()` outcome

- **[T]** Per `img.decode()` call: outcome (resolved / rejected) + decode duration.

## LLLLLLLLLLLLLLLLLLLLLLLLL. Per-page `Element.checkVisibility` vs `IntersectionObserver` ratio

- **[T]** Per page: imperative `checkVisibility()` calls vs IntersectionObserver registrations — programming-style fingerprint.

## MMMMMMMMMMMMMMMMMMMMMMMMM. Per-page TextDecoderStream / CompressionStream throughput

- **[T]** Per stream: input bytes + output bytes + codec (gzip/deflate/deflate-raw).

## NNNNNNNNNNNNNNNNNNNNNNNNN. Per-page `<input type=number step=...>` value precision

- **[T]** Per numeric input: step + min + max + decimal handling on submit.

## OOOOOOOOOOOOOOOOOOOOOOOOO. Per-page `<input type=range orient=vertical>` attribute

- **[T]** Per range input: vendor-prefixed orient attribute usage (Firefox legacy).

## PPPPPPPPPPPPPPPPPPPPPPPPP. Per-page `<datalist>` autocomplete option count

- **[T]** Per `<datalist>` element: option count.
- **[T]** Per associated input: list attribute references.

## QQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page `<output for>` association log

- **[T]** Per `<output>` element: for attribute references + value updates.

## RRRRRRRRRRRRRRRRRRRRRRRRR. Per-page `<progress max value>` state log

- **[T]** Per `<progress>` element: max + value over time + indeterminate state transitions.

## SSSSSSSSSSSSSSSSSSSSSSSSS. Per-page `<meter min low high optimum max value>` distribution

- **[T]** Per `<meter>` element: full attribute set.

## TTTTTTTTTTTTTTTTTTTTTTTTT. Per-page `<map name>` / `<area shape coords>` distribution

- **[T]** Per image map: area count + shape distribution (rect/circle/poly/default).

## UUUUUUUUUUUUUUUUUUUUUUUUU. Per-page `<canvas>` 2D `direction` property

- **[T]** Per 2D canvas: direction attribute usage (ltr/rtl/inherit) + textAlign + textBaseline + fontKerning + fontStretch + fontVariantCaps + letterSpacing + wordSpacing.

## VVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Canvas2D `ImageSmoothingQuality` distribution

- **[T]** Per 2D canvas: imageSmoothingEnabled flag + imageSmoothingQuality (`low`/`medium`/`high`) distribution.

## WWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Canvas2D `globalCompositeOperation` distribution

- **[T]** Per 2D canvas: globalCompositeOperation values used (`source-over` / `multiply` / `screen` / ... 26 operations).

## XXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Canvas2D `filter` property usage

- **[T]** Per 2D canvas: ctx.filter assignment values + reset count.

## YYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Canvas2D `lineCap` / `lineJoin` / `miterLimit` distribution

- **[T]** Per 2D canvas: lineCap (butt/round/square), lineJoin (miter/round/bevel), miterLimit value distribution.

## ZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Canvas2D path command distribution

- **[T]** Per Canvas2D context: path command call distribution (`moveTo`/`lineTo`/`bezierCurveTo`/`quadraticCurveTo`/`arc`/`arcTo`/`ellipse`/`rect`/`closePath`/`roundRect`).

## AAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Path2D constructor distribution

- **[T]** Per Path2D() construction: from string (SVG path data) vs empty vs from-Path2D copy.
- **[T]** Per Path2D: addPath/closePath/transform call count.

## BBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Canvas2D matrix transform stack

- **[T]** Per canvas: save/restore depth distribution.
- **[T]** Per canvas: setTransform / transform / translate / rotate / scale call count.

## CCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page WebGL viewport / scissor configuration

- **[T]** Per WebGL context: viewport rect values used + scissor rect distribution.
- **[T]** Per WebGL context: cullFace + frontFace mode distribution.

## DDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page WebGL blend equation + factor distribution

- **[T]** Per WebGL context: blendFunc / blendFuncSeparate / blendEquation / blendEquationSeparate / blendColor parameter distribution.

## EEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page WebGL depth + stencil state

- **[T]** Per WebGL context: depthFunc / depthMask / depthRange / clearDepth values.
- **[T]** Per WebGL context: stencilFunc / stencilMask / stencilOp values.

## FFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page WebGL `pixelStorei` flag distribution

- **[T]** Per WebGL context: pixelStorei flags set — UNPACK_ALIGNMENT, UNPACK_FLIP_Y_WEBGL, UNPACK_PREMULTIPLY_ALPHA_WEBGL, UNPACK_COLORSPACE_CONVERSION_WEBGL, PACK_ALIGNMENT, UNPACK_ROW_LENGTH, UNPACK_IMAGE_HEIGHT, UNPACK_SKIP_PIXELS, UNPACK_SKIP_ROWS, UNPACK_SKIP_IMAGES.

## GGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page WebGL texture parameter distribution

- **[T]** Per texture: texParameteri values — TEXTURE_MIN_FILTER, TEXTURE_MAG_FILTER, TEXTURE_WRAP_S/T/R, TEXTURE_COMPARE_MODE/FUNC, TEXTURE_BASE/MAX_LEVEL, TEXTURE_MIN/MAX_LOD.

## HHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page WebGPU bind-group layouts

- **[T]** Per WebGPU device: createBindGroupLayout entries — binding number, visibility, resource type (buffer/sampler/texture/storage-texture).
- **[T]** Per BindGroupLayout: bindings count distribution.

## IIIIIIIIIIIIIIIIIIIIIIIIII. Per-page WebGPU pipeline cache identifiers

- **[T]** Per WebGPU device: cachedPipelineId distribution (when implemented).
- **[T]** Per pipeline: layout sha256 + shader module sha256.

## JJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page WGSL feature flags

- **[T]** Per WGSL module compiled: feature directives used — `enable f16`, `enable subgroups`, `enable derivative_uniformity`.

## KKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page WebAudio media playback latency

- **[T]** Per `MediaElementAudioSourceNode`: end-to-end audio-route latency from media element to destination.

## LLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page MediaStream constraints applied vs requested

- **[T]** Per `getUserMedia({audio, video})` call: requested constraints vs `track.getSettings()` resolved.
- **[T]** Per page: per-constraint matrix observed.

## MMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page MediaStreamTrack contentHint usage

- **[T]** Per video track: `contentHint` set value (`""`/`motion`/`detail`/`text`).
- **[T]** Per audio track: contentHint set value (`""`/`speech`/`music`).

## NNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Image rendering size mismatch

- **[T]** Per `<img>`: declared `width`/`height` attributes vs `naturalWidth`/`naturalHeight` vs computed style width/height vs rendered pixel size.
- **[T]** Per page: image-aspect-ratio override count via `aspect-ratio` CSS.

## OOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page IntrinsicSize CSS usage

- **[T]** Per page: `aspect-ratio` declared element count.
- **[T]** Per page: `contain-intrinsic-size` declared count.

## PPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page `<source type>` MIME selection

- **[T]** Per `<picture>` / `<video>` / `<audio>`: per-source `type` attribute MIME + selection outcome.

## QQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Resource Hints attribution

- **[T]** Per resource: did a hint (`<link rel=preload|prefetch|preconnect|dns-prefetch|modulepreload>`) precede its fetch?
- **[T]** Per hint: hit ratio (resource fetched within session).

## RRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page `<link rel=manifest>` link

- **[T]** Per page: manifest link presence + URL + crossorigin attribute.

## SSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page `<link rel=apple-touch-icon-precomposed>` set

- **[T]** Per page: icon link variants — `apple-touch-icon`, `apple-touch-icon-precomposed`, `mask-icon`, `shortcut icon`, `fluid-icon`, `image_src`.

## TTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page `<meta name=robots>` directives

- **[T]** Per page: robots meta tag content (`index/noindex`, `follow/nofollow`, `noarchive`, `nosnippet`, `notranslate`, `noimageindex`).

## UUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page `<meta http-equiv>` directives

- **[T]** Per page: every http-equiv directive — `refresh`, `content-security-policy`, `x-ua-compatible`, `default-style`, `content-language`, `content-type`.

## VVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page `<style>` inline byte distribution

- **[T]** Per page: inline `<style>` block byte count + count of blocks.
- **[T]** Per page: inline `<script>` byte count + count of blocks.

## WWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page `<noscript>` fallback content presence

- **[T]** Per page: `<noscript>` element count + fallback content byte size.

## XXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page `<template>` element distribution

- **[T]** Per page: `<template>` element count + content document size per template.

## YYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page `<slot>` element distribution

- **[T]** Per page: `<slot>` element count + named vs default slot distribution.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page `<dialog open>` declarative open state

- **[T]** Per `<dialog>` element: declarative `open` attribute presence at parse time.

## AAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page `<input list=...>` association count

- **[T]** Per `<input>` with `list` attribute: referenced `<datalist>` option count + autocomplete value distribution.

## BBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page autofocus attribute distribution

- **[T]** Per page: autofocus-attribute element count + focused-on-load element.
- **[T]** Per page: focus-loss events post-autofocus.

## CCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page `tabindex` distribution

- **[T]** Per page: tabindex value distribution across focusable elements (positive/zero/negative).
- **[T]** Per page: focus order observed.

## DDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page `contenteditable` attribute distribution

- **[T]** Per page: `contenteditable` (true/false/plaintext-only/inherit) element count + per-value distribution.

## EEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page `draggable` attribute distribution

- **[T]** Per page: `draggable=true` element count + drag events fired.

## FFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page `hidden` attribute distribution

- **[T]** Per page: `hidden` attribute + `hidden="until-found"` element counts.

## GGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page `popover` attribute distribution

- **[T]** Per page: `popover="auto"` vs `popover="manual"` vs `popover="hint"` element count.

## HHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page `inert` attribute toggle log

- **[T]** Per page: inert-toggling events + scopes affected (dialog opens, view transitions, etc.).

## IIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page `slot` attribute on light-DOM children

- **[T]** Per element with `slot=foo` attribute: matched ShadowRoot + assignedSlot resolution.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page `is` attribute (Custom Elements built-in extension)

- **[T]** Per page: `is="..."` attribute usage count + matched custom element.

## KKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page `nonce` attribute lifecycle

- **[T]** Per `<script nonce>` / `<style nonce>` element: nonce sha256 + post-load nonce-getter return (Chromium hides nonce post-load).

## LLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page `<style media=print>` block usage

- **[T]** Per page: per-`media` attribute style-block byte count.

## MMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page `<link blocking=render>` usage

- **[T]** Per `<link rel=stylesheet blocking=render>` / `<link rel=preload as=script blocking=render>`: render-blocking declarations + observed blocking behavior.

## NNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page `<script blocking=render>` usage

- **[T]** Per `<script blocking=render>` element: declared count + actual render-blocking observed.

## OOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page `<script async type=module>` usage

- **[T]** Per page: classic vs module script count + async vs defer attribute distribution within each.

## PPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page `<script type=importmap-shim>` polyfill detection

- **[T]** Per page: presence of well-known polyfills via `<script>` src patterns — `core-js`, `polyfill.io`, `cdnjs.cloudflare.com/ajax/libs/polyfill`, `es-module-shims`.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page `requireActorJS` import detection (Discourse-style)

- **[T]** Per page: presence of well-known JS namespaces — `define`, `require` (AMD), `webpackChunk*`, `__webpack_require__`, `System`, `parcelRequire`, `module.exports`, `viteExpress`.

## RRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page bundler artifact detection

- **[T]** Per page: webpack chunk-load events (`window.webpackChunk*` calls); Vite HMR ping; Snowpack ESM imports; Parcel runtime; Rollup chunk format.

## SSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Service-Worker scope cache write

- **[T]** Per SW: total cache.put calls + total cache.delete calls over session.
- **[T]** Per SW: total clients.matchAll() calls.

## TTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page `<link rel=stylesheet disabled>` toggle log

- **[T]** Per `<link rel=stylesheet>`: `disabled` attribute toggle events + active state at session end.

## UUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page alternate stylesheet selection log

- **[T]** Per page: `<link rel=alternate stylesheet>` elements + which was selected by user preference.

## VVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page `<link rel=stylesheet>` cross-origin redirect chain

- **[T]** Per stylesheet load: redirect chain count + final URL.

## WWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page background sync ID enumeration

- **[T]** Per origin: ServiceWorker SyncManager getTags() result.
- **[T]** Per origin: BackgroundSync registration events.

## XXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page PeriodicSync ID enumeration

- **[T]** Per origin: PeriodicSyncManager getTags() + minInterval distribution.

## YYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Push subscription expiry

- **[T]** Per push subscription: expirationTime value + days-until-expiry distribution.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Notification action button count

- **[T]** Per displayed Notification: actions[] count + per-action title + icon + type.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page `<link rel=preload as=audio|video|track|font|fetch|document|object|embed|worker|sharedworker>` distribution

- **[T]** Per `<link rel=preload>`: `as` attribute distribution across all 16 documented values.
- **[T]** Per `as=font` preload: `crossorigin` attribute presence (required for cors-restricted fonts).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page `<link rel=expect blocking=render>` Document Subresource Bundle declaration

- **[T]** Per page: `<link rel=expect blocking=render href=foo>` declarations + outcomes.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page `<link rel=privacy-policy>` / `<link rel=terms-of-service>`

- **[T]** Per page: legal-link `rel` attribute usage — `privacy-policy`, `terms-of-service`, `license`, `author`, `me`.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page `<a rel>` link relation distribution

- **[T]** Per anchor: `rel` token list — `noopener`, `noreferrer`, `external`, `me`, `nofollow`, `sponsored`, `ugc`, `tag`, `bookmark`, `prev`, `next`, `help`, `search`, `up`.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Trusted Types policy enforcement count

- **[T]** Per page: `require-trusted-types-for` directive on which sinks.
- **[T]** Per page: violations enforced count + report-only count.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Web App Lifecycle freeze/resume events

- **[T]** Per page: every `freeze` event fired + every `resume` event with timestamp delta.
- **[T]** Per page: discard-restore log via `wasDiscarded` flag check.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Document.adoptedStyleSheets ordering operations

- **[T]** Per page: adoptedStyleSheets reorder events (assign vs push vs unshift).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page `Element.role` IDL attribute usage

- **[T]** Per page: ARIA role IDL property accesses + state queries.
- **[T]** Per page: programmatic role assignments vs HTML role attributes.

## IIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page `Element.ariaLabel` IDL property usage

- **[T]** Per page: ariaLabel / ariaLabelledByElements / ariaDescribedByElements IDL writes.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page `Element.requestPointerLock` outcomes

- **[T]** Per call: outcome (Promise resolved/rejected) + unadjustedMovement flag.
- **[T]** Per page: pointer-lock state transition log.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page `KeyboardLock.lock` outcomes

- **[T]** Per `navigator.keyboard.lock(keyCodes)` call: keyCodes array + outcome.
- **[T]** Per page: keyboard-lock-in-effect duration distribution.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page `Selection.removeAllRanges` vs `empty()` ratio

- **[T]** Per page: Selection API removeAllRanges vs empty() (deprecated) call distribution.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page `Document.scrollingElement` resolution

- **[T]** Per page: `document.scrollingElement` resolution (quirks vs standards mode → different element).

## NNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page legacy `Document.captureEvents` / `releaseEvents` invocation

- **[T]** Per page: deprecated Netscape-era API call presence — if the page calls these, it's a fingerprint.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page `Document.queryCommandValue` lookups

- **[T]** Per page: queryCommandValue calls — command name + return value.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page MathML attribute usage

- **[T]** Per `<math>` element: `display` attribute (block/inline), `overflow` attribute.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Web Component lifecycle callback firing rates

- **[T]** Per custom element class: connectedCallback / disconnectedCallback / attributeChangedCallback / adoptedCallback / formAssociatedCallback fire counts.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page form-associated custom element ElementInternals usage

- **[T]** Per custom element: `setFormValue` / `setValidity` / `reportValidity` call counts.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page TextDecoder fatal error stream

- **[T]** Per TextDecoder with `fatal:true`: TypeError throw count.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page WeakSet / WeakMap proliferation

- **[T]** Per page: `new WeakSet()` / `new WeakMap()` construction count.
- **[T]** Per page: weakly-held reference count at session close.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page `FormData` construction count

- **[T]** Per page: `new FormData()` / `new FormData(form)` calls + per-call entry count.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Response.bytes() / .formData() / .json() / .text() / .arrayBuffer() / .blob() distribution

- **[T]** Per fetched Response: which body-decoder methods are called + total bytes by decoder type.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Request constructor mode/credentials/cache/redirect distribution

- **[T]** Per `new Request(input, init)` call: full init reconstruction — mode (cors/no-cors/same-origin/navigate) + credentials (omit/same-origin/include) + cache (default/no-store/reload/no-cache/force-cache/only-if-cached) + redirect (follow/error/manual).

## XXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page `Headers.append` / `set` / `delete` distribution

- **[T]** Per Headers instance: append vs set vs delete call distribution.
- **[T]** Per page: most-modified header name distribution.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page `URLSearchParams.set` / `append` / `delete` distribution

- **[T]** Per URLSearchParams: mutation call distribution.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Console object identity test

- **[T]** Per page: `Function.prototype.toString.call(console.log)` — surfaces whether console has been monkey-patched (consent-management platforms, observability tools, DevTools attached).

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page setter.toString integrity check

- **[T]** Per page: `Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get)` — surfaces whether the navigator.userAgent getter has been redefined.
- **[T]** Same probe for every spoofable Navigator/Screen/Document/Window getter.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Proxy detection of getOwnPropertyDescriptor results

- **[T]** Per page: configurable / writable / enumerable flags on every Navigator getter — divergence from canonical spec indicates wrapping.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page `Object.setPrototypeOf` call log

- **[T]** Per page: every `Object.setPrototypeOf(target, proto)` invocation — caller stack.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page `Proxy` constructor usage

- **[T]** Per page: `new Proxy(target, handler)` construction count + caller stack.
- **[T]** Per page: which trap functions the handler defines (get / set / has / deleteProperty / ownKeys / etc.).

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page `Reflect.*` call log

- **[T]** Per page: `Reflect.get`, `Reflect.set`, `Reflect.has`, `Reflect.deleteProperty`, `Reflect.ownKeys`, `Reflect.getOwnPropertyDescriptor`, `Reflect.defineProperty`, `Reflect.preventExtensions`, `Reflect.isExtensible`, `Reflect.apply`, `Reflect.construct`, `Reflect.getPrototypeOf`, `Reflect.setPrototypeOf` invocation counts.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page DataView byte-order usage

- **[T]** Per `new DataView(buffer)` construction: byteOffset + byteLength.
- **[T]** Per DataView read/write: little-endian vs big-endian distribution.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page TypedArray subclass distribution

- **[T]** Per page: per TypedArray subclass construction count — Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array, Float16Array, Float32Array, Float64Array.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page `ArrayBuffer.transfer` / `transferToFixedLength` usage

- **[T]** Per ArrayBuffer: transfer-to-fixed-length / resize / detach event log.
- **[T]** Per ArrayBuffer: resizable vs fixed-length distribution.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page `SharedArrayBuffer.grow` usage

- **[T]** Per SAB: grow events + final byteLength.
- **[T]** Per SAB: growable flag at construction.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page `Atomics.pause` (recent) usage

- **[T]** Per page: `Atomics.pause()` (CPU pause hint) call count.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page `Promise.withResolvers` / `Promise.try` / `Promise.allSettled` distribution

- **[T]** Per page: usage counts of modern Promise statics.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Iterator helpers (.map/.filter/.take) chain depth

- **[T]** Per page: Iterator helper invocations + chain depth distribution.
- **[T]** Per page: `Iterator.from`, `.toArray`, `.reduce`, `.forEach`, `.some`, `.every`, `.find` usage counts.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page AsyncIterator helpers

- **[T]** Per page: AsyncIterator.prototype.map / filter / take / drop / flatMap / reduce / toArray / forEach / some / every / find invocations.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page `Object.groupBy` / `Map.groupBy` usage

- **[T]** Per page: groupBy invocations + key callback distribution.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page `Array.prototype.toReversed / toSorted / toSpliced / with` usage

- **[T]** Per page: ES2023 non-mutating Array method usage count.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page `String.prototype.isWellFormed` / `toWellFormed` usage

- **[T]** Per page: well-formed-string method invocation count.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page `RegExp.prototype.unicodeSets` flag usage

- **[T]** Per page: regex with `v` flag construction count + set-notation usage.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page `Map.prototype.emplace` / `Set.prototype.union/intersection/difference/symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom` usage

- **[T]** Per page: modern set/map method usage counts.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page `WeakMap.prototype.getOrInsert` usage (recent)

- **[T]** Per page: getOrInsert / getOrInsertComputed call count.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page `Error.cause` propagation

- **[T]** Per thrown error: presence of `cause` property + nested cause chain depth.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page `AggregateError` construction

- **[T]** Per page: AggregateError construction count + errors[] length distribution.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page `Symbol.dispose` / `Symbol.asyncDispose` usage

- **[T]** Per page: `using` / `await using` declaration count (explicit resource management).

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page `Function.prototype.bind` overhead

- **[T]** Per page: total `Function.prototype.bind` calls — caller stack distribution.
- **[T]** Per page: bound-function execution count.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page `Function.prototype.call/apply` vs Function direct-call ratio

- **[T]** Per page: explicit `.call(this, ...)` / `.apply(this, args)` invocation count.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page lexical-this `()=>` arrow vs `function(){}` declaration count

- **[T]** Per page: arrow-function vs traditional-function-declaration ratio (parsed via AST walk over loaded scripts).

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page `class` declaration vs `function` constructor ratio

- **[T]** Per page: ES6 class declarations vs `function Foo(){}` + `Foo.prototype.method` patterns.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Workers / SharedWorkers vs MessageChannel split

- **[T]** Per page: MessageChannel vs Worker.postMessage vs BroadcastChannel byte-volume distribution.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page TransferableObject distribution

- **[T]** Per postMessage call: transfer[] entries by type (MessagePort/ArrayBuffer/ImageBitmap/OffscreenCanvas/ReadableStream/WritableStream/TransformStream/AudioData/VideoFrame).

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page `OffscreenCanvas.transferToImageBitmap` usage

- **[T]** Per OffscreenCanvas: transferToImageBitmap / convertToBlob call distribution.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page ImageBitmap close() lifecycle

- **[T]** Per ImageBitmap: created vs explicitly-closed count delta (handle leak detection).

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page VideoFrame allocation log

- **[T]** Per VideoFrame: codedWidth/codedHeight/format/timestamp + close() lifecycle tracking.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page AudioData allocation log

- **[T]** Per AudioData: numberOfChannels/sampleRate/numberOfFrames/format + close() lifecycle.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page EncodedVideoChunk / EncodedAudioChunk dump

- **[T]** Per chunk: type (key/delta) + byteLength + timestamp.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page `<source srcset>` candidate parsed list

- **[T]** Per `<source srcset>`: each candidate URL + density descriptor + width descriptor + selected candidate.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page `<img>` `sizes` attribute resolution

- **[T]** Per `<img sizes>`: declared sizes media queries + resolved size at current viewport.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Media Session position polling

- **[T]** Per page with MediaSession: per-second position snapshots (when active).

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Service Worker waitUntil() promise chain

- **[T]** Per fetch event: waitUntil() promise count + cumulative resolved time.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Service Worker respondWith() async flow

- **[T]** Per fetch event: respondWith resolution latency + final Response source (cache vs network vs constructed).

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page navigation.transition state

- **[T]** Per soft navigation: `navigation.transition.from` and `navigation.transition.navigationType`.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page navigation.canIntercept boolean per navigation

- **[T]** Per navigate event: canIntercept flag + intercept() called or not.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page `<a download>` attribute usage

- **[T]** Per `<a download>` element: download attribute value + click outcome.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Browser sniffing meta tags

- **[T]** Per page: `<meta name="apple-mobile-web-app-capable">`, `<meta name="apple-mobile-web-app-status-bar-style">`, `<meta name="application-name">`, `<meta name="msapplication-*">` tag set.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Open Graph image array

- **[T]** Per page: og:image + og:image:width + og:image:height + og:image:type repetitions.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page JSON-LD blob enumeration

- **[T]** Per page: all `<script type="application/ld+json">` blob count + per-blob byte size + per-blob @type vocabulary.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page `<link rel=alternate type=application/atom+xml>` syndication feed

- **[T]** Per page: RSS/Atom feed link presence + href.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page `<link rel=pingback>` / `<link rel=webmention>` discovery

- **[T]** Per page: indieweb endpoint advertisements.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page WebFinger / nostr / activitypub markers

- **[T]** Per page: ActivityPub / Mastodon / nostr meta-tag presence (decentralized social fingerprints).

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page brave-rewards / brave-search markers

- **[T]** Per page: presence of Brave-specific globals (`brave` property on navigator) + rewards meta tags.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page anti-bot dispatcher detection

- **[T]** Per page: presence of known classifier client SDKs — PerimeterX (`_pxAppId`, `_pxhd`), DataDome (`__cf`, `dd_*`), Cloudflare Turnstile (`turnstile` global), hCaptcha (`hcaptcha`), reCAPTCHA Enterprise (`grecaptcha.enterprise`), Arkose (`fc-token`, `arkose-cdn.com`), Imperva (`incap_ses_*`), Akamai BotManager (`_abck`, `bm_sz`), F5 Distributed Cloud (`f5avr`), Kasada (`KP_UIDz`).

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page tracking-pixel detection

- **[T]** Per page: image requests to known analytics endpoints (`google-analytics.com/collect`, `facebook.com/tr`, `analytics.tiktok.com`, `analytics.twitter.com`, `linkedin.com/li.lms-analytics/insight.min.js`, `bat.bing.com/action`, etc.) — fired count.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page session-recording script detection

- **[T]** Per page: presence of session-recording vendor scripts — FullStory, Hotjar, LogRocket, Mouseflow, Quantum Metric, Pendo, Heap, Smartlook, Inspectlet, Lucky Orange.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page AI vendor script detection

- **[T]** Per page: presence of LLM/AI vendor SDKs — OpenAI SDK, Anthropic SDK, Replicate, ElevenLabs, Pinecone, LangChain Web, Vercel AI SDK, Anthropic Web SDK.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page payment-vendor SDK detection

- **[T]** Per page: presence of Stripe.js (`Stripe()`), Adyen, Braintree, PayPal SDK, Apple Pay JS, Google Pay JS, Klarna, Affirm, Afterpay, Sezzle global SDK detection.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page support-chat SDK detection

- **[T]** Per page: Intercom, Zendesk, Drift, Crisp, LiveChat, Tawk.to, HubSpot Chat, Olark, Tidio, Help Scout, Salesforce LiveAgent, Front Chat global presence.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page tag-management platform detection

- **[T]** Per page: Google Tag Manager (`gtm.js`), Segment (`analytics.js`/`snippet`), Tealium IQ, Adobe Launch / DTM, Ensighten, Matomo Tag Manager presence.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page consent-management platform detection

- **[T]** Per page: OneTrust (`OneTrust`/`OptanonConsent`), Cookiebot, TrustArc, Quantcast Choice (`__tcfapi`), Sourcepoint, Didomi, Usercentrics, Iubenda, Termly global presence.
- **[T]** Per page: `__tcfapi` function presence (TCF v2.x) + `__gpp` (Global Privacy Platform).

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page A/B framework detection

- **[T]** Per page: Optimizely (`window.optimizely`), VWO (`window._vwo_*`), Google Optimize (`window.dataLayer` + `optimize.container.id`), Adobe Target (`mbox.js`), Statsig (`statsig`), LaunchDarkly (`ld.client`), Split.io, Eppo, GrowthBook detection.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page recommendation-engine detection

- **[T]** Per page: Algolia (`window._algolia*`), Coveo, Bloomreach, Constructor.io, Klevu, Yotpo, Bazaarvoice global presence.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page commerce platform JS detection

- **[T]** Per page: Shopify (`window.Shopify`), Magento (`require([...])`), WooCommerce (`wc_*` cookies), Salesforce Commerce Cloud, BigCommerce, Spree, Solidus, Sylius.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page CRM / sales SDK detection

- **[T]** Per page: HubSpot (`window._hsq`), Marketo (`MunchkinJS`), Pardot, Mailchimp Mandrill, ActiveCampaign, Iterable, Customer.io, Braze, OneSignal global SDK presence.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page video-player SDK detection

- **[T]** Per page: Video.js (`window.videojs`), JW Player, Shaka Player, hls.js (`window.Hls`), dash.js (`dashjs`), Mux Data, Bitmovin, Brightcove, Vimeo Player, YouTube IFrame API.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page CDN SDK detection

- **[T]** Per page: presence of Cloudflare Workers Rocket Loader, Fastly Compute@Edge, Akamai EdgeWorkers, Vercel Edge Middleware, Netlify Edge Functions runtime markers.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page UI library detection

- **[T]** Per page: Material UI (`MuiThemeProvider`), Ant Design (`antd-*`), Tailwind (`window.tailwind`), Bootstrap (`bootstrap.*`), Chakra UI, Mantine, Radix UI, shadcn/ui markers, Bulma, Foundation global classes.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page state-management library detection

- **[T]** Per page: Redux (`__REDUX_DEVTOOLS_EXTENSION__`), MobX, Zustand, Recoil, Jotai, XState, Apollo Client (`__APOLLO_CLIENT__`), React Query (`window.queryClient`).

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page i18n library detection

- **[T]** Per page: react-intl, i18next (`window.i18next`), formatjs, lingui, vue-i18n, ngx-translate, Polyglot, LinguiJS global presence.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page form-library detection

- **[T]** Per page: react-hook-form, Formik, react-final-form, Yup, Zod, Joi, valibot global presence.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page testing-instrumentation detection

- **[T]** Per page: Cypress (`window.Cypress`), Playwright (`window.playwright`), Puppeteer (`navigator.webdriver === true`), Selenium (`window.document.documentElement.getAttribute('webdriver')`), WebDriverIO, TestCafe traces.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Web3 / crypto wallet SDK detection

- **[T]** Per page: `window.ethereum` (MetaMask / Coinbase Wallet / Phantom), `window.solana`, `window.tronWeb`, `window.cardano`, `window.aptos`, `window.suiWallet`, WalletConnect global presence.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page hardware wallet bridge detection

- **[T]** Per page: Ledger Live Bridge, Trezor Connect, Keystone, GridPlus Lattice, Tangem global presence.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page SSO bridge detection

- **[T]** Per page: Auth0 (`window.auth0`), Okta (`window.okta`), Firebase Auth (`firebase.auth`), Amazon Cognito, Stytch, Clerk, SuperTokens, NextAuth global presence.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page WebSocket client library detection

- **[T]** Per page: Socket.IO (`io`), SockJS (`SockJS`), Phoenix Channels (`Phoenix`), ActionCable (`createConsumer`), Ably (`Ably.Realtime`), Pusher (`Pusher`), Centrifuge.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page real-time DB SDK detection

- **[T]** Per page: Firebase Realtime DB (`firebase.database`), Supabase (`window.supabase`), Convex, Liveblocks, PartyKit, PowerSync global presence.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page graphics library detection

- **[T]** Per page: Three.js (`THREE`), Babylon.js (`BABYLON`), PixiJS (`PIXI`), Phaser, ZIM, p5.js (`p5`), Konva, Fabric.js, Two.js, PlayCanvas global presence.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page chart library detection

- **[T]** Per page: Chart.js, D3 (`d3`), Highcharts, Plotly, ECharts, ApexCharts, Recharts, Victory, Nivo, Visx global presence.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page map library detection

- **[T]** Per page: Google Maps (`google.maps`), Mapbox GL (`mapboxgl`), Leaflet (`L`), MapLibre, Cesium, OpenLayers (`ol`), Apple MapKit JS, ArcGIS API global presence.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page editor library detection

- **[T]** Per page: TinyMCE, CKEditor, Quill, Slate, Lexical, ProseMirror, Tiptap, Monaco Editor (`monaco`), CodeMirror (`CodeMirror`), Ace Editor (`ace`) global presence.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page ads vendor SDK detection

- **[T]** Per page: Google AdSense, Google Ad Manager (`googletag`), Amazon Publisher Services (`apstag`), Prebid.js (`pbjs`), Criteo, OpenX, AppNexus / Xandr, PubMatic, Index Exchange, Magnite global presence.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page captcha vendor diversity

- **[T]** Per page: simultaneous captcha vendor presence (page uses BOTH reCAPTCHA and Cloudflare Turnstile, etc.).
- **[T]** Per captcha vendor: site key extracted + invocation count.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page browser-extension residual XHR fingerprint

- **[T]** Per page: any XHR requests originating from extension content scripts — Chromium sets `initiator: 'other'` and the request URL points to extension-owned hosts.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page MV3 vs MV2 extension capability detection

- **[T]** Per page: extensions visible via DOM injection — distinguish MV3 declarativeNetRequest behavior vs MV2 webRequest-blocking behavior.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Element internals form validation message

- **[T]** Per ElementInternals: setValidity flags + validationMessage string.
- **[T]** Per form: reported validity per submit attempt.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page constraint validation custom message distribution

- **[T]** Per input element: `setCustomValidity(message)` call log.
- **[T]** Per page: distribution of custom validation messages by element.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page `<select>` option list mutation

- **[T]** Per `<select>` element: option-add / option-remove / option-reorder events.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page `<optgroup>` usage

- **[T]** Per `<select>`: optgroup count + nested options per group.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page `<fieldset disabled>` chain

- **[T]** Per `<form>`: nested fieldset disabled-chain effective state per control.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page `<button formaction|formmethod|formenctype|formtarget|formnovalidate>` overrides

- **[T]** Per submit button: formaction/formmethod/formenctype/formtarget/formnovalidate attribute presence.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page form `accept-charset` attribute

- **[T]** Per `<form>`: accept-charset value distribution (typically utf-8 but legacy sites differ).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page form `autocomplete=off` ratio

- **[T]** Per page: per-form autocomplete attribute value + per-field autocomplete-override count.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page `<table>` semantic structure

- **[T]** Per `<table>`: `<thead>`, `<tbody>`, `<tfoot>`, `<colgroup>`, `<col>`, `<caption>` presence count + row/cell distribution.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page `<table>` accessibility attributes

- **[T]** Per `<th>`: scope attribute distribution (row/col/rowgroup/colgroup/auto).
- **[T]** Per `<th>`/`<td>`: headers attribute references.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page `<ol type|reversed|start>` distribution

- **[T]** Per `<ol>` element: type attribute (1/a/A/i/I/none) + reversed flag + start integer.
- **[T]** Per `<li>`: value attribute override count.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page `<time datetime>` distribution

- **[T]** Per `<time datetime>` element: datetime parsed format + content text presence.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page `<abbr title>` distribution

- **[T]** Per `<abbr>` element: title attribute byte size distribution.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page `<bdi>` / `<bdo dir>` distribution

- **[T]** Per page: bidirectional-isolation element count + `<bdo dir>` direction overrides.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page `<ruby>` / `<rt>` / `<rp>` annotation count

- **[T]** Per page: Asian-script ruby annotation count + rt/rp child distribution.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page `<wbr>` soft-break count

- **[T]** Per page: `<wbr>` element count.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page `<picture>` art-direction count

- **[T]** Per `<picture>`: per-source media query attribute presence (art direction signal).

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page CSS `view-transition-class` distribution

- **[T]** Per element with `view-transition-class`: declared class values + scope.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page CSS `:has()` selector usage

- **[T]** Per stylesheet: `:has(...)` selector occurrence count.
- **[T]** Per page: parent-selector usage (Chrome's recent CSS feature) — heavy use suggests modern framework.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page CSS `:is()` / `:where()` selector grouping usage

- **[T]** Per stylesheet: `:is(...)` and `:where(...)` count distribution.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page CSS `:not(complex)` selector usage

- **[T]** Per stylesheet: `:not(...)` selector with non-simple argument count.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page CSS attribute selector with `i` flag

- **[T]** Per stylesheet: case-insensitive attribute selector count (`[type="text" i]`).

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page CSS combinator distribution

- **[T]** Per stylesheet: descendant (` `) vs child (`>`) vs adjacent-sibling (`+`) vs general-sibling (`~`) combinator distribution.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page CSS `::before` / `::after` pseudo-element count

- **[T]** Per stylesheet: generated-content rule count for `::before`, `::after`, `::marker`, `::placeholder`, `::file-selector-button`, `::backdrop`, `::selection`, `::first-line`, `::first-letter`.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Performance Timeline buffer settings

- **[T]** Per page: `performance.setResourceTimingBufferSize(n)` calls + final buffer size.
- **[T]** Per page: `performance.clearResourceTimings` / `clearMarks` / `clearMeasures` call distribution.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page `userAgentData.brands` exact equality vs UA string

- **[T]** Per page: `navigator.userAgentData.brands` value vs `navigator.userAgent` value cross-check — divergence indicates spoofing layer.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Intl segmenter iteration boundary

- **[T]** Per `new Intl.Segmenter(locale, opts)`: locale + granularity + segments delivered per known input.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page Intl PluralRules / RelativeTimeFormat / DisplayNames outputs

- **[T]** Per `Intl.PluralRules('en').select(N)` for N in known set: outputs.
- **[T]** Per `Intl.RelativeTimeFormat('en','always').format(-3, 'day')` round-trips.
- **[T]** Per `Intl.DisplayNames('en',{type:'language'}).of('zh-Hant')` round-trips.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Intl Collator.compare ordering matrix

- **[T]** Per page: `Intl.Collator('en').compare(a,b)` outputs across a known matrix of 50+ string pairs.
- **[T]** Per locale: same matrix — surfaces ICU version + collation tailoring data.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page browser-locale-aware string upper/lower

- **[T]** Per page: `'i'.toLocaleUpperCase('tr-TR')` → 'İ' (Turkish dotted-i edge case).
- **[T]** Per page: `'ß'.toLocaleUpperCase('de-DE')` → 'SS' vs 'ẞ'.
- **[T]** Per page: 30+ locale-sensitive case-transformation test cases.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page IndexedDB `KeyRange` traversal pattern

- **[T]** Per IDB cursor: KeyRange bounds + direction (next/nextunique/prev/prevunique).
- **[T]** Per cursor: items iterated count.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page WebCrypto algorithm coverage

- **[T]** Per `crypto.subtle.generateKey` / `importKey` / `exportKey` / `encrypt` / `decrypt` / `sign` / `verify` / `deriveKey` / `deriveBits` / `digest` / `wrapKey` / `unwrapKey` call: algorithm name + algorithm params + outcome.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page WebCrypto algorithm-name coverage matrix

- **[T]** Per page: for each algorithm name (`RSASSA-PKCS1-v1_5`, `RSA-PSS`, `RSA-OAEP`, `ECDSA`, `ECDH`, `Ed25519`, `Ed448`, `X25519`, `X448`, `AES-CTR`, `AES-CBC`, `AES-GCM`, `AES-KW`, `HMAC`, `HKDF`, `PBKDF2`), `crypto.subtle.generateKey` with a known config — outcome (success / NotSupportedError).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page `crypto.subtle.digest` algorithm matrix

- **[T]** Per page: digest test for SHA-1 / SHA-256 / SHA-384 / SHA-512 over a known input — output bytes hash.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page TextEncoder utf-16 fallback (not supported but probed)

- **[T]** `new TextEncoder('utf-16')` throws (spec) vs implementation-specific accepts (rare) — outcome.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page TextDecoder available encoding list

- **[T]** Per page: `new TextDecoder(name)` for known IANA names (gbk/big5/euc-jp/koi8-r/iso-8859-1/...) — which succeed.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page CompressionStream supported format matrix

- **[T]** Per page: `new CompressionStream('gzip'|'deflate'|'deflate-raw')` — which succeed.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page CSS `:focus-visible` activation rules

- **[T]** Per page: when does `:focus-visible` activate vs `:focus` alone — keyboard-vs-mouse focus-state divergence.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Element scroll-snap stop count

- **[T]** Per snap-container: snap-stop events fired + index per stop.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Pointer Events pen + eraser detail

- **[T]** Per pen event: tiltX/tiltY/twist/tangentialPressure values.
- **[T]** Per eraser event: same.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Browser-side print preview rendering

- **[T]** Per `window.print()` call: print-preview rendered PDF byte hash.
- **[T]** Per page: print-preview opened count.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page MediaRecorder recording quality

- **[T]** Per `MediaRecorder({mimeType, bitsPerSecond, audioBitsPerSecond, videoBitsPerSecond})`: per-config bytes-per-second observed.
- **[T]** Per recording: chunk size distribution + total duration.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page MediaSource attaching to which element

- **[T]** Per MediaSource: which `<video>` / `<audio>` element it's attached to (HTMLMediaElement reference).
- **[T]** Per SourceBuffer: total `appendBuffer` byte count + `remove(start,end)` call distribution.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page `URL.canParse` behavior on edge inputs

- **[T]** Per page: known-edge URL inputs (`""`, `"http://"`, `"https://a"`, `"//x"`, `"file:///"`, `"data:,A"`, `"javascript:1"`, IPv6 with brackets, IDN) → URL.canParse outcomes.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page native DOM `Element.parentNode` performance

- **[T]** Per page: total `parentNode` reads.
- **[T]** Per page: deepest DOM-traversal observed (parentNode walk depth).

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page `Document.body.parentElement` chain

- **[T]** Per page: documentElement → body → main-content child tree depth distribution.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page native DOM tree-walking API usage

- **[T]** Per page: `document.createNodeIterator()` + `document.createTreeWalker()` call count + per-call filter functions.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page CSS `outline-color` / `outline-style` / `outline-width` distribution

- **[T]** Per page: outline declaration count + per-property value distribution.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page CSS `appearance` property usage

- **[T]** Per page: `appearance: none` / `auto` / `button` / `textfield` declaration count.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page CSS form-control system-styling reset count

- **[T]** Per page: how many form controls have `appearance: none` applied (resetting native UA styles).

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page CSS `caption-side` distribution

- **[T]** Per `<table>` with `<caption>`: caption-side value (top/bottom/inline-start/inline-end).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page CSS `empty-cells` distribution

- **[T]** Per `<table>`: empty-cells value (show/hide).

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page CSS `table-layout` distribution

- **[T]** Per `<table>`: table-layout value (auto/fixed).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page CSS `border-collapse` distribution

- **[T]** Per `<table>`: border-collapse value (separate/collapse) + border-spacing per side.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page CSS `direction: rtl` declaration count

- **[T]** Per page: explicit `direction: rtl` declarations vs inherited from `<html dir>`.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page CSS `unicode-bidi` distribution

- **[T]** Per page: `unicode-bidi: normal|embed|isolate|bidi-override|isolate-override|plaintext` usage.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page CSS `writing-mode` distribution

- **[T]** Per page: writing-mode value (`horizontal-tb` / `vertical-rl` / `vertical-lr` / `sideways-rl` / `sideways-lr`) declaration count.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page CSS `text-combine-upright` distribution

- **[T]** Per page: text-combine-upright declaration count (East-Asian typography signal).

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page CSS `text-orientation` distribution

- **[T]** Per page: text-orientation value (mixed/upright/sideways) usage.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page CSS `letter-spacing` + `word-spacing` distribution

- **[T]** Per page: declared letter-spacing values + word-spacing values distribution.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page CSS `tab-size` distribution

- **[T]** Per page: declared tab-size values.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page CSS `white-space` distribution

- **[T]** Per page: `white-space: normal|nowrap|pre|pre-wrap|pre-line|break-spaces` distribution.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page CSS `overflow-wrap` / `word-break` distribution

- **[T]** Per page: overflow-wrap and word-break value distribution.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page CSS `text-overflow: ellipsis` count

- **[T]** Per page: text-overflow declaration count + ellipsis usage.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page CSS `line-clamp` / `-webkit-line-clamp` count

- **[T]** Per page: line-clamp / -webkit-line-clamp usage (mobile-style truncation).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page CSS `aspect-ratio` distribution

- **[T]** Per page: aspect-ratio declaration distribution (16/9, 4/3, 1/1, 21/9, etc.).

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page CSS `object-fit` / `object-position` distribution

- **[T]** Per page: object-fit value (`fill`/`contain`/`cover`/`none`/`scale-down`) distribution + per-element object-position.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page CSS `background-attachment: fixed` count

- **[T]** Per page: fixed-attachment background count (performance signal).

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page CSS `background-clip` distribution

- **[T]** Per page: background-clip value (`border-box`/`padding-box`/`content-box`/`text`) usage.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page CSS `border-image` usage

- **[T]** Per page: border-image-source declaration count + per-source URL or gradient.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page CSS gradient function distribution

- **[T]** Per page: linear-gradient / radial-gradient / conic-gradient / repeating-* gradient function usage count.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page CSS `color()` / `color-mix()` function usage

- **[T]** Per page: usage count of modern color-function syntax (named here in OOOOOOOOOOOOOOO; deeper: per-function arg pattern).

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page CSS variable computation chain

- **[T]** Per page: `var(--foo, fallback)` chain depth + fallback presence frequency.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page CSS `env()` variable usage

- **[T]** Per page: `env(safe-area-inset-top|right|bottom|left)` / `env(keyboard-inset-*)` declaration count.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page CSS calc() depth distribution

- **[T]** Per page: `calc()` invocation count + nesting depth distribution.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page CSS `min()` / `max()` / `clamp()` usage

- **[T]** Per page: math-comparison function usage count.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page CSS `pow()` / `log()` / `exp()` / `sqrt()` / `sin()` / `cos()` / `tan()` / `mod()` / `rem()` / `abs()` / `sign()` / `round()` / `hypot()`

- **[T]** Per page: usage count of CSS math functions (recent additions).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page CSS `if()` conditional (recent)

- **[T]** Per page: CSS `if()` conditional usage count.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page CSS `light-dark()` color function

- **[T]** Per page: light-dark() function usage count + resolved color per scheme.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page CSS `attr()` advanced syntax usage

- **[T]** Per page: `attr(name type, fallback)` calls (modern attr() typed reads).

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page CSS `:state(...)` custom-state pseudo

- **[T]** Per custom element with ElementInternals: states list set + matched-CSS-selector count.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page CSS `@property syntax="<color>" inherits="false"` registration count

- **[T]** Per page: per-syntax type distribution (`<length>`, `<color>`, `<percentage>`, `<integer>`, `<number>`, `<angle>`, `<time>`, `<resolution>`, `<image>`, `<url>`, `<transform-function>`, `<transform-list>`, `*`).

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page CSS `@font-palette-values` declaration

- **[T]** Per page: font-palette-values rules + base-palette + override-colors count.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page CSS `font-synthesis` declaration

- **[T]** Per page: font-synthesis-weight / -style / -small-caps usage.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page CSS `font-optical-sizing` usage

- **[T]** Per page: font-optical-sizing value (auto/none) declarations.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page CSS `font-variant-emoji` usage

- **[T]** Per page: font-variant-emoji (`auto` / `text` / `emoji` / `unicode`) usage.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page CSS `font-stretch` distribution

- **[T]** Per page: font-stretch declarations (ultra-condensed / extra-condensed / condensed / semi-condensed / normal / semi-expanded / expanded / extra-expanded / ultra-expanded / %).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page CSS `font-size-adjust` distribution

- **[T]** Per page: font-size-adjust value distribution (ex-height/cap-height/ch-width/ic-width/ic-height/none).

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page CSS `quotes` distribution

- **[T]** Per page: quotes property values (auto/none/string pairs) usage.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page CSS `list-style-image` distribution

- **[T]** Per page: list-style-image URL usage (custom bullets).

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page CSS `list-style-type` distribution

- **[T]** Per page: list-style-type value distribution (disc/circle/square/decimal/lower-roman/upper-roman/lower-alpha/upper-alpha/...).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page CSS `cursor` value distribution

- **[T]** Per page: cursor value distribution (auto / default / none / context-menu / help / pointer / progress / wait / cell / crosshair / text / vertical-text / alias / copy / move / no-drop / not-allowed / grab / grabbing / e-resize / n-resize / ne-resize / nw-resize / s-resize / se-resize / sw-resize / w-resize / ew-resize / ns-resize / nesw-resize / nwse-resize / col-resize / row-resize / all-scroll / zoom-in / zoom-out / url()).

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page CSS `resize` property distribution

- **[T]** Per page: resize property values (none / both / horizontal / vertical / block / inline).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page CSS `place-self` shorthand usage

- **[T]** Per page: place-self / place-items / place-content shorthand usage count.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page CSS `gap` shorthand usage

- **[T]** Per page: gap / row-gap / column-gap usage in flex + grid containers.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page CSS `grid-template-rows` / `grid-template-columns` complexity

- **[T]** Per page: grid track count distribution + use of `repeat()`, `minmax()`, `auto-fill`, `auto-fit`, `fit-content()`, `subgrid` value distribution.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page CSS `grid-template-areas` declaration

- **[T]** Per page: grid-template-areas string distribution + area name count.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page CSS `grid-area` named-area assignments

- **[T]** Per page: per-element grid-area assignment count + named-area resolution.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page CSS `display: grid` vs `display: flex` vs `display: block` distribution

- **[T]** Per page: rendered display-value distribution histogram per visible element (Grid / Flex / Block / Inline / Inline-Block / Inline-Flex / Inline-Grid / Contents / None / Table / Table-Cell).

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page CSS `position: sticky` / `fixed` / `absolute` / `relative` distribution

- **[T]** Per page: position value distribution histogram + sticky-element scroll-binding behavior.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page CSS `z-index` declaration distribution

- **[T]** Per page: z-index value distribution + stacking context count.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page CSS `transform` 3D vs 2D usage

- **[T]** Per page: transform function distribution (translate/translateX/Y/Z/3d, rotate/X/Y/Z/3d, scale/X/Y/Z/3d, skew/X/Y, matrix/3d, perspective).

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page CSS `perspective` value distribution

- **[T]** Per page: perspective declarations + perspective-origin values.
- **[T]** Per page: backface-visibility value (visible / hidden) distribution.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page CSS `transform-style` distribution

- **[T]** Per page: transform-style value (`flat`/`preserve-3d`) usage.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page CSS `mix-blend-mode` per-element distribution

- **[T]** Per page: count of elements with non-`normal` mix-blend-mode (already in CCCCCCCCCCCCCCCC; here per-element with selector-path).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page CSS `isolation: isolate` element count

- **[T]** Per page: count of elements with `isolation: isolate` (stacking-context creator).

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page CSS `paint-order` distribution

- **[T]** Per page: paint-order value distribution (text/SVG).

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page CSS `view-transition-class` distribution (deep)

- **[T]** Per page: view-transition-class declarations + class-list resolution per element.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page CSS `animation-composition` distribution

- **[T]** Per page: animation-composition value (replace/add/accumulate) usage.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page CSS `animation-timeline` distribution

- **[T]** Per page: animation-timeline value (auto / `--scroll-timeline` / `--view-timeline` / none) usage.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page CSS `animation-range-start` / `animation-range-end` distribution

- **[T]** Per page: scroll-driven animation range declarations.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page CSS `timeline-scope` declarations

- **[T]** Per page: timeline-scope declarations + parent-scope inheritance.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page CSS `transition-behavior: allow-discrete` usage

- **[T]** Per page: transition-behavior declarations (recent feature for discrete-property transitions).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page CSS `@starting-style` block count

- **[T]** Per page: @starting-style rules + transitioning-element count.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page CSS `interpolate-size: allow-keywords` declaration

- **[T]** Per page: interpolate-size value count (recent feature for auto/min-content/max-content transitions).

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page CSS `field-sizing` declaration

- **[T]** Per page: field-sizing value (`fixed` / `content`) on form controls.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page CSS `text-emphasis` declarations

- **[T]** Per page: text-emphasis-style / text-emphasis-color / text-emphasis-position usage.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page CSS `forced-color-adjust` distribution

- **[T]** Per page: forced-color-adjust value (`auto` / `none` / `preserve-parent-color`) usage.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page CSS `print-color-adjust` declarations

- **[T]** Per page: print-color-adjust / `-webkit-print-color-adjust` value (economy/exact).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page CSS `widows` / `orphans` distribution

- **[T]** Per page: widows + orphans values per text block.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page CSS `box-decoration-break` distribution

- **[T]** Per page: box-decoration-break value (slice/clone) usage.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page CSS `outline-offset` distribution

- **[T]** Per page: outline-offset value distribution.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page CSS `inset` shorthand vs longhand usage

- **[T]** Per page: inset / inset-block / inset-inline shorthand usage count.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page CSS `margin-trim` distribution

- **[T]** Per page: margin-trim value (`none` / `block-start` / `block-end` / etc.) usage.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page CSS `text-box-trim` / `text-box-edge` distribution

- **[T]** Per page: text-box-trim + text-box-edge declarations (modern leading-trim feature).

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page CSS `content-visibility` value distribution

- **[T]** Per page: content-visibility (auto / hidden / visible) declarations.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page CSS `border-spacing` distribution

- **[T]** Per page: border-spacing value distribution per table.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page CSS `vertical-align` distribution

- **[T]** Per page: vertical-align value distribution (baseline / top / middle / bottom / text-top / text-bottom / super / sub / length / percentage).

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Touch event surface gestures

- **[T]** Per touchstart event: changedTouches per-touch identifier + clientX/Y / screenX/Y / pageX/Y / radiusX/Y / rotationAngle / force / altitudeAngle / azimuthAngle / touchType (direct/stylus).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page WheelEvent deltaMode / phase signal

- **[T]** Per wheel event: deltaX/Y/Z + deltaMode (PIXEL/LINE/PAGE) + ctrlKey/metaKey flag (Ctrl+wheel = zoom signal).

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page MouseEvent button + buttons mask distribution

- **[T]** Per mouse event: button (0/1/2/3/4/5) + buttons bitmask (1/2/4/8/16 combinations).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page KeyboardEvent code distribution

- **[T]** Per keydown/keyup: key + code (physical key identifier) + location (standard/left/right/numpad) + repeat + isComposing.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page InputEvent inputType taxonomy

- **[T]** Per input event: inputType value (`insertText` / `insertReplacementText` / `insertLineBreak` / `insertParagraph` / `insertOrderedList` / `insertUnorderedList` / `insertHorizontalRule` / `insertFromYank` / `insertFromDrop` / `insertFromPaste` / `insertFromPasteAsQuotation` / `insertTranspose` / `insertCompositionText` / `insertLink` / `deleteWordBackward` / `deleteWordForward` / `deleteSoftLineBackward` / `deleteSoftLineForward` / `deleteEntireSoftLine` / `deleteHardLineBackward` / `deleteHardLineForward` / `deleteByDrag` / `deleteByCut` / `deleteContent` / `deleteContentBackward` / `deleteContentForward` / `historyUndo` / `historyRedo` / `formatBold` / `formatItalic` / `formatUnderline` / etc.).

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page BeforeInputEvent default-prevented count

- **[T]** Per beforeinput event: preventDefault() called or not — distinguishes interception by libraries (rich-text editors).

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page ClipboardEvent isTrusted distribution

- **[T]** Per copy / cut / paste event: isTrusted flag + presence of clipboardData.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page ContextMenu event default-prevented count

- **[T]** Per contextmenu event: preventDefault() called or not (right-click suppression).

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Selectstart event default-prevented count

- **[T]** Per selectstart event: preventDefault() called (text-selection suppression).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page DragStart event dataTransfer setting

- **[T]** Per dragstart event: dataTransfer.setData calls + setDragImage call presence + effectAllowed value.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page DragOver dropEffect resolution

- **[T]** Per dragover event: dropEffect value (none/copy/move/link).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Cancellable event default-prevented distribution

- **[T]** Per cancelable event type: % of events where preventDefault() was called.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Capturing-phase listener registration count

- **[T]** Per page: `addEventListener(type, fn, true)` (capture phase) call count.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Passive listener distribution

- **[T]** Per page: `addEventListener(type, fn, {passive: true})` vs default vs passive:false count distribution by event type.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page once listener distribution

- **[T]** Per page: `addEventListener(type, fn, {once: true})` count.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Signal-bound listener distribution

- **[T]** Per page: `addEventListener(type, fn, {signal})` count + per-signal abort count.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Event.composedPath() retraversal

- **[T]** Per dispatched event: composedPath length distribution + cross-shadow-root crossing count.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page DOMException error code distribution

- **[T]** Per page: thrown DOMException name distribution (`AbortError` / `NotAllowedError` / `SecurityError` / `NetworkError` / `QuotaExceededError` / `InvalidStateError` / `InvalidModificationError` / etc.).

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Console-counter / time-named state

- **[T]** Per page: `console.count(label)` final count per label.
- **[T]** Per page: `console.time(label)` / `timeEnd` durations per label.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page localStorage capacity probe

- **[T]** Per origin: attempt setItem of progressively larger values until QuotaExceededError — surfaces actual storage cap.
- **[T]** Per origin: localStorage entry count + total byte size at session close.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page sessionStorage same-tab vs cross-tab divergence

- **[T]** Per origin: sessionStorage entry count + byte size.
- **[T]** Cross-tab sessionStorage isolation observed (spec says isolated per-tab).

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page cookies count + domain distribution

- **[T]** Per page: cookies sent on first navigation (count per Set-Cookie domain).
- **[T]** Per page: per-cookie sameSite / partitioned distribution histogram.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page favicon last-modified date

- **[T]** Per favicon: server Last-Modified header value (when cached).

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Window CustomEvent dispatch log

- **[T]** Per page: every `new CustomEvent(type, {detail})` constructor — type + detail-object byte estimate.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page postMessage origin allowlist

- **[T]** Per page: `iframe.contentWindow.postMessage(msg, targetOrigin)` calls — targetOrigin distribution (wildcards '*' vs explicit origins).

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page MessageEvent origin distribution

- **[T]** Per received message event: origin + source identification + ports[] length distribution.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page DOM XPath query usage

- **[T]** Per page: `document.evaluate(xpath, ...)` call count + per-XPath sha256.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page XSLTProcessor usage

- **[T]** Per page: `new XSLTProcessor()` construction count + transformToFragment call count.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page DOMParser MIME type distribution

- **[T]** Per `new DOMParser().parseFromString(str, type)` call: type value distribution (text/html / text/xml / application/xml / application/xhtml+xml / image/svg+xml).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page XMLSerializer usage

- **[T]** Per page: `new XMLSerializer().serializeToString(node)` call count.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page `<svg>` external script execution attempt

- **[T]** Per SVG element: external `<script>` reference + execution outcome (most CSPs block).

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page SVG animation declaration count

- **[T]** Per SVG: `<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>` element count + per-animation begin/end/dur.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page SMIL `<switch>` conditional rendering

- **[T]** Per SVG: `<switch>` + `<foreignObject>` conditional path used + ignored.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page SVG `<text>` text-rendering distribution

- **[T]** Per SVG text element: text-rendering value + lengthAdjust + textLength + dominant-baseline + alignment-baseline.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page SVG `viewBox` aspect-ratio distribution

- **[T]** Per `<svg>` element: viewBox value + preserveAspectRatio.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Canvas2D color-space distribution

- **[T]** Per Canvas2D context: `getContextAttributes().colorSpace` value (`srgb` vs `display-p3`).

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page CanvasRenderingContext2D `fillStyle` Gradient/Pattern distribution

- **[T]** Per canvas: fillStyle.constructor.name distribution (string / CanvasGradient / CanvasPattern).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page CanvasGradient.addColorStop call distribution

- **[T]** Per gradient: number of color stops added.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page CanvasPattern.setTransform call usage

- **[T]** Per CanvasPattern: setTransform call count + matrix values.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Canvas drawImage source distribution

- **[T]** Per drawImage call: source type (HTMLImageElement / HTMLCanvasElement / HTMLVideoElement / OffscreenCanvas / ImageBitmap / VideoFrame / SVGImageElement / CanvasImageSource).

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Canvas blendmode `globalCompositeOperation` change frequency

- **[T]** Per canvas: GCO state changes per frame (composite-mode toggles indicate complex rendering).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Canvas hit-region usage (deprecated)

- **[T]** Per canvas: addHitRegion / removeHitRegion / clearHitRegions call count.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page WebGL `drawElements` index buffer usage

- **[T]** Per WebGL draw call: drawArrays vs drawElements vs drawElementsInstanced vs drawArraysInstanced distribution.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page WebGL2 transform-feedback session

- **[T]** Per WebGL2 context: beginTransformFeedback / endTransformFeedback call count + primitive mode distribution.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page WebGL2 sampler binding state

- **[T]** Per WebGL2 context: createSampler / bindSampler / samplerParameteri call distribution.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page WebGL2 query object distribution

- **[T]** Per WebGL2 context: query objects (`ANY_SAMPLES_PASSED`, `ANY_SAMPLES_PASSED_CONSERVATIVE`, `TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN`, `TIME_ELAPSED_EXT`) usage.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page WebGPU compute pipeline dispatch sizes

- **[T]** Per `compute_pass.dispatchWorkgroups(x, y, z)` call: workgroup dispatch dimensions.
- **[T]** Per indirect dispatch: source buffer + offset.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page WebGPU render pipeline cache hit-rate

- **[T]** Per WebGPU device: pipeline-cache hit ratio (estimated via repeat pipeline creation latency).

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page WebAudio AudioParam automation count

- **[T]** Per AudioParam: setValueAtTime / linearRampToValueAtTime / exponentialRampToValueAtTime / setTargetAtTime / setValueCurveAtTime / cancelScheduledValues / cancelAndHoldAtTime call distribution.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page AudioBufferSourceNode loop usage

- **[T]** Per ABSN: loop flag + loopStart + loopEnd + start delta / stop delta.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page MediaElementAudioSourceNode crossOrigin handling

- **[T]** Per node: source HTMLMediaElement crossorigin attribute value (anonymous / use-credentials) + resulting audio-graph behavior.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page AudioWorkletProcessor parameter descriptors

- **[T]** Per registered AudioWorkletProcessor: parameterDescriptors array + per-parameter defaultValue / minValue / maxValue / automationRate.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page WebSocket close code distribution

- **[T]** Per WebSocket close: code (1000 / 1001 / 1002 / ...) + reason string + wasClean flag.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Fetch abort reason distribution

- **[T]** Per aborted fetch: AbortSignal.reason value (DOMException / Error / custom value).

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Network::ResourceRequest credentials propagation

- **[T]** Per outgoing fetch: credentials mode resolved (omit/same-origin/include) → cookies attached or not per request.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page CORS preflight OPTIONS request log

- **[T]** Per CORS request: was preflight fired? → preflight URL + Access-Control-Request-Method + Access-Control-Request-Headers.
- **[T]** Per preflight: cache duration via Access-Control-Max-Age.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Cross-Origin-Resource-Policy enforcement

- **[T]** Per outgoing cross-origin subresource: CORP header expected vs received vs blocked.
- **[T]** Per blocked load: Audits issue payload.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Origin trial cache state

- **[T]** Per page: previously-cached Origin Trial tokens applied vs newly-issued via meta tag.
- **[T]** Per origin trial: token bound origin matches current page origin.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Reporting-Endpoints + Report-To header parsed

- **[T]** Per response: Reporting-Endpoints map (modern syntax) + legacy Report-To JSON parsed.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page `Permissions-Policy: ch-*` client-hint policies

- **[T]** Per response: Permissions-Policy ch-* directives delivered + which subframes get which UA-CH.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page `Speculation-Rules` JSON parse

- **[T]** Per page: per-rule prefetch vs prerender vs prefetch-with-subresources strategy + per-URL pattern eagerness (immediate/eager/moderate/conservative).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page X-Frame-Options vs CSP frame-ancestors resolution

- **[T]** Per response: which header (X-Frame-Options vs CSP frame-ancestors) was used + resolved decision.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Resource Loading Hints HTTP/2 PUSH state

- **[T]** Per response: any HTTP/2 PUSH_PROMISE received vs not (HTTP/2 server push, removed from many implementations).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Network::Trial Override headers

- **[T]** Per response: `Sec-Variant-Hints` (variants) / `Sec-Original-Url` / `Sec-CDN-Loop` headers if any.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page connection pool reuse per host

- **[T]** Per host: distinct connection ID count + reuse-per-connection histogram (from NetLog `URL_REQUEST_SOURCE` correlation).

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page HTTP/2 PING frame round-trip distribution

- **[T]** Per HTTP/2 session: PING frame round-trip times per ping.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page HTTP/2 SETTINGS frame distribution

- **[T]** Per HTTP/2 session: SETTINGS frames received — full settings map per frame.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page HTTP/2 WINDOW_UPDATE frame rate

- **[T]** Per HTTP/2 session: WINDOW_UPDATE frame count + per-stream window increment distribution.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page HTTP/2 PRIORITY frame distribution

- **[T]** Per HTTP/2 session: PRIORITY frame count + dependency-tree change frequency.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page HTTP/2 stream-reset RST_STREAM frame distribution

- **[T]** Per HTTP/2 session: RST_STREAM frames + error code distribution.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page HTTP/2 HEADERS frame compressed-vs-uncompressed ratio

- **[T]** Per stream: HEADERS frame compressed byte size vs uncompressed equivalent (HPACK efficiency).

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page HPACK dynamic table state

- **[T]** Per HTTP/2 session: HPACK dynamic table size at connection end + entries added vs evicted count.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page CONTINUATION frame frequency

- **[T]** Per HTTP/2 stream: HEADERS spillover to CONTINUATION frames count (large header values signal).

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page HTTP/2 frame-type histogram

- **[T]** Per HTTP/2 session: count of each frame type (DATA / HEADERS / PRIORITY / RST_STREAM / SETTINGS / PUSH_PROMISE / PING / GOAWAY / WINDOW_UPDATE / CONTINUATION).

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page HTTP/3 stream-type distribution

- **[T]** Per QUIC connection: control / push / qpack-encoder / qpack-decoder stream presence + per-type byte volume.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page QPACK dynamic-table state (HTTP/3)

- **[T]** Per QUIC session: QPACK dynamic table size + per-stream encoder/decoder activity.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page QUIC packet number distribution

- **[T]** Per QUIC connection: packet number space (Initial / Handshake / 1-RTT) packet count.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page QUIC frame type histogram

- **[T]** Per QUIC connection: count of each frame type (PADDING / PING / ACK / RESET_STREAM / STOP_SENDING / CRYPTO / NEW_TOKEN / STREAM / MAX_DATA / MAX_STREAM_DATA / MAX_STREAMS / DATA_BLOCKED / STREAM_DATA_BLOCKED / STREAMS_BLOCKED / NEW_CONNECTION_ID / RETIRE_CONNECTION_ID / PATH_CHALLENGE / PATH_RESPONSE / CONNECTION_CLOSE / HANDSHAKE_DONE).

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page TLS ClientHello cipher-suite order

- **[T]** Per TLS handshake: full ordered cipher-suite list as offered (from pcap decode with SSLKEYLOGFILE).
- **[T]** Per handshake: ordered extension list as offered.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page TLS extension lengths

- **[T]** Per ClientHello: per-extension byte length distribution.
- **[T]** Per ClientHello: GREASE positions in cipher / extension / supported_groups / signature_algorithms / key_share lists.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page TLS supported_groups order

- **[T]** Per ClientHello: ordered named-group list (x25519 / secp256r1 / secp384r1 / x448 / etc.).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page TLS signature_algorithms order

- **[T]** Per ClientHello: ordered sigalg list (rsa_pss_rsae_sha256 / ecdsa_secp256r1_sha256 / etc.).

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page TLS key_share group selection

- **[T]** Per ClientHello: which groups have key_share entries vs which are only listed in supported_groups.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page TLS PSK / Session resumption attempt

- **[T]** Per ClientHello: PSK extension presence + per-PSK identity (sha256).

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page TLS ALPN list

- **[T]** Per ClientHello: ordered ALPN protocol list (h2, http/1.1, ...).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page TLS Padding extension presence

- **[T]** Per ClientHello: padding extension presence + total padded length.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page TLS Encrypted ClientHello (ECH)

- **[T]** Per ClientHello: ECH extension presence + outer SNI vs hidden SNI.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page TLS post-handshake CertificateRequest

- **[T]** Per TLS session: post-handshake client-cert request observed + client-cert sent.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page DNS query type distribution

- **[T]** Per session: DNS query-type distribution from port-53 pcap (A / AAAA / HTTPS / CNAME / TXT / MX / etc.).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page DNS query latency distribution

- **[T]** Per DNS query: query-to-response RTT distribution.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page DNS server actually used

- **[T]** Per session: DNS server IP each query went to (resolved from pcap source/dest).

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page mDNS query observations

- **[T]** Per session: mDNS (port 5353) queries sent or received — count + type distribution.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page DoH provider request distribution

- **[T]** Per session: requests to known DoH endpoints (cloudflare-dns.com, dns.google, mozilla.cloudflare-dns.com, dns.nextdns.io, dns.quad9.net, doh.cleanbrowsing.org, dns.adguard.com).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page DoT (DNS-over-TLS) port-853 attempts

- **[T]** Per session: TCP-853 connection attempts observed in pcap (DoT in use).

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page NTP / SNTP query observations

- **[T]** Per session: UDP port-123 traffic to known NTP servers (clock sync activity).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page IGMP / MLD multicast subscription

- **[T]** Per session: IGMP / MLD membership reports observed in pcap (multicast group membership).

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page LLMNR query observations

- **[T]** Per session: LLMNR (port 5355) queries — count + name distribution.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page ARP / NDP cache observations

- **[T]** Per session: ARP requests sent + IPv6 Neighbor Discovery solicitations + advertisements.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page TCP SYN retransmission distribution

- **[T]** Per outbound TCP connection: SYN retransmit count + final RTT.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page TCP MSS negotiation

- **[T]** Per TCP connection: SYN MSS option offered + acknowledged.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page TCP window scaling

- **[T]** Per TCP connection: window-scaling option offered + agreed.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page TCP timestamp option

- **[T]** Per TCP connection: timestamp option offered + agreed; TSval initial value + drift.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page TCP SACK option

- **[T]** Per TCP connection: SACK-permitted offered + agreed; SACK blocks observed per session.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page TCP RST observation distribution

- **[T]** Per TCP connection: RST flags seen + connection-close reason inferred.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-Chromium-child: process priority transitions

- **[T]** Per Chromium child: foreground / background priority transitions per session (task_policy_get / setpriority).
- **[T]** Per renderer: when did Chromium classify it as foreground vs background (impacts JS-clamp).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-Chromium-child: macOS App Nap status

- **[T]** Per Chromium child: App Nap applied yes/no over session (`taskinfo -L`).

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-Chromium-child: macOS sandbox container

- **[T]** Per child: `sandbox-exec` profile applied; if any, exact policy file applied.
- **[T]** Per child: codesign team-identifier + bundle-identifier inherited.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-Chromium-child: macOS task port survivability

- **[T]** Per child: task-port survive across exec via `posix_spawn` flags.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-Chromium-child: zone allocator usage

- **[T]** From `vmmap`: per-child PartitionAlloc zone size distribution + V8 isolate allocation size.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-Chromium-child: shared-memory segment count

- **[T]** Per child: SharedMemoryHandle count + per-segment size + cross-process sharing graph.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-Chromium-child: mach IPC port count

- **[T]** Per child: Mach port-set ports + send-rights + receive-rights count from `task_threads` + `task_ports`.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-Chromium-child: file descriptor inheritance

- **[T]** Per child: which fds inherited from parent (via `lsof -p <pid>` parent-vs-child diff).

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-Chromium-child: anonymous mmap regions

- **[T]** From `vmmap`: per-child anonymous mmap region count + total bytes (heap fragmentation signal).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-Chromium-child: dyld shared cache use

- **[T]** Per child: dyld shared cache file path + version (macOS-version-specific).

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Network Information API change events

- **[T]** Every `navigator.connection.change` event: previous values vs new values for type / effectiveType / downlink / rtt / saveData.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page CSS `prefers-reduced-motion` resolution at session start

- **[T]** Per page: `matchMedia('(prefers-reduced-motion: reduce)').matches` value.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page CSS `prefers-reduced-data` resolution at session start

- **[T]** Per page: `matchMedia('(prefers-reduced-data: reduce)').matches` value.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page CSS `prefers-reduced-transparency` resolution at session start

- **[T]** Per page: `matchMedia('(prefers-reduced-transparency: reduce)').matches` value.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page CSS `prefers-contrast` resolution at session start

- **[T]** Per page: `matchMedia('(prefers-contrast: more)' | '(prefers-contrast: less)' | '(prefers-contrast: custom)' | '(prefers-contrast: no-preference)').matches` matrix.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page CSS `forced-colors: active` resolution at session start

- **[T]** Per page: `matchMedia('(forced-colors: active)').matches` value (Windows High Contrast Mode signal).

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page CSS `inverted-colors: inverted` resolution at session start

- **[T]** Per page: `matchMedia('(inverted-colors: inverted)').matches` value (macOS Invert Colors signal).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page CSS `color-gamut` resolution at session start

- **[T]** Per page: matchMedia for color-gamut srgb / p3 / rec2020 individually.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page CSS `dynamic-range` resolution at session start

- **[T]** Per page: matchMedia for dynamic-range standard / high.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page CSS `display-mode` resolution at session start

- **[T]** Per page: matchMedia for display-mode browser / standalone / minimal-ui / fullscreen / window-controls-overlay.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page CSS `update` resolution at session start

- **[T]** Per page: matchMedia for update none / slow / fast.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page CSS `scripting` resolution at session start

- **[T]** Per page: matchMedia for scripting none / initial-only / enabled.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page CSS `pointer` and `any-pointer` resolution

- **[T]** Per page: matchMedia for pointer fine / coarse / none, any-pointer fine / coarse / none.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page CSS `hover` and `any-hover` resolution

- **[T]** Per page: matchMedia for hover hover / none, any-hover hover / none.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page CSS `orientation` resolution

- **[T]** Per page: matchMedia for orientation portrait / landscape.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page CSS `resolution` resolution

- **[T]** Per page: matchMedia at increasing dppx thresholds — surfaces exact rendered-DPR.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-Chromium child page-fault distribution

- **[T]** Per Chromium child: major + minor page-fault count via `task_info(TASK_EVENTS_INFO)`.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-Chromium child file-system byte counters

- **[T]** Per Chromium child: I/O bytes read + written from `task_info(TASK_VM_INFO)` + `task_info(TASK_BASIC_INFO)`.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-Chromium child socket byte counters

- **[T]** Per Chromium child: TCP/UDP bytes sent + received from `nettop -P -l 1`.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-renderer V8 native-method invocation distribution

- **[T]** From Tracing `disabled-by-default-v8.runtime_stats`: top-N native methods invoked + per-method cumulative time.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. macOS Battery Health detail

- **[T]** Per session: battery cycle count, condition (Normal / Service Recommended), max capacity %, design capacity, manufacturer — from `system_profiler SPPowerDataType`.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. macOS UserNotification Center filter list

- **[T]** Per session: NotificationCenter bundle-IDs allowed + blocked count (from notification-center prefs).

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page WebSocket close-reason byte distribution

- **[T]** Per WebSocket close event: reason string byte length + UTF-8 validity.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page WebSocket subprotocol RPC framing

- **[T]** Per WebSocket: observed framing on top of raw frames (JSON-RPC / MessagePack / Protobuf / custom binary).
- **[T]** Per session: subprotocol stack-trace from payload bytes.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page WebTransport datagram packet ID sequence

- **[T]** Per WebTransport session: datagram sequence numbers + lost / re-ordered packet detection.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Web Push notification subscription expirationTime

- **[T]** Per push subscription: expirationTime value distribution.
- **[T]** Per session: expired-subscription auto-renewal events.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Service Worker importScripts dependency list

- **[T]** Per SW: per `importScripts(url)` call: URL + cached vs network-fetched + content sha256.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Service Worker respondWith Stream chunking

- **[T]** Per SW fetch event with streamed Response: chunk count + per-chunk byte size distribution.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Cache Storage byte total

- **[T]** Per origin: sum of bytes across all open Cache entries.
- **[T]** Per origin: per-cache average entry size.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-origin IndexedDB byte total

- **[T]** Per origin: sum of bytes across all IDB databases.
- **[T]** Per origin: per-database average entry size.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page IPv4 vs IPv6 connection preference

- **[T]** Per session: outbound connections established over IPv4 vs IPv6 count + per-host preference observed.
- **[T]** Per host: Happy Eyeballs winning family (IPv4 vs IPv6 race outcome).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Service Worker fetch event delay distribution

- **[T]** Per SW fetch interception: time from request initiation to FetchEvent.respondWith resolution.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page DNS prefetch hit-rate

- **[T]** Per `<link rel=dns-prefetch>`: was the prefetched name later resolved through the cache?

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Service Worker scope eviction events

- **[T]** Per SW: was the registration evicted under storage pressure?

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page browser_action / page_action extension count

- **[T]** Per browser session: extension popup invocation count visible from page side.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page navigation API committed cause

- **[T]** Per navigation: `navigation.committedEntry.committedReason` (recent API) — explicit cause attribution.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Page-Lifecycle V2 freeze-trigger attribution

- **[T]** Per freeze event: trigger (background discard vs explicit `document.freeze()` vs CPU-pressure).

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page console-method monkey-patch signature

- **[T]** Per page: `console.log.toString().length` — divergence from canonical native value indicates monkey-patching.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Native getter integrity (Window.location)

- **[T]** Per page: `Object.getOwnPropertyDescriptor(window, 'location').get?.toString()` divergence from native value.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Native getter integrity (Element)

- **[T]** Per page: per Element-prototype getter (innerHTML/outerHTML/clientWidth/textContent/...) toString() divergence test.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Native getter integrity (HTMLCanvasElement)

- **[T]** Per page: HTMLCanvasElement.prototype.toDataURL.toString() value sha256 — divergence indicates trap install.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Native getter integrity (RTCPeerConnection)

- **[T]** Per page: RTCPeerConnection.prototype.createOffer / setLocalDescription / addIceCandidate / getStats toString() values sha256 cross-check.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page private DNS resolver detection

- **[T]** Per session: presence of `/etc/resolver/*` per-domain DNS overrides (network configuration profile).
- **[T]** Per session: configured DNS-over-HTTPS provider URL.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page WPAD (Web Proxy Auto-Discovery) probe presence

- **[T]** Per session: WPAD lookup attempts observed in pcap.
- **[T]** Per session: configured PAC URL via `scutil --proxy`.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page mDNS responder activity

- **[T]** Per session: mDNS announce + query packet count via port-5353 pcap.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page IPv6 RA observation

- **[T]** Per session: IPv6 Router Advertisement packets received.
- **[T]** Per session: SLAAC-derived address presence.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Kerberos / SPNEGO auth challenges

- **[T]** Per response: `WWW-Authenticate: Negotiate` / `WWW-Authenticate: NTLM` headers.
- **[T]** Per challenge: client response capability (Mac Kerberos via Kerberos.framework).

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page UA-CH client hint cache freshness

- **[T]** Per origin: `Critical-CH` previously delivered → cached UA-CH high-entropy values valid for subsequent navigations.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Local Font Access API state

- **[T]** Per `navigator.fonts.query()` call: permission state + per-font metadata returned (family/style/postscriptName/fullName).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page Hand-tracking WebXR capability

- **[T]** Per page: `navigator.xr.isSessionSupported('immersive-vr', {requiredFeatures: ['hand-tracking']})` outcome.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Eye-tracking WebXR capability

- **[T]** Per page: gaze-tracking feature probe outcome.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page WindowManagement API state

- **[T]** Per `window.getScreenDetails()` call: per-screen lifetime tracking + per-screen events log.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page CapturedSurfaceControl API state

- **[T]** Per `getDisplayMedia({surfaceSwitching: 'include'})` call: capability + surface switching events.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page CapturedSelection / selection-handle events

- **[T]** Per native selection-handle gesture (if mobile UA): start/move/end events.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Browser MachineLearning API capability

- **[T]** Per `navigator.ml.createContext()` (WebNN, recent): device-type selection + outcome.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page WebNN computeGraph distribution

- **[T]** Per WebNN context: operator distribution in compiled graph (conv2d / matmul / softmax / relu / etc.).

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Browser-internal Site Engagement Index score

- **[T]** Per origin: SEI score via `chrome://site-engagement/` (high-engagement sites get autoplay permission).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Browser autoplay policy decision

- **[T]** Per page: autoplay-policy resolved (default / user-gesture-required / document-user-activation-required / no-user-gesture-required).

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Browser Media Engagement Index trigger

- **[T]** Per page: MEI threshold met (allows autoplay-with-sound) vs not.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Browser-blocked autoplay event log

- **[T]** Per page: `play()` Promise rejected events count due to autoplay restrictions.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page User Activation v2 transient state

- **[T]** Per page: `navigator.userActivation.isActive` polled at every script-task boundary.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page User Activation v2 sticky state

- **[T]** Per page: `navigator.userActivation.hasBeenActive` value evolution.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Page lifecycle state aware events

- **[T]** Per page: `document.wasDiscarded` value at session start (true → restored from discard).
- **[T]** Per page: `document.visibilityState` initial value (visible / hidden / prerender).

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Page lifecycle event handlers list

- **[T]** Per page: registered handlers for `freeze`, `resume`, `visibilitychange`, `pagehide`, `pageshow`, `beforeunload`, `unload` per scope (window / document / element).

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Performance Memory API result

- **[T]** Per page: `performance.measureUserAgentSpecificMemory()` (cross-origin-isolated only) per-realm breakdown.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Cross-Origin Isolation actual state

- **[T]** Per page: `crossOriginIsolated` value resolved + which header chain produced it (COEP+COOP+Origin-Agent-Cluster).

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Browser Field-Trial cohorts active

- **[T]** Per session: `chrome://field-trial-internals/` cohort assignments (impacts feature flag values per request).

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Browser-side Variations Service request

- **[T]** Per session: `clients4.google.com/chrome-variations/seed` request fired or not + last-modified header on the seed.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Browser-side prefetched origin pool

- **[T]** Per session: pre-warmed connection pool to known auto-suggested origins (Chrome speculatively connects to top sites).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Chromium safe-browsing lookup activity

- **[T]** Per session: Safe Browsing API request count (URL classification queries) to `safebrowsing.googleapis.com`.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Chrome Sign-in / Sync state

- **[T]** Chromium signed-in profile state — from Local State `account_info` (presence + sha256 of email).
- **[T]** Sync enabled / disabled state per data type.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page Chrome Profile avatar / theme

- **[T]** Profile avatar URL + chosen theme color from Local State.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Chrome reading-list count

- **[T]** Reading list size from Local State (count only).

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Chrome bookmarks count

- **[T]** Bookmarks tree depth + total bookmark count (Local State / Bookmarks DB row count).

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Chrome browsing-history size

- **[T]** Visit history DB row count (no URLs surfaced).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page Chrome saved-tabs (tab groups) count

- **[T]** Per profile: open tab count + tab-group count + per-group color.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Chrome notifications site allowlist size

- **[T]** Per profile: per-content-setting type permission grant count (notifications / popup-blocker / geolocation / etc.).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Chrome download history count

- **[T]** Per profile: download row count + per-MIME distribution.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Chrome Top Sites cache

- **[T]** Per profile: chrome://predictors top-sites entries + per-entry visit count.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Chrome Visited Links bloom-filter state

- **[T]** Per profile: visited-links count via DB row count.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Chrome shopping-list / price-tracking state

- **[T]** Per profile: price-tracked URL count (Chromium Commerce feature).

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Chrome Translation history

- **[T]** Per profile: source-locale → target-locale mapping count.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Chrome Spellcheck enabled languages

- **[T]** Per profile: spellcheck.dictionaries list values.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Chrome Site Engagement Score map

- **[T]** Per profile: per-origin engagement score from chrome://site-engagement.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Chrome RecentlyVisitedSites suggestions

- **[T]** Per profile: omnibox suggestion DB row count.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Chrome Tab Groups saved sessions

- **[T]** Per profile: saved-tab-group count + per-group title sha256.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Chrome Search engines list

- **[T]** Per profile: chrome://settings/search/engines configured list — name + URL + keyword + alternate URLs.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page Chrome default search engine

- **[T]** Default search engine name + URL pattern.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Chrome Site permissions per content type

- **[T]** Per profile: per-content-setting type, count of allow / block / ask entries.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Chrome Per-site Zoom level map

- **[T]** Per profile: per-origin zoom-level override map.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Chrome Per-site cookie controls

- **[T]** Per profile: per-origin cookie-control mode (allow / block / block-third-party).

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Chrome Per-site sound-control

- **[T]** Per profile: per-origin sound (auto-play with sound allow vs block).

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Chrome Per-site protected-content identifier permission

- **[T]** Per profile: per-origin protected-content (Widevine identifier access) decision.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Chrome Per-origin partitioned storage allocation

- **[T]** Per profile: per (top-level-origin, third-party-origin) partition storage allocation.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Chrome blocked content count per content type

- **[T]** Per profile: per-origin blocked content count (popups, downloads, redirects).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Chrome "Always Open This Type of Link in Associated App" preferences

- **[T]** Per profile: protocol handlers registered via web-app via navigator.registerProtocolHandler.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Chrome Reduced-Motion-respecting policy

- **[T]** Per page: respects prefers-reduced-motion preference vs ignores (animations played anyway).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page Chrome Energy-Save Mode state

- **[T]** Per session: Chrome's energy-saver mode enabled via Local State `performance.battery_saver_mode_state`.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Chrome Memory-Save Mode state

- **[T]** Per session: Chrome's memory-saver mode enabled state.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Chrome Tab Freezing observations

- **[T]** Per tab: freeze events from chrome://discards/ table.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Chrome Tab Discarding observations

- **[T]** Per tab: discard events + reason (memory pressure vs idle).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page Chrome HighEfficiencyMode policy

- **[T]** Per session: high-efficiency mode active vs not.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Chrome PriceTracking opt-in state per URL

- **[T]** Per session: shopping URLs with price-tracking subscriptions.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Chrome Identity-API ML-based suggestions

- **[T]** Per page: ML-driven Identity API suggestion deliveries (FedCM mediation).

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Chrome Suspicious Notifications detection

- **[T]** Per page: notifications marked suspicious by Chrome heuristic (ML model).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Chrome Lookalike domain detection

- **[T]** Per navigation: lookalike-URL warning triggered vs not.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Chrome Interstitial warning frequency

- **[T]** Per session: per-interstitial type count (safe-browsing-malware / safe-browsing-phishing / safe-browsing-unwanted / safe-browsing-billing / ssl-error / captive-portal / blocked-mixed-content / supervised-user / etc.).

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Chrome Tracking Protection cookie blocks

- **[T]** Per page: third-party cookies blocked count due to Tracking Protection vs declined.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Chrome IP Protection state

- **[T]** Per session: Chrome IP Protection (proxy-based privacy feature) active vs not + tunneled origin list.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Chrome Origin Trial-controlled API exposure delta

- **[T]** Per page: presence of OT-controlled APIs that are absent without a valid token (FedCM, Compute Pressure, Web NFC, etc.).

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Chrome Field-Trial-controlled feature delta

- **[T]** Per session: feature-flag values resolved per field trial cohort (e.g., DeprecateUnloadByUserAgent).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Chrome ResourceCoordinator priority decision

- **[T]** Per frame: priority decision (foreground / background) from chrome://process-internals/.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Chrome BackForwardCacheMetrics

- **[T]** Per navigation: BFCache hit / miss + reason histogram.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page Chrome Auction worklet output

- **[T]** Per Protected-Audience auction: winning bid + selected ad URN + winning interest group + losing bids count.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Chrome Shared Storage worklet output

- **[T]** Per Shared Storage operation: output Promise resolution + privacy budget consumed.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Chrome Anonymous frames count

- **[T]** Per page: anonymous-frame attribute usage + frame count.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Chrome Fenced Frames

- **[T]** Per page: `<fencedframe>` element count + per-frame mode (default / opaque-ads).
- **[T]** Per fenced frame: parent-frame-isolation boundary cross attempts.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Chrome Portal element (deprecated experimental)

- **[T]** Per page: `<portal>` element presence (deprecated but legacy still detectable).

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Chrome Permissions-Policy unloadable iframe presence

- **[T]** Per page: iframes with `unload-event` policy denied count.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Chrome Sandbox flags resolved per iframe

- **[T]** Per iframe: full resolved sandbox flag set (allow-scripts / allow-forms / allow-same-origin / allow-popups / etc.) — 18 documented tokens.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Browser caches: chrome://settings/cookies count per origin

- **[T]** Per origin: stored cookie row count + total cookie name+value byte sum.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Browser caches: chrome://settings/storage usage per origin

- **[T]** Per origin: storage quota usage detail per type (caches / serviceWorkerRegistrations / localStorage / sessionStorage / indexedDB / fileSystems).

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page macOS Keychain item count

- **[T]** Per session: keychain item count via `security dump-keychain -d login.keychain-db | wc -l` (count only).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page macOS APFS volume snapshot count

- **[T]** Per volume: `tmutil listlocalsnapshots /` snapshot count + retention age.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page macOS Privacy Indicators state

- **[T]** Per session: orange (microphone) + green (camera) privacy indicator state via `mediaaccessd` log events.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page macOS Screen recording prompt history

- **[T]** Per session: ScreenCaptureKit / CGRequestScreenCaptureAccess calls visible via `log show --predicate 'subsystem == "com.apple.screensharing"'`.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page macOS Microphone access events

- **[T]** Per session: microphone-access events visible via `log show --predicate 'subsystem == "com.apple.mediaremoted"'`.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page macOS App Intents / Shortcuts registrations

- **[T]** Per session: Shortcuts app registration count + intent action count.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page macOS Spotlight indexed paths state

- **[T]** Per session: indexed-volumes count + per-volume indexing-state (enabled / disabled).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page macOS NTSP service Hidden Mac UUIDs

- **[T]** Per session: NSCFNetworkID values for service identification.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page macOS BiometricKitd state

- **[T]** Per session: Touch ID / Face ID enrollment count via `bioutil -r -s`.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page macOS UNUserNotificationCenter delivered notifications

- **[T]** Per session: delivered notification count from Notification Center DB.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page macOS Universal Control state

- **[T]** Per session: Universal Control enabled state — `defaults read com.apple.universalcontrol`.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page macOS Sidecar state

- **[T]** Per session: Sidecar configured state + paired-iPad presence.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page macOS Migration Assistant transfer history

- **[T]** Per session: migration history presence (sha256 of legacy machine name from Local Items).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page macOS Activation lock state

- **[T]** Per session: Activation Lock enabled state for Apple Silicon.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page macOS Lockdown Mode state

- **[T]** Per session: Lockdown Mode enabled — `defaults read com.apple.security.lockdown` presence.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page macOS Reduce Motion enabled flag

- **[T]** Per session: `defaults read com.apple.universalaccess reduceMotion`.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page macOS Increase Contrast enabled flag

- **[T]** Per session: `defaults read com.apple.universalaccess increaseContrast`.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page macOS Reduce Transparency enabled flag

- **[T]** Per session: `defaults read com.apple.universalaccess reduceTransparency`.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page macOS Differentiate Without Color enabled flag

- **[T]** Per session: `defaults read com.apple.universalaccess differentiateWithoutColor`.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page macOS VoiceOver enabled flag

- **[T]** Per session: VoiceOver-enabled via `defaults read com.apple.universalaccess voiceOverOnOffKey`.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page macOS Spoken Content enabled

- **[T]** Per session: spoken content enabled via `defaults read com.apple.speech.synthesis.general.prefs`.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page macOS Switch Control enabled

- **[T]** Per session: Switch Control enabled state.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page macOS Voice Control enabled

- **[T]** Per session: Voice Control enabled state.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page macOS HoverText enabled

- **[T]** Per session: HoverText accessibility feature state.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Page-side prefers-color-scheme listener registration

- **[T]** Per page: count of `matchMedia('(prefers-color-scheme: dark)').addListener` registrations.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Per-input element form-validation message detail

- **[T]** Per validatable input: `validationMessage` value at session end.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Per-input element invalidity state

- **[T]** Per validatable input: `validity.valid` final flag + which constraint failed.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page Each-stylesheet `media` attribute value

- **[T]** Per `<link rel=stylesheet media>`: media attribute value + matched at session start.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Per-fetch crossOrigin response type

- **[T]** Per fetched response: Response.type value (basic / cors / opaque / opaqueredirect / error).

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Per-fetch Response.url vs Request.url

- **[T]** Per fetched response: redirected flag + final url vs initial url.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Per-fetch Response.statusText distribution

- **[T]** Per response: statusText value distribution (e.g. "OK" vs "Ok" vs unique server reason phrases).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page Per-fetch HTTP/2 trailer headers

- **[T]** Per response: any trailer headers received (rare but observable on HTTP/2 streams).

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Per-response decoded body sample preview

- **[T]** Per response: first-N-byte sample sha256 (after decoding compression).

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Per-response content sniffer outcome

- **[T]** Per response: declared Content-Type vs Chromium's sniffed type — used for X-Content-Type-Options enforcement.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Per-response Accept-CH Lifetime

- **[T]** Per response: Accept-CH-Lifetime (legacy delegate) value + Critical-CH + Accept-CH directives.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Per-response 103 Early Hints

- **[T]** Per response: 103 Early Hints presence + Link hints delivered before final response.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Per-response 421 Misdirected Request occurrences

- **[T]** Per session: 421 response count (server-rejection signaling HTTP/2 connection coalescing failure).

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Per-response Server-Sent Events stream

- **[T]** Per SSE connection: event count + per-event id + per-event data byte length.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Per-fetch redirect manual handling outcome

- **[T]** Per `fetch(url, {redirect: 'manual'})` call: outcome — opaqueredirect Response value.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Per-fetch redirect-followed cross-origin chain

- **[T]** Per redirect chain: cross-origin transitions per hop — cookies lost / referer changed.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Per-fetch cache mode `only-if-cached` failures

- **[T]** Per `fetch({cache: 'only-if-cached'})` outcome.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Page-side HTTP cache stale-while-revalidate hits

- **[T]** Per response: stale-while-revalidate served vs revalidated freshly.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Page-side HTTP cache stale-if-error hits

- **[T]** Per response: stale-if-error served (server error followed by stale return).

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page Page-side HTTP cache immutable hint usage

- **[T]** Per response: `Cache-Control: immutable` directive presence + revalidation skipped count.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Page-side HTTP cache no-store enforcement

- **[T]** Per response: no-store directive presence + caching behavior verified.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Page-side HTTP cache private vs public hint

- **[T]** Per response: private vs public directive presence + intermediate-cache behavior.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Page-side HTTP cache must-revalidate enforcement

- **[T]** Per response: must-revalidate vs proxy-revalidate directive distribution.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Page-side HTTP cache age field

- **[T]** Per response: `Age:` header value distribution.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Page-side HTTP cache Cache-Status header

- **[T]** Per response: RFC 9211 `Cache-Status:` header presence + status (hit / fwd=miss / fwd=stale / etc.).

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Page-side `Save-Data` directive observed in request

- **[T]** Per outgoing request: Save-Data header sent (yes/no) + server response per-Save-Data variant.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page document.head child-element ordered sequence

- **[T]** Per page: literal ordered tagName sequence of `document.head.children` at parse-end (e.g. `meta,meta,title,link,link,script,...`). Sequence is framework-specific.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page HTML5 attribute case preservation

- **[T]** Per page: `element.getAttributeNames()` casing distribution — surfaces server-side rendering vs client-side framework rendering.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page XPath result-type distribution

- **[T]** Per `document.evaluate(xpath, ...)` call: `resultType` requested + per-type usage count (NUMBER_TYPE / STRING_TYPE / BOOLEAN_TYPE / UNORDERED_NODE_ITERATOR_TYPE / etc.).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page WebAssembly streaming vs eager compilation

- **[T]** Per `WebAssembly.compileStreaming` vs `WebAssembly.compile` call ratio.
- **[T]** Per `instantiateStreaming` vs `instantiate` ratio.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page ES decorator usage detection

- **[T]** Per page: presence of decorator-transpiled output (Babel/TypeScript decorator runtime calls) — fingerprint of TC39 decorator adoption.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Reflect.metadata polyfill detection

- **[T]** Per page: `Reflect.metadata` / `Reflect.defineMetadata` / `Reflect.getMetadata` symbol presence — TypeScript experimentalDecorators output marker.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page `eval`-toString self-modification detection

- **[T]** Per page: `eval.toString()` value sha256 + re-evaluated probe (some libraries monkey-patch eval).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page CodeStreamReader / VideoStreamTrack source attribution

- **[T]** Per VideoStreamTrack: source (`getUserMedia` / `getDisplayMedia` / `captureStream` from canvas/video / `MediaStreamTrackGenerator`).

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Web Audio K-rate vs A-rate AudioParam distribution

- **[T]** Per AudioParam: automationRate value (`a-rate` / `k-rate`) distribution per node type.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page WebGL2 sync-object polling latency

- **[T]** Per WebGL2 `fenceSync` + `clientWaitSync` pair: sync resolution latency (GPU command-queue depth probe).

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page navigator.scheduling.isInputPending probe outcomes

- **[T]** Per call to `navigator.scheduling.isInputPending(options)`: outcome (true / false) + options pattern (includeContinuous).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-Service-Worker Background Sync API event firing

- **[T]** Per registered SW: `sync` event fire count per tag.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-Service-Worker Periodic Background Sync registered tags

- **[T]** Per registered SW: `periodicSync` registration list (tag + minInterval) + periodicsync event fire count.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Element.toggleAttribute boolean-attribute toggling pattern

- **[T]** Per call: attribute name + force flag + outcome.
- **[T]** Per page: toggleAttribute usage signature (which boolean attributes get toggled).

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Element.scrollIntoView smoothness selection

- **[T]** Per call: `behavior: 'smooth' | 'auto' | 'instant'` distribution.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page IntersectionObserver rootMargin negative-value usage

- **[T]** Per IO registered: rootMargin with negative values (intentional "look-ahead" pattern).

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page MutationObserver attributeFilter usage

- **[T]** Per MO registered: attributeFilter array — per-attribute-name filter signature.

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-element CSS computed font-family resolved name

- **[T]** Per visible element: `getComputedStyle(el).fontFamily` resolved value (which font in the fallback chain actually rendered).

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-element CSS computed font-size px value

- **[T]** Per visible text element: resolved fontSize in px.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-element CSS computed line-height resolved px

- **[T]** Per visible text element: resolved lineHeight (normal → px conversion is font-metric-dependent → fingerprint vector).

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Resource Timing entry initiator script + sourceURL attribution

- **[T]** Per resource: `initiatorType` value distribution + per-initiator source URL chain.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Worker.postMessage per-target byte volume

- **[T]** Per Worker / SharedWorker / ServiceWorker: total postMessage byte volume + message count over session.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Element.replaceWith / before / after / prepend / append usage

- **[T]** Per page: modern DOM-manipulation method call distribution (replaceWith / before / after / prepend / append / remove / replaceChildren).

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page legacy innerHTML reassignment volume

- **[T]** Per page: `innerHTML` setter call count + per-call byte size of assigned string.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page createElement vs createElementNS distribution

- **[T]** Per page: createElement (HTML namespace) vs createElementNS calls (SVG/MathML namespace) ratio.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page cloneNode deep vs shallow ratio

- **[T]** Per page: cloneNode(true) vs cloneNode(false) call distribution.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Browser-internal `chrome://histograms/Net.QuicSession.*` time-series

- **[T]** Per session: QUIC session metric histograms count change since session start.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Browser-internal `chrome://histograms/Net.HttpJob.*` time-series

- **[T]** Per session: HttpJob latency histogram bucket distribution.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Browser-internal `chrome://histograms/PageLoad.*` UMA metrics

- **[T]** Per session: PageLoad LCP / CLS / FCP histogram bucket distribution.

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page Browser-internal `chrome://histograms/V8.GC.*` time-series

- **[T]** Per session: V8 GC pause histogram bucket distribution per GC type.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Browser-internal `chrome://histograms/Blink.*` time-series

- **[T]** Per session: Blink-namespace histogram bucket changes.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Browser-internal `chrome://histograms/Memory.*` time-series

- **[T]** Per session: Memory.Renderer / Memory.Browser histogram distribution.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Browser-internal `chrome://histograms/Compositing.*` time-series

- **[T]** Per session: compositing-thread histogram distribution.

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page Browser-internal `chrome://histograms/Net.SocketIO.*` time-series

- **[T]** Per session: socket I/O histogram per-pool change.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Browser-internal `chrome://histograms/Cookie.*` time-series

- **[T]** Per session: cookie store histogram changes.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Browser-internal `chrome://histograms/Storage.*` time-series

- **[T]** Per session: Storage.* histogram changes per quota category.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Browser-internal `chrome://histograms/WebRTC.*` time-series

- **[T]** Per session: WebRTC histogram-bucket changes per RTC sub-component.

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Browser-internal `chrome://histograms/CrossOriginIsolation.*` time-series

- **[T]** Per session: COI-related histogram distribution.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Browser-internal `chrome://histograms/Renderer4.*` time-series

- **[T]** Per session: Renderer4 paint-and-layout histogram distribution.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Browser-internal `chrome://histograms/Permissions.*` time-series

- **[T]** Per session: Permission prompt outcomes histogram.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Browser-internal `chrome://histograms/Autofill.*` time-series

- **[T]** Per session: Autofill suggestion offering count + acceptance rate.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Browser-internal `chrome://histograms/SafeBrowsing.*` time-series

- **[T]** Per session: Safe-Browsing classifier invocation histogram.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Browser-internal `chrome://histograms/PasswordManager.*` time-series

- **[T]** Per session: PasswordManager outcome histogram (suggestion offered / accepted / rejected).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Browser-internal `chrome://histograms/Identity.*` time-series

- **[T]** Per session: Identity / FedCM outcomes histogram.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Browser-internal `chrome://histograms/Reload.*` time-series

- **[T]** Per session: page-reload outcome histogram.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page Browser-internal `chrome://histograms/BackForwardCache.*` time-series

- **[T]** Per session: BFCache eligibility outcome distribution.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Browser-internal `chrome://histograms/Variations.*` time-series

- **[T]** Per session: Variations seed-fetch + activation outcome histogram.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Browser-internal `chrome://histograms/Sync.*` time-series

- **[T]** Per session: Sync session outcome histogram (signed-in profile only).

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Browser-internal `chrome://histograms/OptimizationGuide.*` time-series

- **[T]** Per session: Optimization Guide hint fetch + apply outcome histogram.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Browser-internal `chrome://histograms/Sessions.*` time-series

- **[T]** Per session: Sessions restore + activation histogram.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Browser-internal `chrome://histograms/OmniboxProvider.*` time-series

- **[T]** Per session: Omnibox provider suggestion counts (Search vs URL vs Bookmark vs History vs Shortcut).

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Browser-internal `chrome://histograms/Power.*` time-series

- **[T]** Per session: Power.* histogram distribution (energy-cost per renderer).

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Browser-internal `chrome://histograms/Navigation.*` time-series

- **[T]** Per session: Navigation.* histogram changes (per navigation-type distribution).

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Browser-internal `chrome://histograms/PageLoad.PaintTiming.*` time-series

- **[T]** Per session: FP / FCP / LCP histogram bucket distribution.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Browser-internal `chrome://histograms/Net.Cookie.*` time-series

- **[T]** Per session: Net.Cookie.* histogram distribution (cookie-store reads/writes/deletes).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page Browser-internal `chrome://histograms/PrivacySandbox.*` time-series

- **[T]** Per session: PrivacySandbox histogram changes (Topics / Protected Audience / Shared Storage outcomes).

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Browser-internal `chrome://histograms/SiteEngagement.*` time-series

- **[T]** Per session: SiteEngagement histogram bucket changes.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Browser-internal `chrome://histograms/IPC.*` time-series

- **[T]** Per session: IPC frequency + latency histogram distribution per channel.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Browser-internal `chrome://histograms/Scheduling.*` time-series

- **[T]** Per session: Scheduling histogram distribution (task-queue depth / priorities).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page Browser-internal `chrome://histograms/TaskScheduler.*` time-series

- **[T]** Per session: TaskScheduler histogram distribution (worker-pool utilization).

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Browser-internal `chrome://histograms/MediaCapabilities.*` time-series

- **[T]** Per session: MediaCapabilities histogram distribution.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Browser-internal `chrome://histograms/Decoder.*` time-series

- **[T]** Per session: Decoder.* histogram distribution per media codec.

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Browser-internal `chrome://histograms/Cast.*` time-series

- **[T]** Per session: Cast.* histogram (Chromecast device discovery events).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Browser-internal `chrome://histograms/PresentationApi.*` time-series

- **[T]** Per session: Presentation API histogram distribution.

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Browser-internal `chrome://histograms/RemotePlay.*` time-series

- **[T]** Per session: RemotePlay histogram distribution.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Browser-internal `chrome://histograms/EME.*` time-series

- **[T]** Per session: Encrypted Media Extensions histogram distribution.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Browser-internal `chrome://histograms/Audio.*` time-series

- **[T]** Per session: Audio.* histogram distribution (output device latency / device selection).

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Browser-internal `chrome://histograms/Speech.*` time-series

- **[T]** Per session: Speech (recognition + synthesis) histogram distribution.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Browser-internal `chrome://histograms/InstantSearch.*` time-series

- **[T]** Per session: Instant Search histogram distribution (omnibox prerender behavior).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Browser-internal `chrome://histograms/SearchProvider.*` time-series

- **[T]** Per session: SearchProvider histogram changes.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Browser-internal `chrome://histograms/UMA.PersistentLogs.*` time-series

- **[T]** Per session: UMA log queue depth + upload outcome histogram.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page Browser-internal `chrome://histograms/UKM.*` time-series

- **[T]** Per session: UKM (URL-Keyed Metrics) histogram changes.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Browser-internal `chrome://histograms/DNS.*` time-series

- **[T]** Per session: DNS.* histogram changes (host resolver per-attempt outcomes).

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Browser-internal `chrome://histograms/PageImage.*` time-series

- **[T]** Per session: image decoder histogram per source-format.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Browser-internal `chrome://histograms/Reading_List.*` time-series

- **[T]** Per session: Reading List addition / removal / read-state histogram.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Browser-internal `chrome://histograms/PWAInstall.*` time-series

- **[T]** Per session: Progressive Web App install prompt + installation outcome histogram.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Browser-internal `chrome://histograms/Bookmarks.*` time-series

- **[T]** Per session: bookmark addition + removal histogram.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Browser-internal `chrome://histograms/Translate.*` time-series

- **[T]** Per session: Translate prompt + acceptance + completion histogram.

## AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Per-page Browser-internal `chrome://histograms/PageVisits.*` time-series

- **[T]** Per session: page-visit histogram bucket changes.

## BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB. Per-page Browser-internal `chrome://histograms/Print.*` time-series

- **[T]** Per session: print-preview + actual print operation histogram.

## CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC. Per-page Browser-internal `chrome://histograms/Extensions.*` time-series

- **[T]** Per session: Extensions histogram changes (install + uninstall + content-script injection).

## DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD. Per-page Browser-internal `chrome://histograms/DataReduction.*` time-series

- **[T]** Per session: Data-Saver bytes-saved + bytes-unsaved histogram.

## EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE. Per-page Browser-internal `chrome://histograms/PaymentRequest.*` time-series

- **[T]** Per session: PaymentRequest invocation + outcome histogram.

## FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. Per-page Browser-internal `chrome://histograms/Login.*` time-series

- **[T]** Per session: Login (account chooser, password fill) histogram distribution.

## GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG. Per-page Browser-internal `chrome://histograms/Tab.*` time-series

- **[T]** Per session: Tab lifecycle histogram (create / close / discard / restore).

## HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH. Per-page Browser-internal `chrome://histograms/WebUI.*` time-series

- **[T]** Per session: WebUI page load histogram.

## IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII. Per-page Browser-internal `chrome://histograms/WebApk.*` time-series

- **[T]** Per session: WebApk install / launch histogram.

## JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ. Per-page Browser-internal `chrome://histograms/Throttling.*` time-series

- **[T]** Per session: throttling-policy histogram (background-tab JS clamp / hidden-rAF).

## KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK. Per-page Browser-internal `chrome://histograms/AppleSilicon.*` time-series

- **[T]** Per session: Apple-Silicon-specific perf histograms (when on Apple GPU).

## LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL. Per-page Browser-internal `chrome://histograms/Vulkan.*` / `Metal.*` / `D3D.*` time-series

- **[T]** Per session: GPU-backend-specific histograms (which backend Chrome actually used).

## MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM. Per-page Browser-internal `chrome://histograms/Net.QuicNewConnection.*` time-series

- **[T]** Per session: QUIC new-connection latency histogram.

## NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN. Per-page Browser-internal `chrome://histograms/Net.SSL.*` time-series

- **[T]** Per session: SSL handshake outcome histogram + cipher-suite negotiation histogram.

## OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO. Per-page Browser-internal `chrome://histograms/Net.HostResolver.*` time-series

- **[T]** Per session: host-resolver per-attempt histogram.

## PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP. Per-page Browser-internal `chrome://histograms/Net.NetworkErrorLogging.*` time-series

- **[T]** Per session: NEL report delivery histogram.

## QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ. Per-page Browser-internal `chrome://histograms/Net.OCSP.*` time-series

- **[T]** Per session: OCSP query outcome histogram (stapled vs fetched vs missing).

## RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR. Per-page Browser-internal `chrome://histograms/Net.CertVerifier.*` time-series

- **[T]** Per session: cert verifier outcome histogram.

## SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS. Per-page Browser-internal `chrome://histograms/Net.TrustToken.*` time-series

- **[T]** Per session: Trust Token issuance + redemption histogram.

## TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT. Per-page Browser-internal `chrome://histograms/Net.ECH.*` time-series

- **[T]** Per session: Encrypted Client Hello outcome histogram.

## UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU. Per-page Browser-internal `chrome://histograms/Net.0RTT.*` time-series

- **[T]** Per session: 0-RTT sent + accepted histogram.

## VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV. Per-page Browser-internal `chrome://histograms/Net.Alpn.*` time-series

- **[T]** Per session: ALPN protocol negotiated histogram.

## WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW. Per-page Browser-internal `chrome://histograms/Net.Http3.*` time-series

- **[T]** Per session: HTTP/3 use + fallback histogram.

## XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. Per-page Browser-internal `chrome://histograms/Net.CookieControls.*` time-series

- **[T]** Per session: third-party-cookie blocking outcome histogram.

## YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY. Per-page Browser-internal `chrome://histograms/Net.ProxyService.*` time-series

- **[T]** Per session: ProxyService resolution outcome histogram.

## ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ. Per-page Browser-internal `chrome://histograms/Net.WPAD.*` time-series

- **[T]** Per session: WPAD discovery outcome histogram.

## GG. Disk usage of recordings

- **[T]** Per-session recording dir total byte size; per-artifact (pcap, sslkey, netlog, har, screenshots, webm, bodies, scripts, css, dom, cdp_firehose.ndjson) size individually.
- **[T]** Fraction of bytes by artifact type (so we know what's dominating capture cost).
- **[T]** Inst.json self-size and self-line-count vs sibling-file total (so we know how much got inlined vs referenced).

---

## Update protocol

When wiring new capture, flip a `[T]` to `[W]` here in the same commit that lands the code. When you add a new channel name nobody has heard of yet, append it with `[T]` and a brief note. This file is the spec; `buildDumpPayload` is the code that satisfies it; `diff.mjs` is the consumer.
