# Fingerprint capture inventory (canonical)

> One file. Every distinct channel captured per WSession run. Source of truth.

Every channel below lands in one merged artifact: `recordings/<label>/<label>.inst.json`, built by `buildDumpPayload` in `src/session/wsession-helpers/net_record.ts`. Large payloads (pcap, SSL keys, NetLog, HAR, screenshots, video, response bodies, scripts, CSS, DOM snapshots, heap snapshots, CDP firehose) are written to sibling files under the same `recordings/<label>/` directory and referenced from `inst.json` by path. `scripts/debug/fp_matrix/diff.mjs <a.inst.json> <b.inst.json>` consumes this shape.

Status legend: **[W]** wired and emitting. **[P]** partial. **[T]** todo.

Deduplication rule: this inventory lists collector surfaces, artifact surfaces, and explicit probe matrices. It does not list every leaf property or method as a separate channel. For example, `navigator.*` enumeration plus a Navigator capability matrix covers `navigator.adAuctionComponents()` unless that API needs a different collector or produces a separate artifact.

Location note: this file stays under `scripts/worker/deploy/` for continuity with existing worker-deploy docs and commits.

## A. JS runtime and web-platform surfaces

- **[W]** `SURFACE_INVENTORY_SCRIPT` snapshots own/prototype keys for `navigator`, `window`, `screen`, `screen.orientation`, `document`, `location`, `history`, `performance`, and related global objects at session start.
- **[W]** `property_trap.js` tees read access for the same runtime surfaces.
- **[W]** `crypto.subtle.*`, `crypto.getRandomValues`, `Intl.*.resolvedOptions()`, `Permissions.query`, `navigator.userAgentData.getHighEntropyValues()`, `navigator.connection`, `navigator.getBattery()`, `navigator.storage`, `navigator.locks`, `navigator.serviceWorker`, `navigator.mediaDevices.enumerateDevices()`, and granted-device list APIs are wrapped or sampled.
- **[W]** `fetch`, `XMLHttpRequest`, `WebSocket`, `WebTransport`, `EventSource`, `BroadcastChannel`, `navigator.sendBeacon`, and `EventTarget.addEventListener` are wrapped.
- **[W]** `IntersectionObserver`, `ResizeObserver`, `MutationObserver`, `ReportingObserver`, `PerformanceObserver`, `trustedTypes.getPolicyNames`, `indexedDB.databases()`, `Storage` hooks, `document.featurePolicy`, `document.fonts`, `Notification.permission/requestPermission`, and `securitypolicyviolation` are captured.
- **[T]** Complete JS-native inventory: source strings for native methods, `Object.prototype.toString` tags, global constructors, prototype key sets, getters/setters/descriptors, deprecated browser globals, `chrome.*`, `external.*`, and browser-specific compatibility shims.
- **[T]** JS engine fingerprint matrix: Error stack formats, exception message formats, numeric precision edge cases, `Math.*` edge cases, `Date.parse` and Date string formatting, RegExp feature probes, BigInt/WeakRef/Temporal/Iterator-helper feature probes, and built-in capability booleans.
- **[T]** Runtime call/timing counters with stacks: `Math.random`, `Date.now`, `performance.now`, timers, microtasks, animation frames, idle callbacks, geometry reads, `getComputedStyle`, selection, hit testing, clipboard, console, global errors, promise rejections, lifecycle events, and storage events.
- **[T]** WebAssembly matrix: SIMD, threads, exceptions, GC, JSPI, tail calls, multi-value, reference types, bulk memory, shared memory, import object values, and wrapped exports.
- **[T]** Intl and locale matrix: supported locales, canonicalization, timezone, numbering systems, collation, segmentation, digit shaping, measurement system, first-day-of-week, and date/number round trips.
- **[T]** Browser capability matrix for named Web APIs: media capabilities, media source, permissions, sensors, WebXR, speech synthesis/recognition, credentials, WebAuthn, payments, background sync/fetch, push, storage buckets, OPFS/File System Access, wake lock, Web NFC, smart card, Direct Sockets, Compute Pressure, Digital Goods, WebOTP, Contact Picker, Web Share, View Transitions, Trust/Private State Tokens, Topics, Attribution Reporting, Protected Audience, URLPattern, Sanitizer, Scheduler, Popover, CSS Houdini worklets, and origin trials.

## B. Rendering, graphics, media, and audio

- **[W]** Canvas `toDataURL` and `getImageData` pixel output is dumped via `fingerprint_hooks.js`.
- **[W]** `AudioBuffer.getChannelData` Float32 output and `OfflineAudioContext.startRendering` output summary are captured.
- **[W]** WebGL `getParameter`, `getSupportedExtensions`, `WEBGL_debug_renderer_info`, and WebGPU `requestAdapter()` info/features/limits are captured.
- **[P]** WebRTC SDP, ICE candidates, and stats are captured via `RTCPeerConnection.createOffer/setLocalDescription/addIceCandidate/getStats`.
- **[T]** Canvas and text matrix: TextMetrics, marker-string font probing, FontFace API details, emoji/color-font/variable-font/OpenType feature support, image smoothing, color space, canvas allocation lifetime, and readback hashes.
- **[T]** WebGL/WebGL2 matrix: all documented params, extensions, precision formats, context attributes, shader/program logs, translated shader sources, active uniforms/attributes, transform feedback, multiple render targets, texture/buffer upload bytes, context loss/restore, error counts, GPU float rounding, and ANGLE backend markers.
- **[T]** WebGPU matrix: adapter/device limits, requested features, shader compile logs, compute shader output hash, pipeline layout, bind groups, buffers, textures, command encoders, passes, queue submissions, device loss, and resource lifetimes.
- **[T]** Image decode matrix: PNG/JPEG/WebP/AVIF/SVG decode, `createImageBitmap` options, `ImageDecoder`, `HTMLImageElement.decode`, `OffscreenCanvas.convertToBlob`, color management, EXIF orientation, premultiply alpha, resize quality, and output byte hashes.
- **[T]** Audio matrix: analyser bins, byte time-domain data, compressor/IIR/filter rendering hashes, oscillator/gain/panner/convolver/worklet nodes, AudioParam values and automation, output/base latency, timestamps, sample rates, channel counts, routing, devices, and speech voices.
- **[T]** Media matrix: `HTMLMediaElement.canPlayType`, `MediaSource.isTypeSupported`, `MediaCapabilities.decodingInfo`, WebCodecs encode/decode capabilities, EME/DRM key systems, media element state streams, autoplay decisions, capture streams, Picture-in-Picture, and audio/video track settings.
- **[T]** CSS/SVG/MathML rendering matrix: computed styles, CSS.supports, Houdini registration, animation/transition events, transform/layout/containment features, filters, masks, blend modes, scroll timelines, SVG element/filter/gradient/path features, MathML element support, and rendered-output hashes where applicable.

## C. CDP firehose and browser-internal state

- **[W]** Subscribes to every documented CDP event from `protocol.d.ts` after the skip list; payloads currently land in `ws._instCdpFirehose`.
- **[W]** `DOMSnapshot.captureSnapshot`, `DOM.getDocument({pierce:true})`, `HeapProfiler.takeHeapSnapshot`, `SystemInfo.getInfo`, `SystemInfo.getProcessInfo`, `Browser.getVersion`, `Browser.getHistograms`, and `Page.getNavigationHistory` are captured.
- **[W]** `Performance.getMetrics`, `Memory.getDOMCounters`, `Tracing.start`, `Profiler.startPreciseCoverage`, `CSS.startRuleUsageTracking`, and broad Page/Runtime/Log/Security/Storage/WebAudio/Animation/IndexedDB event families are enabled.
- **[T]** Stream raw CDP firehose to `recordings/<label>/cdp_firehose.ndjson` without preview truncation.
- **[T]** Expand final pulls: full DOMSnapshot CSS property list, `Accessibility.getFullAXTree`, screenshots, MHTML snapshots, app manifest/installability/icons, frame tree/layout metrics, security isolation, certificate chain, cookies, trust tokens, interest groups, shared storage, related website sets, attribution reports, storage quota, CacheStorage, IndexedDB object stores, and BackgroundFetch.
- **[T]** Persist loaded assets: `Debugger.scriptParsed` plus `Debugger.getScriptSource` for scripts, `CSS.getStyleSheetText` for stylesheets, source maps, module graphs, import maps, speculation rules, SRI attributes, resource priorities, and render-blocking attribution.
- **[T]** Expand diagnostics: `DOMDebugger.getEventListeners`, LayerTree, Audits, CSS media/platform-font/layer/background APIs, Memory sampling profiles, V8 runtime call stats, precise coverage with call counts, Runtime global properties/queryObjects/heap usage/isolate id, Target and browser context state, Inspector detach events, and chrome-internal pages.
- **[T]** Capture build/runtime internals: command line, feature flags, variation seed, synthetic trials, component versions, Skia/ANGLE/Dawn/BoringSSL/libvpx/libwebp/libavif versions, protocol schema, process model, OOPIF/site isolation, GPU command buffer metrics, and cache/code-cache state.

## D. Network and transport layer

- **[W]** Full-session `tcpdump` pcap and `SSLKEYLOGFILE` are retained.
- **[W]** Chromium NetLog JSON, Playwright HAR, Playwright request summaries, and CDP `Network.*` request/response/header/cache/websocket events are captured.
- **[T]** Decode pcap/NetLog into TLS, HTTP/2, HTTP/3, QUIC, DNS, mDNS, STUN/TURN, WebSocket, SSE, WebTransport, OCSP, Alt-Svc, redirect, cache, and connection-pool artifacts.
- **[T]** Compute TLS/transport fingerprints: JA3/JA3S, JA4/JA4S/JA4H/JA4L/JA4T/JA4TS, ClientHello/ServerHello bytes, GREASE positions, ALPN, cipher suites, extensions, supported groups, key shares, signature algorithms, ECH, certificate transparency, OCSP staple, resumption, session tickets, 0-RTT, and QUIC connection migration.
- **[T]** Compute HTTP fingerprints: HTTP/2 SETTINGS, Akamai/Peetprint, frame order, pseudo-header order, HPACK state, priorities, GOAWAY/RST_STREAM, header ordering, client hints, server timing, cache-control behavior, HSTS, partition keys, response body sizes, content-length mismatches, transfer encoding, range requests, and resource timing.
- **[T]** Persist request/response payloads: response bodies, POST bodies, decoded body hashes, content type sniffing, compression ratios, source maps, scripts, CSS, image/media bytes, and trust/privacy/ad-tech reporting payload summaries.
- **[T]** Capture in-browser network probes: WebRTC ICE/STUN/TURN, DNS prefetch/preconnect/resource hints, ServiceWorker interception overhead, cache/prefetch hits, Network Information API transitions, beacon targets, keepalive fetches, abort signals, and body stream tee/cancel events.

## E. Host OS, hardware, and local environment

- **[W]** `_instHostSnapshots` includes process list, network interfaces/routes/sockets, top/vm stats, uptime, DNS config, power/thermal status, a net sysctl subset, launchctl sample, ARP, directory-cache dump, powermetrics sample, and `lsof` for the node process.
- **[W]** Weles and trajectory provenance includes commit, tree hash, dist hash, and mtimes. The recording directory file manifest is captured.
- **[T]** Expand process/environment: full process tree, parent process, node argv/env with secret-class values hashed, Node/V8/libuv/OpenSSL/ICU versions, `os.*`, resource usage, per-Chromium-child argv, lsof, vmmap, sample profiles, fs/network/disk counters, ulimit, locale, getconf, tty/tmux/shell context, and PATH executable inventory.
- **[T]** Expand hardware: full `system_profiler`, `sysctl -a`, IORegistry with serial-class values hashed, CPU/microarch features, performance/efficiency core split, display EDID/ICC/DPR, GPU/Metal state, audio devices/routes, camera, storage, Thunderbolt, USB, Bluetooth, battery, Secure Enclave/T2, Touch ID, TPM/smart-card state, and attached input devices.
- **[T]** Expand network host state: DNS resolvers, DoH/VPN/proxy profile, routing, firewall/pf, interface MTU/flags/MACs, Wi-Fi RF environment with SSID/BSSID hashed, packet filter rules, path MTU events, DNSSEC, OCSP, and local resolver files.
- **[T]** Expand filesystem/apps/user state: mounts, diskutil, Time Machine, xattrs, quarantine bits, codesign/spctl, installed apps, LaunchServices handlers, default apps, local user/group counts hashed, launch agents/daemons, Homebrew packages, dictionaries/spellcheck/voices, Dock/menu bar/Stage Manager/wallpaper/theme preferences, iCloud/Continuity/Handoff/sharing state, Spotlight counts, and recent crash/log summaries.
- **[T]** Expand security/privacy state: SIP, Gatekeeper, AMFI, MDM profiles, TCC database counts for accessibility/camera/microphone/screen/input permissions, sandbox profile state, keychain entry count, kernel extensions, firmware/NVRAM, focus/DND/notification center counts, APNS/push state, calendars/reminders counts only, and sandbox/container/VM indicators.

## F. Weles, browser launch, and automation provenance

- **[W]** Persona blob, proxy config, exit IP/AS/geo, cidr-burn status, and version provenance are captured.
- **[T]** Persist browser command line with exploded `--enable-features` and `--disable-features`, browser executable hash, browser channel, Playwright version, node version, runtime libraries, and profile path.
- **[T]** Persist weles patch sets and injected code: Chromium/Firefox patches, init script full text and hashes, WebAuthn/Arkose/fetch/property/canvas/input hooks, generated CDP event list, persona seed/RNG state, proxy/account selection seeds, and resolved env key names.
- **[T]** Capture automation leak checks: webdriver globals, Playwright/Puppeteer/Selenium markers, DevTools protocol side effects, patched native source strings, permissions/CSP bypass capabilities, viewport/DPR consistency, hairline/subpixel rendering, input trust distribution, and extension/content-script injections.

## G. Page structure, DOM, forms, and accessibility

- **[T]** Per-frame static metadata: doctype, language, charset, referrer/referrer-policy, base URL, URL/documentURI, ready/compat/design modes, title changes, cookies hashed, feature/permissions policy, origin trials, CSP, COOP/COEP/CORP, sandbox/allow attributes, and ancestor chain.
- **[T]** Per-document resource graph: scripts, stylesheets, images/srcset/picture source decisions, iframes/srcdoc, links, preload/prefetch/modulepreload/preconnect/dns-prefetch/prerender hints, import maps, speculation rules, manifests, canonical/alternate links, meta theme/color/OG/Twitter/JSON-LD tags, SRI, crossorigin, nonce, fetchpriority, blocking, defer/async/nomodule, and module dependency graph.
- **[T]** DOM topology and mutation surfaces: DOM node counts, tag/class/id entropy, head-child order, shadow roots, slots, custom elements, adopted stylesheets, templates, declarative shadow DOM, custom element lifecycle, MutationRecord breakdown, detached nodes, layout/paint quad changes, BFCache eligibility, prerender/page visibility, and Navigation API state.
- **[T]** Forms and interactive elements: autocomplete hints, autofill suggestion availability, disabled/readonly/required/validity transitions, FormData iteration, constraint-validation events, contentEditable/spellcheck/translate/draggable/tabIndex/accessKey/lang, popovers/dialogs/details, focus traps, inert, pointer-events, touch-action, selection, range, scroll, geometry, and hit-test results.
- **[T]** Accessibility surfaces: full AX tree, per-element role/name/ARIA attributes, live region announcements, label associations, computed role/name, focus order, landmark counts, form labels, and accessibility-related TCC/OS settings.
- **[T]** Framework/page-behavior signals: JS framework/CMS detection, hydration markers, script execution order, critical CSS inlining, reactive state markers, source map discovery, event listener inventory, event `isTrusted`, and UI transition/animation state.

## H. Storage, identity, privacy, and per-origin state

- **[W]** IndexedDB database names, Storage hooks, document feature policy, cookies via network/CDP channels where already wired.
- **[T]** Per-origin storage inventory: cookies and attributes, CHIPS/partition keys, localStorage/sessionStorage, IndexedDB databases/object stores, CacheStorage entries, OPFS/storage buckets, shared storage, private aggregation, quota/usage, Storage Access API state, Cookie Store subscriptions, and storage events.
- **[T]** Per-origin identity/payment/security inventory: Credentials API, WebAuthn credential capability and extensions, Secure Payment Confirmation, FedCM/Digital Credentials, WebOTP, Payment Request, Push/WebPush subscriptions, Notification state, Login Status API, and permission grants/revocations.
- **[T]** Privacy/ad-tech state: Topics, Protected Audience/FLEDGE interest groups, Attribution Reporting, Trust/Private State Tokens, related website sets, first-party sets, ad-auction components, ad/block/tracking protection state, consent/storage access state, telemetry endpoint inventory, and privacy signal headers.

## I. Workers, service workers, worklets, and cross-context messaging

- **[T]** Worker contexts: dedicated/shared/module/service workers, worklet modules, script URLs, creation options, message counts/byte sizes, transferables, SharedArrayBuffer transfer, MessageChannel/MessagePort lifetimes, BroadcastChannel membership, Web Locks state, and cross-window references.
- **[T]** ServiceWorker state: registrations, scripts, lifecycle events, fetch interceptions, navigation preload, background sync/fetch, push manager, conflicts, bytecode cache, cache namespaces, and interception overhead.
- **[T]** Cross-context state: iframes/OOPIFs, detached browsing contexts, opener/parent/top/self access gates, BFCache restore, prerender activation, fenced frames, document picture-in-picture windows, page swap/reveal, and SharedArrayBuffer/cross-origin isolation attribution.

## J. WebRTC, realtime media, and peer transport

- **[W]** SDP, ICE candidates, and `getStats()` output are captured for peer connections.
- **[T]** WebRTC object matrix: PeerConnection config, ICE servers/policies, transceivers, senders, receivers, RTP capabilities, codecs, header extensions, data channels, SCTP, DTLS, SRTP cipher, certificates/fingerprints, insertable streams, encoded frame metadata, media track settings/capabilities/constraints, simulcast/SVC, and stats time series.
- **[T]** Realtime transport packets: STUN/TURN binding/allocation/permission/channel/refresh/data, mDNS candidates, ICE roles, candidate-pair state, TURN/TCP variants, DTLS handshake messages, SRTP packets, WebSocket extensions/frame timing/binary type/compression, SSE message rates, and WebTransport session limits.

## K. Trajectory, input, visual evidence, and repeatability

- **[W]** Per-action timestamp, start/end URL, screenshot frame hash, and humanClick/humanType/humanScroll/humanIdlePause atoms are logged.
- **[T]** Expand action provenance: trajectory file hash/imports, argv/env, branch trace, retry count, error category, duration histogram, action hash chain, screenshot/video sequence, visual diffs, and page-state snapshots per action.
- **[T]** Expand input detail: per-keystroke timings, composition/beforeinput/input/selectionchange events, pointer coalesced/predicted events, touch radii/force/rotation, wheel deltas, keyboard layout map, keyboard lock, click target selector/computed style, hit-test chain, page visibility ratio, audio playback state, idle/busy period histograms, and scripted-vs-human signals.
- **[T]** Repeatability markers: random seed, first-N random outputs, CSPRNG draw counts, date/timer drift, scheduler behavior, proxy/account selection seed, persona generation seed, cross-run diff fields, deterministic artifact hashes, and instability attribution.

## L. Crash, diagnostics, resource usage, and recording cost

- **[T]** Browser/renderer crashes, reloads, target detachments, JavaScript exceptions, unhandled rejections, console output, deprecations, interventions, mixed content, CSP reports, COOP/COEP reports, ReportingObserver buckets, Audits issues, low contrast/forms issues, and encoded response diagnostics.
- **[T]** Runtime resource counters: per-process CPU/RSS/threads/file descriptors/sockets, browser sampling profiles, heap snapshots retained size by constructor, GC/opt/deopt/JIT events, memory pressure, GPU command buffer usage, page heap/detached nodes, network bytes by artifact, and disk/cache footprint.
- **[T]** Per-session recording directory total size; per-artifact size for pcap, sslkey, netlog, har, screenshots, video, bodies, scripts, CSS, DOM, heap, and `cdp_firehose.ndjson`; `inst.json` line count and size; fraction of bytes by artifact type.

## M. Provenance, dedup, and update protocol

- **[W]** Weles, trajectory, dist, and artifact manifest provenance are captured.
- **[W]** Runtime `capture_coverage` block reports emitted/attempted/missing collector coverage for each `inst.json`.
- **[T]** Store capture schema version, collector version hashes, feature matrix version, CDP protocol version, dependency lockfile hash, browser binary signature/hash, system clock/timezone state, and all source files used to build the capture payload.
- **[T]** Dedup artifacts by sha256 where the same body/script/style/srcdoc/font/image appears multiple times, while preserving per-use references and timing.
- **[T]** Validate every run with a schema check and a diff-matrix smoke test.

When wiring new capture, flip `[T]` to `[W]` here in the same commit that lands the code. Add a new bullet only when it names a new collector boundary, artifact boundary, or explicit matrix that is not already covered by an existing bullet.
