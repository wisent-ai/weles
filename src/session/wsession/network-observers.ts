/**
 * What the wire showed. Everything a fresh WSession subscribes to at
 * construction time lives here:
 *
 *  - the auth interception (/auth/register, /auth/login) that lifts captcha
 *    sitekeys, the submitted form, the x-* headers and platform-side account
 *    blocks off the responses the page itself made;
 *  - the rolling context-wide response ledger behind WSession.capturedResponses
 *    (written to network.ndjson at close);
 *  - the devtools-protocol byte counter that funds the per-trajectory egress
 *    cost computed in close().
 *
 * Extracted verbatim from the WSession constructor to keep the class file
 * under its 300-line cap. observeSessionNetwork is called synchronously from
 * that constructor, so subscription order and the protocol-attach timing
 * (which capture_extras waits on via ws._cdp) are unchanged.
 */

import type { BrowserContext, Page } from 'playwright';
import type { WSession } from '../wsession.js';

interface ObservedRequest {
  url(): string;
  method(): string;
  postData(): string | null;
  headers(): Record<string, string>;
  resourceType?(): string;
}

interface ObservedResponse {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  request(): ObservedRequest | undefined;
  json(): Promise<AuthResponsePayload>;
  text(): Promise<string>;
}

/** The parts of a Discord-shaped auth error body this session reads. */
interface AuthResponsePayload {
  captcha_key?: unknown;
  captcha_sitekey?: string;
  errors?: {
    login?: { _errors?: Array<{ code?: string }> };
    email?: { _errors?: Array<{ code?: string }> };
  };
}

/** Bytes reported for one loaded resource. */
interface DataReceivedPayload {
  encodedDataLength?: number;
  dataLength?: number;
}

/** The two protocol calls this counter needs from an attached session. */
export interface SessionProtocol {
  send(method: string): Promise<unknown>;
  on(event: string, handler: (payload: DataReceivedPayload) => void): void;
}

/** The session members these observers own, private to WSession itself. */
interface ObservedSessionState {
  _secureCredentialTask: boolean;
  _cdp: SessionProtocol | null;
  _proxyBytes: number;
}

function shouldCaptureResponseBody(res: ObservedResponse): boolean {
  try {
    if (process.env.WELES_CAPTURE_RESPONSE_BODIES !== '1') return false;
    const req = res.request?.();
    const resourceType = req?.resourceType?.();
    if (resourceType && ['image', 'media', 'font', 'stylesheet'].includes(resourceType)) return false;
    const headers = res.headers?.() ?? {};
    const contentType = String(headers['content-type'] ?? '').toLowerCase();
    if (contentType && !/json|text|javascript|xml|html|x-www-form-urlencoded/.test(contentType)) return false;
    const len = Number(headers['content-length'] ?? 0);
    return !len || len <= 256 * 1024;
  } catch {
    return false;
  }
}

export function observeSessionNetwork(ws: WSession, ctx: BrowserContext, page: Page): void {
  // The counters and the credential-task flag are private to WSession; this is
  // the same session object, viewed through the members these observers write.
  const state = ws as unknown as ObservedSessionState;
  // Intercept API responses to capture captcha data (Discord register + login)
  const authPaths = ['/auth/register', '/auth/login'];
  page.on?.('request', (req: ObservedRequest) => { try { const u = req.url(); if (authPaths.some(p => u.includes(p)) && req.method() === 'POST') { ws.captchaFormData = JSON.parse(req.postData() ?? '{}'); ws.captchaEndpoint = u; const h = req.headers(); ws.captchaHeaders = {}; for (const k of Object.keys(h)) { if (k.startsWith('x-')) ws.captchaHeaders[k] = h[k]; } } } catch {} });
  page.on?.('response', async (res: ObservedResponse) => { try { const u = res.url(); if (authPaths.some(p => u.includes(p)) && res.status() >= 400) { const d = await res.json(); if (d.captcha_key !== undefined) { ws.captchaResponse = d; console.log(`[wsession] Captured captcha data: sitekey=${d.captcha_sitekey?.slice(0, 12)}`); } const errs = d?.errors?.login?._errors ?? d?.errors?.email?._errors ?? []; const code = errs[0]?.code; if (code === 'ACCOUNT_PERMANENTLY_DISABLED' || code === 'ACCOUNT_DISABLED' || code === 'ACCOUNT_LOGIN_BLOCKED') { ws.authBlocked = code; console.log(`[wsession] Auth blocked by platform: ${code}`); } } } catch {} });
  ctx.on?.('response', (res: ObservedResponse) => {
    try {
      if (ws.capturedResponses.length >= 500) ws.capturedResponses.shift();
      const entry = { ts: Date.now(), method: res.request()?.method?.() ?? 'GET', url: res.url(), status: res.status(), headers: res.headers(), body: '' };
      ws.capturedResponses.push(entry);
      if (state._secureCredentialTask || !shouldCaptureResponseBody(res)) return;
      // A body we could not read is its own answer in the ledger: an empty
      // string there would read as a response that arrived empty.
      void res.text().then(
        (text: string) => { entry.body = text.slice(0, 8192); },
        (error: unknown) => { entry.body = `[body unavailable: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}]`; },
      );
    } catch {}
  });
  attachEgressByteCounter(state, ctx, page);
}

// Network.dataReceived — accumulates bytes flowing through the proxy upstream
// so we can compute per-trajectory egress cost in close(). Attaching is
// asynchronous; capture_extras waits for ws._cdp before it subscribes further.
function attachEgressByteCounter(state: ObservedSessionState, ctx: BrowserContext, page: Page): void {
  void (async () => {
    try {
      if (typeof ctx.newCDPSession !== 'function') return;
      // The attached session is used through two protocol calls only; the
      // library's own generated protocol map is not needed here.
      const attached = await ctx.newCDPSession(page) as unknown as SessionProtocol;
      state._cdp = attached;
      await attached.send('Network.enable');
      attached.on('Network.dataReceived', (e) => {
        // encodedDataLength is on-the-wire bytes (post-compression); older
        // Chromium revisions report dataLength instead.
        const n = Number(e?.encodedDataLength ?? e?.dataLength ?? 0);
        if (n > 0) state._proxyBytes += n;
      });
    } catch (e) { console.log(`[wsession] CDP attach err: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`); }
  })();
}
