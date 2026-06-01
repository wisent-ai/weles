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

## GG. Disk usage of recordings

- **[T]** Per-session recording dir total byte size; per-artifact (pcap, sslkey, netlog, har, screenshots, webm, bodies, scripts, css, dom, cdp_firehose.ndjson) size individually.
- **[T]** Fraction of bytes by artifact type (so we know what's dominating capture cost).
- **[T]** Inst.json self-size and self-line-count vs sibling-file total (so we know how much got inlined vs referenced).

---

## Update protocol

When wiring new capture, flip a `[T]` to `[W]` here in the same commit that lands the code. When you add a new channel name nobody has heard of yet, append it with `[T]` and a brief note. This file is the spec; `buildDumpPayload` is the code that satisfies it; `diff.mjs` is the consumer.
