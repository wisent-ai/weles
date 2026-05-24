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

export function startInstrumentation(ws: any, ctx: BrowserContext, label: string | undefined): any[] {
  const dir = join(process.cwd(), '.work', 'inst');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fn = join(dir, `${label || 'session'}_${ts}.json`);
  const accum = new Map();
  const reqs: any[] = [];
  ws._instRequests = reqs;
  attachCompleteNetRecord(ctx, reqs);
  setInterval(async () => {
    try {
      for (const f of ws.page.frames()) {
        try {
          const j: string = await f.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"');  // allow-raw-playwright: instrumentation flush
          const log = JSON.parse(j);
          if (!log.length) continue;
          const url = f.url();
          const prev = accum.get(url);
          if (!prev || log.length > prev.log.length) accum.set(url, { url, log });
        } catch {}
      }
      writeFileSync(fn, JSON.stringify({ accesses: [...accum.values()], requests: reqs }));
    } catch {}
  }, 5000);
  return reqs;
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
