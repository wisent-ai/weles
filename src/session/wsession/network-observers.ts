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
 * The constructor subscribes to page and context events synchronously. Its
 * returned promise records completion of the protocol counter setup; session
 * startup and diagnostic attachment observe that result, not scheduler turns.
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
  _cdpAttachError: string | null;
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

export function observeSessionNetwork(ws: WSession, ctx: BrowserContext, page: Page): Promise<void> {
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
      const read: Promise<void> = res.text().then(
        (text: string) => { entry.body = text.slice(0, 8192); },
        (error: unknown) => { entry.body = `[body unavailable: ${(error instanceof Error ? error.message : String(error))}]`; },
      ).finally(() => { ws.pendingResponseBodies.delete(read); });
      ws.pendingResponseBodies.add(read);
    } catch {}
  });
  return attachEgressByteCounter(state, ctx, page);
}

// Network.dataReceived accumulates proxy bytes. Keep an unavailable counter
// distinct from a successful attachment with no observed traffic.
async function attachEgressByteCounter(state: ObservedSessionState, ctx: BrowserContext, page: Page): Promise<void> {
  let operation = 'BrowserContext.newCDPSession';
  try {
    if (typeof ctx.newCDPSession !== 'function') {
      throw new Error('the browser context does not expose newCDPSession');
    }
    const attached = await ctx.newCDPSession(page) as unknown as SessionProtocol;
    state._cdp = attached;
    operation = 'Network.dataReceived subscription';
    attached.on('Network.dataReceived', (e) => {
      // encodedDataLength is on-the-wire bytes (post-compression); older
      // Chromium revisions report dataLength instead.
      const n = Number(e?.encodedDataLength ?? e?.dataLength ?? 0);
      if (n > 0) state._proxyBytes += n;
    });
    operation = 'Network.enable';
    await attached.send('Network.enable');
  } catch (error) {
    state._cdpAttachError = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[wsession] CDP attach err: ${state._cdpAttachError}`);
  }
}
