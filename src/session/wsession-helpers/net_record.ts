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
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform as osPlatform, release as osRelease, arch as osArch, totalmem, cpus, hostname, version as osVersion } from 'node:os';
import { attachServiceWorkers, attachCdpLifecycle, pollStorageState, buildSiblingManifest, attachStdoutCapture, sliceStdout, captureHostSnapshots, captureFinalCdpSnapshots, attachPagePlaywrightEvents } from './capture_extras.js';
import { startPcap, attachWorkerInventory } from './pcap_sidecar.js';
import { runRecordingsDir } from '../run-recordings.js';
import { buildCaptureCoverage } from './capture_coverage.js';

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v !== 'string') return v;
    // Captured page/network payloads can contain lone UTF-16 surrogates.
    // JSON.stringify will emit them as \uXXXX, but downstream parsers can
    // still choke when paired incorrectly. Normalize them at the artifact edge.
    return v.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  });
}

function redactRequestBody(url: string, body: string): { body: string; redacted: boolean } {
  if (!body) return { body, redacted: false };
  const sensitiveUrl = /linkedin\.com\/signup\/api|linkedin\.com\/checkpoint|\/auth\/|\/login|\/register/i.test(url);
  const sensitiveBody = /password|passwd|pwd|email|mail|phone|csrf|token|secret/i.test(body);
  if (!sensitiveUrl && !sensitiveBody) return { body, redacted: false };
  const sensitiveKeys = /^(password|passwd|pwd|passcode|secret|token|csrf|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|session_key|session_password)$/i;
  try {
    const parsed = JSON.parse(body);
    const scrub = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          sensitiveKeys.test(k) ? (String(k).toLowerCase().includes('email') ? '<redacted-email>' : '<redacted>') : scrub(v),
        ]));
      }
      return value;
    };
    return { body: JSON.stringify(scrub(parsed)), redacted: true };
  } catch {}
  let redacted = body
    .replace(/(["']?(?:password|passwd|pwd|passcode|secret|token|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|session_key|session_password)["']?\s*[:=]\s*)["']?([^&;,\s"'}]+)["']?/gi, '$1"<redacted>"')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>');
  if (redacted === body && (sensitiveUrl || sensitiveBody)) redacted = '<redacted-sensitive-body>';
  return { body: redacted, redacted: redacted !== body };
}

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
  const fullDiagnostics = process.env.WELES_FULL_DIAGNOSTICS === '1';
  const cdpDiagnostics = fullDiagnostics || process.env.WELES_CDP_DIAGNOSTICS === '1';
  const storageDiagnostics = fullDiagnostics || process.env.WELES_STORAGE_DIAGNOSTICS === '1';
  const pcapDiagnostics = fullDiagnostics || process.env.WELES_PCAP_DIAGNOSTICS === '1';
  const workerDiagnostics = fullDiagnostics || process.env.WELES_WORKER_DIAGNOSTICS === '1';
  const hostDiagnostics = fullDiagnostics || process.env.WELES_HOST_DIAGNOSTICS === '1';
  const dir = runRecordingsDir(label || 'session'); // G17: recordings/<run_uuid>/<label>/
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
  ws._instStdout = [];
  attachStdoutCapture(ws);
  attachCompleteNetRecord(ctx, reqs);
  attachPageDiagnostics(ws, consoleMsgs, pageErrors);
  attachServiceWorkers(ctx, swEvents);
  if (cdpDiagnostics) {
    attachCdpLifecycle(ws, ctx, targetEvents, frameEvents, metricsHistory);
  }
  if (storageDiagnostics) {
    pollStorageState(ws, ctx, storageHistory);
  }
  if (pcapDiagnostics) {
    startPcap(ws, label);
  }
  if (workerDiagnostics) {
    attachWorkerInventory(ws);
  }
  if (hostDiagnostics) {
    captureHostSnapshots(ws);
  }
  attachPagePlaywrightEvents(ws);
  const flushTimer = setInterval(async () => {
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
      writeFileSync(fn, safeJsonStringify(buildDumpPayload(ws)));
    } catch {}
  }, 5000);
  ws._instFlushTimer = flushTimer;
  flushTimer.unref?.();
  return reqs;
}

// Called at WSession close: one last flush of the property-trap log across all
// frames + write the final merged dump. Overwrites the file the interval writer
// has been refreshing every 5 seconds with the most-recent state, so the
// uploaded artifact contains everything up to the moment of close.
export async function finalDump(ws: any): Promise<void> {
  if (!ws?._instFile) return;
  // End CDP Tracing + coverage tracking first so per-domain takeXxx results
  // are populated before serialization. Failures noted, not silenced.
  if (ws._cdp) {
    try { await ws._cdp.send('Tracing.end'); } catch (e: any) { ws._instTracingEndError = String(e?.message ?? e); }
    try { ws._instJsCoverageData = await ws._cdp.send('Profiler.takePreciseCoverage'); await ws._cdp.send('Profiler.stopPreciseCoverage'); } catch (e: any) { ws._instJsCoverageEndError = String(e?.message ?? e); }
    try { ws._instCssCoverageData = await ws._cdp.send('CSS.takeCoverageDelta'); await ws._cdp.send('CSS.stopRuleUsageTracking'); } catch (e: any) { ws._instCssCoverageEndError = String(e?.message ?? e); }
  }
  // One-shot DOMSnapshot + HeapProfiler at close — captured before pcap/page
  // teardown so the snapshots reflect the actual final state of the session.
  try { await captureFinalCdpSnapshots(ws); } catch {}
  try { const { stopPcap } = await import('./pcap_sidecar.js'); await stopPcap(ws); } catch {}
  try {
    if (ws._instFlushTimer) {
      clearInterval(ws._instFlushTimer);
      ws._instFlushTimer = null;
    }
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
    writeFileSync(ws._instFile, safeJsonStringify(buildDumpPayload(ws, { closing: true })));
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
  // Response bodies are captured ALWAYS — never optional. The old flag gate
  // (WELES_CAPTURE_RESPONSE_BODIES / WELES_FULL_DIAGNOSTICS) silently produced
  // body-less captures for any caller that didn't set it (the keeper didn't),
  // so the SQL-queryable copy lost every response payload — the createAccount
  // challengeUrl, the captcha verdicts, LinkedIn error bodies. The body fetch
  // below is fire-and-forget (never awaited inline), so it can't starve the
  // event loop the way the original inline-await version did. Escape hatch:
  // WELES_NO_RESPONSE_BODIES=1, for the rare case bodies genuinely can't be held.
  const captureBodies = process.env.WELES_NO_RESPONSE_BODIES !== '1';
  ctx.on('request', (req) => {
    try {
      let post = '';
      try { post = req.postData() ?? ''; } catch {}
      const redactedPost = redactRequestBody(req.url(), post);
      let postBytes = '';
      try { const b = (req as any).postDataBuffer?.(); if (b && !redactedPost.redacted) postBytes = Buffer.from(b).toString('base64'); } catch {}
      reqs.push({
        t: Date.now(),
        phase: 'req',
        method: req.method(),
        url: req.url(),
        resourceType: (req as any).resourceType?.(),
        headers: req.headers(),
        postData: redactedPost.body,
        postDataRedacted: redactedPost.redacted,
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
    if (!captureBodies) return;
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

// Single source of truth for the dump shape. Called from the interval writer
// and from finalDump at close. Sources every channel that's been wired into
// the merged inst dump; reads its inputs off ws._instXxx fields populated by
// startInstrumentation + capture_extras helpers.
function hashDiagnosticValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sanitizeProxyConfig(proxy: any): any {
  if (!proxy) return null;
  return {
    server: proxy.server,
    username_present: !!proxy.username,
    username_hash: hashDiagnosticValue(proxy.username),
    password_present: !!proxy.password,
    country: proxy.country,
    exit_ip: proxy.exit_ip,
    platform: proxy.platform,
    provider: proxy.provider,
    proxy_type: proxy.proxy_type,
  };
}

function buildDumpPayload(ws: any, opts: { closing?: boolean } = {}): any {
  return {
    label: ws.label ?? null,
    started_at: ws._instStartedAt ?? null,
    closed_at: opts.closing ? new Date().toISOString() : null,
    host: ws._instHost ?? null,
    browser_provenance: ws._browserProvenance ?? null,
    persona: ws.personaConfig ?? null,
    proxy: sanitizeProxyConfig(ws.proxyConfig),
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
    cdp_network: ws._instCdpNetwork ?? [],
    system_info: ws._instSystemInfo ?? null,
    process_info: ws._instProcessInfo ?? null,
    process_history: ws._instProcessHistory ?? [],
    browser_version: ws._instBrowserVersion ?? null,
    histograms: ws._instHistograms ?? null,
    navigation_history: ws._instNavigationHistory ?? null,
    cdp_tracing: ws._instTracing ?? [],
    cdp_tracing_error: ws._instTracingError ?? null,
    js_coverage: ws._instJsCoverageData ?? null,
    js_coverage_error: ws._instJsCoverageError ?? null,
    css_coverage: ws._instCssCoverageData ?? null,
    css_coverage_error: ws._instCssCoverageError ?? null,
    webaudio: ws._instWebAudio ?? [],
    webaudio_error: ws._instWebAudioError ?? null,
    animations: ws._instAnimations ?? [],
    animations_error: ws._instAnimationsError ?? null,
    indexed_db: ws._instIndexedDb ?? [],
    indexed_db_error: ws._instIndexedDbError ?? null,
    dom_counters: ws._instDomCounters ?? [],
    dom_snapshot: ws._instDomSnapshot ?? null,
    dom_snapshot_error: ws._instDomSnapshotError ?? null,
    dom_pierced_tree: ws._instDomPiercedTree ?? null,
    dom_pierced_tree_error: ws._instDomPiercedTreeError ?? null,
    heap_snapshot: ws._instHeapSnapshot ?? null,
    heap_snapshot_error: ws._instHeapSnapshotError ?? null,
    page_events: ws._instPageEvents ?? [],
    runtime: ws._instRuntime ?? [],
    log_entries: ws._instLog ?? [],
    security: ws._instSecurity ?? [],
    storage_events: ws._instStorageEvents ?? [],
    playwright_events: ws._instPlaywrightEvents ?? [],
    cdp_firehose: ws._instCdpFirehose ?? [],
    cdp_firehose_mode: ws._instCdpFirehoseMode ?? null,
    cdp_firehose_overflow: ws._instCdpFirehoseOverflow ?? 0,
    worker_surfaces: ws._instWorkerSurfaces ?? [],
    worker_surfaces_error: ws._instWorkerSurfacesError ?? null,
    worker_events: ws._instWorkerEvents ?? [],
    host_snapshots: ws._instHostSnapshots ?? null,
    pcap: ws._instPcap ?? null,
    capture_coverage: buildCaptureCoverage(ws),
    stdout: sliceStdout(ws),
    sibling_files: ws._instDir && ws._instFile ? buildSiblingManifest(ws._instDir, ws._instFile) : [],
  };
}
