// Extra capture surfaces beyond network + property-trap, extracted from
// net_record.ts because that file hit the 300-line cap. All wired from
// startInstrumentation() at WSession.start; data lands on ws._instXxx arrays
// that net_record.ts's buildDumpPayload includes in the merged inst dump.

import type { BrowserContext } from 'playwright';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { CDP_EVENTS } from './cdp_events.generated.js';

// Service worker registration events. Fires when the page registers / activates
// a SW; relevant because many bot-checks (PerimeterX, Akamai, hCaptcha) ship
// their logic via SW for cross-frame state.
export function attachServiceWorkers(ctx: BrowserContext, swEvents: any[]): void {
  try {
    (ctx as any).on?.('serviceworker', (sw: any) => {
      try { swEvents.push({ t: Date.now(), phase: 'register', url: sw.url?.() ?? null }); } catch {}
    });
  } catch {}
}

// CDP target lifecycle + frame attach/detach/navigate + periodic
// Performance.getMetrics + raw wire-level Network.* extra info. Uses the
// WSession's existing CDP session (created in the constructor for
// Network.dataReceived). Network.*ExtraInfo events surface the actual
// on-the-wire headers (including HTTP/2 :method/:path/:authority/:scheme
// pseudo-headers and the cookie pair line as sent), connection-reuse info,
// and final loaded byte counts that Playwright's ctx.on('response') hides.
export function attachCdpLifecycle(ws: any, _ctx: BrowserContext, targetEvents: any[], frameEvents: any[], metricsHistory: any[]): void {
  void (async () => {
    try {
      // The WSession constructor sets ws._cdp asynchronously; wait briefly.
      for (let i = 0; i < 20 && !ws._cdp; i++) await new Promise(r => setImmediate(r));
      const cdp = ws._cdp;
      if (!cdp) return;
      try { await cdp.send('Target.setDiscoverTargets', { discover: true }); } catch {}
      try { await cdp.send('Page.enable'); } catch {}
      try { await cdp.send('Performance.enable'); } catch {}
      cdp.on('Target.targetCreated', (e: any) => { try { targetEvents.push({ t: Date.now(), phase: 'created', info: e?.targetInfo }); } catch {} });
      cdp.on('Target.targetDestroyed', (e: any) => { try { targetEvents.push({ t: Date.now(), phase: 'destroyed', targetId: e?.targetId }); } catch {} });
      cdp.on('Target.targetInfoChanged', (e: any) => { try { targetEvents.push({ t: Date.now(), phase: 'changed', info: e?.targetInfo }); } catch {} });
      cdp.on('Page.frameAttached', (e: any) => { try { frameEvents.push({ t: Date.now(), phase: 'attached', frameId: e?.frameId, parentFrameId: e?.parentFrameId }); } catch {} });
      cdp.on('Page.frameDetached', (e: any) => { try { frameEvents.push({ t: Date.now(), phase: 'detached', frameId: e?.frameId, reason: e?.reason }); } catch {} });
      cdp.on('Page.frameNavigated', (e: any) => { try { frameEvents.push({ t: Date.now(), phase: 'navigated', frameId: e?.frame?.id, url: e?.frame?.url, securityOrigin: e?.frame?.securityOrigin }); } catch {} });
      // Raw wire-level CDP Network.* events. The WSession constructor already
      // calls Network.enable for dataReceived; these handlers latch on the
      // same session. cdp_network array lives on ws so buildDumpPayload reads
      // it without an extra plumbing layer.
      if (!ws._instCdpNetwork) ws._instCdpNetwork = [];
      const nw = ws._instCdpNetwork;
      cdp.on('Network.requestWillBeSentExtraInfo', (e: any) => { try { nw.push({ t: Date.now(), phase: 'reqExtra', requestId: e?.requestId, associatedCookies: e?.associatedCookies, headers: e?.headers, connectTiming: e?.connectTiming, clientSecurityState: e?.clientSecurityState, siteHasCookieInOtherPartition: e?.siteHasCookieInOtherPartition }); } catch {} });
      cdp.on('Network.responseReceivedExtraInfo', (e: any) => { try { nw.push({ t: Date.now(), phase: 'resExtra', requestId: e?.requestId, blockedCookies: e?.blockedCookies, headers: e?.headers, resourceIPAddressSpace: e?.resourceIPAddressSpace, statusCode: e?.statusCode, headersText: e?.headersText, cookiePartitionKey: e?.cookiePartitionKey, cookiePartitionKeyOpaque: e?.cookiePartitionKeyOpaque }); } catch {} });
      cdp.on('Network.loadingFinished', (e: any) => { try { nw.push({ t: Date.now(), phase: 'loadingFinished', requestId: e?.requestId, encodedDataLength: e?.encodedDataLength, shouldReportCorbBlocking: e?.shouldReportCorbBlocking }); } catch {} });
      cdp.on('Network.loadingFailed', (e: any) => { try { nw.push({ t: Date.now(), phase: 'loadingFailed', requestId: e?.requestId, type: e?.type, errorText: e?.errorText, canceled: e?.canceled, blockedReason: e?.blockedReason, corsErrorStatus: e?.corsErrorStatus }); } catch {} });
      cdp.on('Network.signedExchangeReceived', (e: any) => { try { nw.push({ t: Date.now(), phase: 'signedExchange', requestId: e?.requestId, info: e?.info }); } catch {} });
      cdp.on('Network.requestServedFromCache', (e: any) => { try { nw.push({ t: Date.now(), phase: 'servedFromCache', requestId: e?.requestId }); } catch {} });
      cdp.on('Network.webSocketHandshakeResponseReceived', (e: any) => { try { nw.push({ t: Date.now(), phase: 'wsHandshakeRes', requestId: e?.requestId, response: e?.response }); } catch {} });
      cdp.on('Network.webSocketWillSendHandshakeRequest', (e: any) => { try { nw.push({ t: Date.now(), phase: 'wsHandshakeReq', requestId: e?.requestId, request: e?.request }); } catch {} });
      // Performance + per-helper-process info. SystemInfo.getProcessInfo
      // returns the full Chromium process tree (gpu, renderer, utility,
      // network, plugin, broker, etc.) with cpuTime + os pid + processType.
      ws._instProcessHistory = [];
      ws._instMetricsPollId = setInterval(async () => {
        try { const m = await cdp.send('Performance.getMetrics'); metricsHistory.push({ t: Date.now(), metrics: m?.metrics ?? [] }); } catch {}
        try { const p = await cdp.send('SystemInfo.getProcessInfo'); ws._instProcessHistory.push({ t: Date.now(), processInfo: p }); } catch {}
      }, 10_000);
      // One-shot system info — full GPU adapter list with vendor, device,
      // driver version, GL renderer, supported video decoders, command-line
      // flags Chrome actually launched with. Captured once at session start.
      try { ws._instSystemInfo = await cdp.send('SystemInfo.getInfo'); } catch (e: any) { ws._instSystemInfo = { error: String(e?.message ?? e) }; }
      try { ws._instProcessInfo = await cdp.send('SystemInfo.getProcessInfo'); } catch (e: any) { ws._instProcessInfo = { error: String(e?.message ?? e) }; }
      // CDP Tracing — every browser internal event (V8 GC + JIT, layout,
      // paint, GPU, blink, devtools timeline) at microsecond resolution.
      // dataCollected events stream individually; we accumulate then write at
      // tracingComplete time. The category set covers the most useful slices
      // without enabling Tracing's verbose log-class which produces hundreds
      // of MB. Fail-quiet if the binary doesn't support Tracing.
      ws._instTracing = [];
      cdp.on('Tracing.dataCollected', (e: any) => { try { for (const ev of (e?.value ?? [])) ws._instTracing.push(ev); } catch {} });
      try { await cdp.send('Tracing.start', { categories: 'v8,blink,devtools.timeline,disabled-by-default-devtools.timeline,latencyInfo,toplevel', options: 'sampling-frequency=10000' }); } catch (e: any) { ws._instTracingError = String(e?.message ?? e); }
      // JS coverage — which functions actually ran.
      try { await cdp.send('Profiler.enable'); await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false }); } catch (e: any) { ws._instJsCoverageError = String(e?.message ?? e); }
      // CSS coverage — which rules matched.
      try { await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); await cdp.send('CSS.startRuleUsageTracking'); } catch (e: any) { ws._instCssCoverageError = String(e?.message ?? e); }
      // WebAudio lifecycle — context created/destroyed/changed at CDP level.
      ws._instWebAudio = [];
      try { await cdp.send('WebAudio.enable'); } catch (e: any) { ws._instWebAudioError = String(e?.message ?? e); }
      cdp.on('WebAudio.contextCreated', (e: any) => { try { ws._instWebAudio.push({ t: Date.now(), phase: 'contextCreated', context: e?.context }); } catch {} });
      cdp.on('WebAudio.contextDestroyed', (e: any) => { try { ws._instWebAudio.push({ t: Date.now(), phase: 'contextDestroyed', contextId: e?.contextId }); } catch {} });
      cdp.on('WebAudio.contextChanged', (e: any) => { try { ws._instWebAudio.push({ t: Date.now(), phase: 'contextChanged', context: e?.context }); } catch {} });
      // Animation.* — every CSS / Web Animations API animation start / cancel / update.
      ws._instAnimations = [];
      try { await cdp.send('Animation.enable'); } catch (e: any) { ws._instAnimationsError = String(e?.message ?? e); }
      cdp.on('Animation.animationCreated', (e: any) => { try { ws._instAnimations.push({ t: Date.now(), phase: 'created', id: e?.id }); } catch {} });
      cdp.on('Animation.animationStarted', (e: any) => { try { ws._instAnimations.push({ t: Date.now(), phase: 'started', animation: e?.animation }); } catch {} });
      cdp.on('Animation.animationCanceled', (e: any) => { try { ws._instAnimations.push({ t: Date.now(), phase: 'canceled', id: e?.id }); } catch {} });
      cdp.on('Animation.animationUpdated', (e: any) => { try { ws._instAnimations.push({ t: Date.now(), phase: 'updated', animation: e?.animation }); } catch {} });
      // IndexedDB.* — DB created/updated/version-changed events. Many bot
      // detectors store fingerprint state in IndexedDB to survive cookie wipes.
      ws._instIndexedDb = [];
      try { await cdp.send('IndexedDB.enable'); } catch (e: any) { ws._instIndexedDbError = String(e?.message ?? e); }
      cdp.on('IndexedDB.databaseCreated', (e: any) => { try { ws._instIndexedDb.push({ t: Date.now(), phase: 'created', name: e?.databaseName, origin: e?.origin }); } catch {} });
      cdp.on('IndexedDB.versionChange', (e: any) => { try { ws._instIndexedDb.push({ t: Date.now(), phase: 'versionChange', name: e?.databaseName }); } catch {} });
      // Memory.getDOMCounters polled every 10s — Documents, Nodes, JSEventListeners
      // counts on the renderer process. Cheap, useful for memory-leak detection
      // and for spotting bot-detection scripts that spawn many short-lived nodes.
      ws._instDomCounters = [];
      ws._instDomCountersPollId = setInterval(async () => {
        try { const c = await cdp.send('Memory.getDOMCounters'); ws._instDomCounters.push({ t: Date.now(), counters: c }); } catch {}
      }, 10_000);
      // Page lifecycle markers + dialog/file-chooser/window-open + within-doc nav.
      ws._instPageEvents = [];
      try { await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }); } catch {}
      cdp.on('Page.lifecycleEvent', (e: any) => { try { ws._instPageEvents.push({ t: Date.now(), phase: 'lifecycle', name: e?.name, frameId: e?.frameId, loaderId: e?.loaderId, timestamp: e?.timestamp }); } catch {} });
      cdp.on('Page.javascriptDialogOpening', (e: any) => { try { ws._instPageEvents.push({ t: Date.now(), phase: 'dialog', type: e?.type, message: e?.message, url: e?.url, defaultPrompt: e?.defaultPrompt }); } catch {} });
      cdp.on('Page.fileChooserOpened', (e: any) => { try { ws._instPageEvents.push({ t: Date.now(), phase: 'fileChooser', frameId: e?.frameId, mode: e?.mode, backendNodeId: e?.backendNodeId }); } catch {} });
      cdp.on('Page.windowOpen', (e: any) => { try { ws._instPageEvents.push({ t: Date.now(), phase: 'windowOpen', url: e?.url, windowName: e?.windowName, windowFeatures: e?.windowFeatures, userGesture: e?.userGesture }); } catch {} });
      cdp.on('Page.navigatedWithinDocument', (e: any) => { try { ws._instPageEvents.push({ t: Date.now(), phase: 'navWithinDoc', frameId: e?.frameId, url: e?.url }); } catch {} });
      // Runtime — full console + uncaught exceptions at CDP level (richer than
      // Playwright's page.on('console') wrap; preserves Runtime.RemoteObject
      // for each arg + stack trace).
      ws._instRuntime = [];
      try { await cdp.send('Runtime.enable'); } catch {}
      cdp.on('Runtime.consoleAPICalled', (e: any) => { try { ws._instRuntime.push({ t: Date.now(), phase: 'console', type: e?.type, args: e?.args, executionContextId: e?.executionContextId, stackTrace: e?.stackTrace }); } catch {} });
      cdp.on('Runtime.exceptionThrown', (e: any) => { try { ws._instRuntime.push({ t: Date.now(), phase: 'exception', timestamp: e?.timestamp, exceptionDetails: e?.exceptionDetails }); } catch {} });
      // Browser-level log entries (network, deprecation, intervention, security).
      ws._instLog = [];
      try { await cdp.send('Log.enable'); } catch {}
      cdp.on('Log.entryAdded', (e: any) => { try { ws._instLog.push({ t: Date.now(), entry: e?.entry }); } catch {} });
      // Security state — TLS state changes, mixed content, cert warnings.
      ws._instSecurity = [];
      try { await cdp.send('Security.enable'); } catch {}
      cdp.on('Security.securityStateChanged', (e: any) => { try { ws._instSecurity.push({ t: Date.now(), phase: 'stateChanged', securityState: e?.securityState, summary: e?.summary, explanations: e?.explanations, insecureContentStatus: e?.insecureContentStatus }); } catch {} });
      cdp.on('Security.visibleSecurityStateChanged', (e: any) => { try { ws._instSecurity.push({ t: Date.now(), phase: 'visibleStateChanged', visibleSecurityState: e?.visibleSecurityState }); } catch {} });
      // Storage privacy-sandbox events.
      ws._instStorageEvents = [];
      cdp.on('Storage.indexedDBListUpdated', (e: any) => { try { ws._instStorageEvents.push({ t: Date.now(), phase: 'idbList', origin: e?.origin, storageKey: e?.storageKey }); } catch {} });
      cdp.on('Storage.cacheStorageListUpdated', (e: any) => { try { ws._instStorageEvents.push({ t: Date.now(), phase: 'cacheList', origin: e?.origin }); } catch {} });
      cdp.on('Storage.interestGroupAccessed', (e: any) => { try { ws._instStorageEvents.push({ t: Date.now(), phase: 'interestGroup', accessTime: e?.accessTime, type: e?.type, ownerOrigin: e?.ownerOrigin, name: e?.name }); } catch {} });
      cdp.on('Storage.sharedStorageAccessed', (e: any) => { try { ws._instStorageEvents.push({ t: Date.now(), phase: 'sharedStorage', accessTime: e?.accessTime, type: e?.type, ownerOrigin: e?.ownerOrigin, params: e?.params }); } catch {} });
      // Browser downloads.
      cdp.on('Browser.downloadWillBegin', (e: any) => { try { ws._instPageEvents.push({ t: Date.now(), phase: 'downloadBegin', frameId: e?.frameId, guid: e?.guid, url: e?.url, suggestedFilename: e?.suggestedFilename }); } catch {} });
      cdp.on('Browser.downloadProgress', (e: any) => { try { ws._instPageEvents.push({ t: Date.now(), phase: 'downloadProgress', guid: e?.guid, totalBytes: e?.totalBytes, receivedBytes: e?.receivedBytes, state: e?.state }); } catch {} });
      // CDP firehose — subscribe to every documented event from
      // protocol.d.ts via the generated list. Events from already-enabled
      // domains land in ws._instCdpFirehose; events from un-enabled domains
      // simply never fire. This is the bounded-set capture replacing the
      // one-channel-at-a-time wiring.
      ws._instCdpFirehose = [];
      ws._instCdpFirehoseOverflow = 0;
      const enableDomains = new Set(CDP_EVENTS.map(e => e[0]));
      for (const d of enableDomains) {
        try { await cdp.send(`${d}.enable` as any); } catch {}
      }
      for (const [domain, event] of CDP_EVENTS) {
        const key = `${domain}.${event}`;
        try {
          cdp.on(key, (payload: any) => {
            try {
              if (ws._instCdpFirehose.length >= 100000) { ws._instCdpFirehoseOverflow++; return; }
              ws._instCdpFirehose.push({ t: Date.now(), domain, event, payload });
            } catch {}
          });
        } catch {}
      }
    } catch (e: any) { try { targetEvents.push({ t: Date.now(), phase: 'attach_error', err: String(e?.message ?? e) }); } catch {} }
  })();
}

// Final-state CDP captures invoked from finalDump: DOMSnapshot of every frame
// (full DOM tree + computed styles + layout boxes), one HeapProfiler snapshot.
// Both produce large payloads — done once at close, not periodically.
export async function captureFinalCdpSnapshots(ws: any): Promise<void> {
  const cdp = ws?._cdp;
  if (!cdp) return;
  // DOMSnapshot includes shadow tree contents in the documents[] array when
  // captured; CDP's DOMSnapshot.captureSnapshot walks shadow roots by default
  // for open shadow roots. Combined with DOM.getDocument({pierce:true}) for
  // the closed-shadow case via a sibling call.
  try { ws._instDomSnapshot = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: true, includePaintOrder: true, includeBlendedBackgroundColors: true, includeTextColorOpacities: true }); } catch (e: any) { ws._instDomSnapshotError = String(e?.message ?? e); }
  try { ws._instDomPiercedTree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }); } catch (e: any) { ws._instDomPiercedTreeError = String(e?.message ?? e); }
  try {
    const chunks: string[] = [];
    const handler = (e: any) => { chunks.push(e?.chunk ?? ''); };
    cdp.on('HeapProfiler.addHeapSnapshotChunk', handler);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true });
    cdp.off?.('HeapProfiler.addHeapSnapshotChunk', handler);
    ws._instHeapSnapshot = chunks.join('');
  } catch (e: any) { ws._instHeapSnapshotError = String(e?.message ?? e); }
}

// One-shot OS-level snapshots at session start.
export function captureHostSnapshots(ws: any): void {
  const probe = (cmd: string) => { try { return execSync(cmd, { encoding: 'utf8' }); } catch (e: any) { return 'ERR: ' + String(e?.message ?? e); } };
  const isMac = process.platform === 'darwin';
  ws._instHostSnapshots = {
    ps: probe(isMac ? 'ps -axo pid,ppid,user,command' : 'ps -axo pid,ppid,user,cmd'),
    ifconfig: probe(isMac ? 'ifconfig' : 'ip -j addr'),
    route: probe(isMac ? 'netstat -rn' : 'ip -j route'),
    netstat: probe(isMac ? 'netstat -an -p tcp' : 'ss -tan'),
    top: probe(isMac ? 'top -l 1 -n 20 -stats pid,command,cpu,mem,state' : 'top -bn1 -w 200 | head -30'),
    vmstat: probe(isMac ? 'vm_stat' : 'free -m'),
    uptime: probe('uptime'),
    resolv: probe(isMac ? 'scutil --dns 2>/dev/null || cat /etc/resolv.conf' : 'cat /etc/resolv.conf'),
    pmset: probe(isMac ? 'pmset -g batt; pmset -g therm' : 'cat /sys/class/power_supply/BAT0/uevent 2>/dev/null || echo no-battery'),
    sysctl_net: probe(isMac ? 'sysctl -a 2>/dev/null | grep -E "net\\." | head -200' : 'sysctl -a 2>/dev/null | grep -E "net\\." | head -200'),
    launchctl: isMac ? probe('launchctl list | head -100') : probe('systemctl list-units --type=service --state=running | head -100'),
    arp: probe(isMac ? 'arp -an' : 'ip neigh'),
    dns_cache: isMac ? probe('dscacheutil -cachedump -entries 2>/dev/null || echo cache-disabled') : probe('resolvectl statistics 2>/dev/null || echo no-resolvectl'),
    thermal: isMac ? probe('powermetrics -n 1 -i 100 --samplers smc 2>/dev/null | head -50 || echo needs-sudo') : probe('sensors 2>/dev/null || echo no-sensors'),
    lsof_node: probe(`lsof -p ${process.pid} 2>/dev/null | head -100 || echo lsof-failed`),
    sockstat: isMac ? probe('netstat -an -p tcp -p udp 2>/dev/null | head -80') : probe('ss -tani 2>/dev/null | head -80'),
    captured_at: new Date().toISOString(),
  };
}

// Playwright-side page-level event hooks. Complements the CDP Page.* events
// (which fire on the browser side) by also capturing what Playwright's own
// event surface sees — popup/download/dialog/filechooser.
export function attachPagePlaywrightEvents(ws: any): void {
  if (!ws.page) return;
  ws._instPlaywrightEvents = [];
  const push = (e: any) => { try { ws._instPlaywrightEvents.push(e); } catch {} };
  try { ws.page.on?.('popup', (p: any) => push({ t: Date.now(), phase: 'popup', url: p?.url?.() ?? null })); } catch {}
  try { ws.page.on?.('download', (d: any) => push({ t: Date.now(), phase: 'download', url: d?.url?.() ?? null, suggestedFilename: d?.suggestedFilename?.() ?? null })); } catch {}
  try { ws.page.on?.('filechooser', (f: any) => push({ t: Date.now(), phase: 'filechooser', isMultiple: f?.isMultiple?.() ?? null })); } catch {}
  try { ws.page.on?.('dialog', (d: any) => push({ t: Date.now(), phase: 'dialog', type: d?.type?.(), message: d?.message?.(), defaultValue: d?.defaultValue?.() })); } catch {}
  try { ws.page.on?.('worker', (w: any) => push({ t: Date.now(), phase: 'worker', url: w?.url?.() ?? null })); } catch {}
  try { ws.page.on?.('framenavigated', (f: any) => push({ t: Date.now(), phase: 'frameNavigated', url: f?.url?.() ?? null, name: f?.name?.() ?? null })); } catch {}
}

// Periodic ctx.storageState() snapshot. Cookies + localStorage + sessionStorage
// + IndexedDB-origin metadata across all origins the context has touched.
// Captured at start, every 10s thereafter, and on close (via finalDump).
export function pollStorageState(ws: any, ctx: BrowserContext, storageHistory: any[]): void {
  void (async () => { try { storageHistory.push({ t: Date.now(), state: await ctx.storageState() }); } catch {} })();
  ws._instStoragePollId = setInterval(async () => {
    try { storageHistory.push({ t: Date.now(), state: await ctx.storageState() }); } catch {}
  }, 10_000);
}

// Sibling-file manifest: list every file currently in recordings/<label>/
// other than the inst.json itself, with size + mtime. Lets the inst dump
// reference its webm / DOM / screenshots / network.ndjson companions by path
// instead of inlining them.
export function buildSiblingManifest(dir: string, instFn: string): any[] {
  try {
    return readdirSync(dir).filter(n => join(dir, n) !== instFn).map(n => {
      try { const s = statSync(join(dir, n)); return { name: n, size: s.size, mtime: s.mtimeMs }; }
      catch { return { name: n, error: 'stat_failed' }; }
    });
  } catch { return []; }
}

// Process-wide console capture. Tees console method calls into a module-scoped
// ring buffer (capped so a chatty session can't OOM). Each WSession records
// the buffer offset at startInstrumentation and slices from there at dump
// time, so concurrent sessions see only their own lines and sequential
// sessions don't double-count. Patches console once per process; safe to call
// from every WSession.start.
import { CONSOLE_LEVELS } from './capture_constants.js';
const STDOUT_RING: Array<{ t: number; level: string; line: string }> = [];
const STDOUT_RING_CAP = 50_000;
let _consolePatched = false;
function patchConsoleOnce(): void {
  if (_consolePatched) return;
  _consolePatched = true;
  const formats = (args: any[]) => args.map(a => {
    try { return typeof a === 'string' ? a : JSON.stringify(a); }
    catch { return String(a); }
  }).join(' ');
  for (const level of CONSOLE_LEVELS) {
    const orig = (console as any)[level].bind(console);
    (console as any)[level] = (...args: any[]) => {
      try {
        STDOUT_RING.push({ t: Date.now(), level, line: formats(args) });
        if (STDOUT_RING.length > STDOUT_RING_CAP) STDOUT_RING.shift();
      } catch {}
      orig(...args);
    };
  }
}
export function attachStdoutCapture(ws: any): void {
  try { patchConsoleOnce(); ws._instStdoutOffset = STDOUT_RING.length; } catch {}
}
export function sliceStdout(ws: any): any[] {
  try { return STDOUT_RING.slice(ws._instStdoutOffset ?? 0); } catch { return []; }
}
