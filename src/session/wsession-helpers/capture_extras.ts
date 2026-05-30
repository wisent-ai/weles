// Extra capture surfaces beyond network + property-trap, extracted from
// net_record.ts because that file hit the 300-line cap. All wired from
// startInstrumentation() at WSession.start; data lands on ws._instXxx arrays
// that net_record.ts's buildDumpPayload includes in the merged inst dump.

import type { BrowserContext } from 'playwright';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
      ws._instMetricsPollId = setInterval(async () => {
        try { const m = await cdp.send('Performance.getMetrics'); metricsHistory.push({ t: Date.now(), metrics: m?.metrics ?? [] }); } catch {}
      }, 10_000);
    } catch (e: any) { try { targetEvents.push({ t: Date.now(), phase: 'attach_error', err: String(e?.message ?? e) }); } catch {} }
  })();
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
