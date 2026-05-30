// Complete-record network capture. Attaches to a Playwright BrowserContext
// and pushes one entry per HTTP request, response, request-failure, and
// WebSocket frame into the shared `reqs` array. NO domain filter, NO body
// truncation. Both utf8 and base64 forms of bodies are recorded so binary
// payloads (gzip-encoded, compressed images, protobufs) survive intact.
// 2026-05-15: extracted from wsession.ts to keep that file under the 300-line
// cap. Also handles the per-frame JS access-trap flush so the whole {accesses,
// requests} dump lives in one helper. The shared `reqs` array is exposed via
// `(ws as any)._instRequests` so finalize.ts can write the final dump shape.

import type { BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform as osPlatform, release as osRelease, arch as osArch, totalmem, cpus, hostname, version as osVersion } from 'node:os';

// One merged fingerprint artifact per run, written under recordings/<label>/ so
// the worker uploader (src/worker/upload-artifacts.ts) picks it up alongside
// webm + DOM snapshots and pushes everything to Supabase Storage in one batch.
// The dump shape ({accesses, requests, console, pageerrors, persona, proxy,
// versions, label, started_at}) covers every page-side + network channel
// captured by WSession; the screenshots/DOM/webm artifacts in the same dir are
// the visual companions to it. The capture surface deliberately has NO domain
// filter, NO body truncation, and runs on every WSession (keepers and
// trajectories) without exception per the 2026-05-24 standing instruction.
export function startInstrumentation(ws: any, ctx: BrowserContext, label: string | undefined): any[] {
  const dir = join(process.cwd(), 'recordings', label || 'session');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fn = join(dir, `${label || 'session'}_${ts}.inst.json`);
  const accum = new Map();
  const reqs: any[] = [];
  const consoleMsgs: any[] = [];
  const pageErrors: any[] = [];
  const startedAt = new Date().toISOString();
  const swEvents: any[] = [];
  const targetEvents: any[] = [];
  const frameEvents: any[] = [];
  const metricsHistory: any[] = [];
  const storageHistory: any[] = [];
  ws._instRequests = reqs;
  ws._instConsole = consoleMsgs;
  ws._instPageErrors = pageErrors;
  ws._instSwEvents = swEvents;
  ws._instTargetEvents = targetEvents;
  ws._instFrameEvents = frameEvents;
  ws._instMetricsHistory = metricsHistory;
  ws._instStorageHistory = storageHistory;
  ws._instAccum = accum;
  ws._instFile = fn;
  ws._instDir = dir;
  ws._instStartedAt = startedAt;
  ws._instHost = {
    platform: osPlatform(), release: osRelease(), arch: osArch(), version: osVersion?.() ?? null,
    hostname: hostname(), totalmem: totalmem(), cpu_count: cpus().length, cpu_model: cpus()[0]?.model ?? null,
    node_version: process.version, pid: process.pid,
  };
  attachCompleteNetRecord(ctx, reqs);
  attachPageDiagnostics(ws, consoleMsgs, pageErrors);
  attachServiceWorkers(ctx, swEvents);
  attachCdpLifecycle(ws, ctx, targetEvents, frameEvents, metricsHistory);
  pollStorageState(ws, ctx, storageHistory);
  setInterval(async () => {
    try {
      for (const f of ws.page.frames()) {
        try {
          const j: string = await f.evaluate('(()=>{var a=globalThis[Symbol.for("weles.inst")];return a?a.flush():"[]"})()');  // allow-raw-playwright: instrumentation flush
          const log = JSON.parse(j);
          if (!log.length) continue;
          const url = f.url();
          const prev = accum.get(url);
          if (!prev || log.length > prev.log.length) accum.set(url, { url, log });
        } catch {}
      }
      writeFileSync(fn, JSON.stringify(buildDumpPayload(ws)));
    } catch {}
  }, 5000);
  return reqs;
}

// Called at WSession close: one last flush of the property-trap log across all
// frames + write the final merged dump. Overwrites the file the interval writer
// has been refreshing every 5 seconds with the most-recent state, so the
// uploaded artifact contains everything up to the moment of close.
export async function finalDump(ws: any): Promise<void> {
  if (!ws?._instFile) return;
  try {
    if (!ws.page?.isClosed?.()) {
      for (const f of ws.page.frames?.() ?? []) {
        try {
          const j: string = await f.evaluate('(()=>{var a=globalThis[Symbol.for("weles.inst")];return a?a.flush():"[]"})()');  // allow-raw-playwright: instrumentation flush
          const log = JSON.parse(j);
          if (!log.length) continue;
          const url = f.url();
          const prev = ws._instAccum.get(url);
          if (!prev || log.length > prev.log.length) ws._instAccum.set(url, { url, log });
        } catch {}
      }
    }
    writeFileSync(ws._instFile, JSON.stringify(buildDumpPayload(ws, { closing: true })));
    console.log(`[wsession] final inst dump -> ${ws._instFile}`);
  } catch (e: any) { console.log(`[wsession] finalDump err: ${e?.message?.slice(0, 120)}`); }
}

// Subscribe to console + pageerror so they ride in the same merged inst dump
// instead of being lost. Each console event gets type, text, location, and
// per-arg .jsonValue() resolution where possible. pageerror captures uncaught
// runtime errors from the page itself.
function attachPageDiagnostics(ws: any, consoleMsgs: any[], pageErrors: any[]): void {
  try {
    ws.page.on?.('console', async (msg: any) => {
      try {
        const args: any[] = [];
        for (const a of (msg.args?.() ?? [])) {
          try { args.push(await a.jsonValue?.()); } catch { args.push(String(a)); }
        }
        consoleMsgs.push({ t: Date.now(), type: msg.type?.(), text: msg.text?.(), location: msg.location?.(), args });
      } catch {}
    });
    ws.page.on?.('pageerror', (err: any) => {
      try { pageErrors.push({ t: Date.now(), name: err?.name, message: err?.message, stack: err?.stack }); } catch {}
    });
    ws.page.on?.('crash', () => {
      try { pageErrors.push({ t: Date.now(), name: 'crash', message: 'page crashed', stack: null }); } catch {}
    });
  } catch {}
}

export function attachCompleteNetRecord(ctx: BrowserContext, reqs: any[]): void {
  ctx.on('request', (req) => {
    try {
      let post = '';
      try { post = req.postData() ?? ''; } catch {}
      let postBytes = '';
      try { const b = (req as any).postDataBuffer?.(); if (b) postBytes = Buffer.from(b).toString('base64'); } catch {}
      reqs.push({
        t: Date.now(),
        phase: 'req',
        method: req.method(),
        url: req.url(),
        resourceType: (req as any).resourceType?.(),
        headers: req.headers(),
        postData: post,
        postDataBase64: postBytes,
      });
    } catch {}
  });
  ctx.on('response', (resp) => {
    // Push metadata synchronously, hydrate body asynchronously. Prior version
    // awaited resp.body() inline which serialized hundreds of handlers and
    // starved the trajectory event loop (run15 hung at goto for 2:40).
    const entry: any = {
      t: Date.now(),
      phase: 'res',
      status: resp.status(),
      url: resp.url(),
      headers: resp.headers(),
      body: null,
      bodyBase64: null,
      bodyError: null,
    };
    try { entry.statusText = (resp as any).statusText?.(); } catch (e: any) { entry.statusText_err = String(e?.message ?? e); }
    try { entry.timing = (resp.request?.() as any).timing?.(); } catch (e: any) { entry.timing_err = String(e?.message ?? e); }
    reqs.push(entry);
    // Fire-and-forget body fetch; mutates entry in place when it lands.
    resp.body().then((buf) => {
      entry.bodyBase64 = Buffer.from(buf).toString('base64');
      try { entry.body = buf.toString('utf8'); } catch (e: any) { entry.body_decode_err = String(e?.message ?? e); }
    }, (err) => { entry.bodyError = String(err?.message ?? err); });
    const sa = (resp as any).serverAddr?.();
    if (sa && typeof sa.then === 'function') sa.then((s: any) => { entry.serverAddr = s; }, (err: any) => { entry.serverAddrError = String(err?.message ?? err); });
    const sd = (resp as any).securityDetails?.();
    if (sd && typeof sd.then === 'function') sd.then((s: any) => { entry.securityDetails = s; }, (err: any) => { entry.securityDetailsError = String(err?.message ?? err); });
  });
  ctx.on('requestfailed', (req) => {
    try {
      reqs.push({
        t: Date.now(),
        phase: 'reqfailed',
        method: req.method(),
        url: req.url(),
        failure: req.failure(),
      });
    } catch {}
  });
  // WebSocket capture: every frame in both directions.
  (ctx as any).on?.('websocket', (sock: any) => {
    try {
      const u = sock.url();
      reqs.push({ t: Date.now(), phase: 'ws-open', url: u });
      sock.on('framesent', (f: any) => {
        try {
          const p = f.payload;
          const payload = Buffer.isBuffer(p) ? p.toString('base64') : String(p ?? '');
          reqs.push({ t: Date.now(), phase: 'ws-tx', url: u, payload });
        } catch {}
      });
      sock.on('framereceived', (f: any) => {
        try {
          const p = f.payload;
          const payload = Buffer.isBuffer(p) ? p.toString('base64') : String(p ?? '');
          reqs.push({ t: Date.now(), phase: 'ws-rx', url: u, payload });
        } catch {}
      });
      sock.on('close', () => {
        try { reqs.push({ t: Date.now(), phase: 'ws-close', url: u }); } catch {}
      });
      sock.on('socketerror', (e: any) => {
        try { reqs.push({ t: Date.now(), phase: 'ws-error', url: u, error: String(e) }); } catch {}
      });
    } catch {}
  });
}

// Service worker registration events. Fires when the page registers / activates
// a SW; relevant because many bot-checks (PerimeterX, Akamai, hCaptcha) ship
// their logic via SW for cross-frame state.
function attachServiceWorkers(ctx: BrowserContext, swEvents: any[]): void {
  try {
    (ctx as any).on?.('serviceworker', (sw: any) => {
      try { swEvents.push({ t: Date.now(), phase: 'register', url: sw.url?.() ?? null }); } catch {}
    });
  } catch {}
}

// CDP target lifecycle + frame attach/detach/navigate + periodic
// Performance.getMetrics. Uses the WSession's existing CDP session (created in
// the constructor for Network.dataReceived) — adds Target / Page subscriptions
// + a getMetrics poll into the per-interval write.
function attachCdpLifecycle(ws: any, ctx: BrowserContext, targetEvents: any[], frameEvents: any[], metricsHistory: any[]): void {
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
      ws._instMetricsPollId = setInterval(async () => {
        try { const m = await cdp.send('Performance.getMetrics'); metricsHistory.push({ t: Date.now(), metrics: m?.metrics ?? [] }); } catch {}
      }, 10_000);
    } catch (e: any) { try { targetEvents.push({ t: Date.now(), phase: 'attach_error', err: String(e?.message ?? e) }); } catch {} }
  })();
}

// Periodic ctx.storageState() snapshot. Cookies + localStorage + sessionStorage
// + IndexedDB-origin metadata across all origins the context has touched.
// Captured at start, every 10s thereafter, and on close (via finalDump).
function pollStorageState(ws: any, ctx: BrowserContext, storageHistory: any[]): void {
  void (async () => { try { storageHistory.push({ t: Date.now(), state: await ctx.storageState() }); } catch {} })();
  ws._instStoragePollId = setInterval(async () => {
    try { storageHistory.push({ t: Date.now(), state: await ctx.storageState() }); } catch {}
  }, 10_000);
}

// Sibling-file manifest: list every file currently in recordings/<label>/
// other than the inst.json itself, with size + mtime. Lets the inst dump
// reference its webm / DOM / screenshots / network.ndjson companions by path
// instead of inlining them.
function buildSiblingManifest(dir: string, instFn: string): any[] {
  try {
    return readdirSync(dir).filter(n => join(dir, n) !== instFn).map(n => {
      try { const s = statSync(join(dir, n)); return { name: n, size: s.size, mtime: s.mtimeMs }; }
      catch { return { name: n, error: 'stat_failed' }; }
    });
  } catch { return []; }
}

// Single source of truth for the dump shape. Called from the interval writer
// and from finalDump at close.
function buildDumpPayload(ws: any, opts: { closing?: boolean } = {}): any {
  return {
    label: ws.label ?? null,
    started_at: ws._instStartedAt ?? null,
    closed_at: opts.closing ? new Date().toISOString() : null,
    host: ws._instHost ?? null,
    persona: ws.personaConfig ?? null,
    proxy: ws.proxyConfig ?? null,
    versions: ws._versions ?? null,
    accesses: ws._instAccum ? [...ws._instAccum.values()] : [],
    requests: ws._instRequests ?? [],
    console: ws._instConsole ?? [],
    pageerrors: ws._instPageErrors ?? [],
    service_workers: ws._instSwEvents ?? [],
    cdp_targets: ws._instTargetEvents ?? [],
    cdp_frames: ws._instFrameEvents ?? [],
    cdp_metrics: ws._instMetricsHistory ?? [],
    storage_history: ws._instStorageHistory ?? [],
    sibling_files: ws._instDir && ws._instFile ? buildSiblingManifest(ws._instDir, ws._instFile) : [],
  };
}
