// Complete-record network capture. Attaches to a Playwright BrowserContext
// and pushes one entry per HTTP request, response, request-failure, and
// WebSocket frame into the shared `reqs` array. NO domain filter, NO body
// truncation. Both utf8 and base64 forms of bodies are recorded so binary
// payloads (gzip-encoded, compressed images, protobufs) survive intact.
// Split out of net_record.ts, which wires it and writes the merged dump.

import type { BrowserContext } from 'playwright';

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
