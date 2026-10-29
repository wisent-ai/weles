/**
 * What the wire showed. Everything a fresh WSession subscribes to at
 * construction time lives here:
 *
 *  - the auth interception (/auth/register, /auth/login) that lifts captcha
 *    sitekeys, the submitted form, the x-* headers and platform-side account
 *    blocks off the responses the page itself made;
 *  - the context-wide response ledger behind WSession.capturedResponses,
 *    every response of the session (written to network.ndjson at close);
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
}

interface ObservedResponse {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  request(): ObservedRequest;
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

/**
 * Bytes reported for one loaded resource. Both lengths are required fields of
 * Network.dataReceived
 * (https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-dataReceived).
 */
interface DataReceivedPayload {
  encodedDataLength: number;
  dataLength: number;
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

/**
 * Discord's account-state refusals of a sign-in, as its auth API names them:
 * the account itself is disabled or blocked, not the credentials wrong. Only
 * these mark the session's account blocked; any other refusal is the
 * caller's to read from the captured response.
 */
const DISCORD_ACCOUNT_REFUSALS: Record<string, true> = {
  ACCOUNT_PERMANENTLY_DISABLED: true,
  ACCOUNT_DISABLED: true,
  ACCOUNT_LOGIN_BLOCKED: true,
};

/** Discord's own sign-in and registration calls. */
const DISCORD_AUTH_CALL = /\/auth\/(register|login)$/;

export function observeSessionNetwork(
  ws: WSession,
  ctx: BrowserContext,
  page: Page,
): Promise<void> {
  // The counters and the credential-task flag are private to WSession; this is
  // the same session object, viewed through the members these observers write.
  const state = ws as unknown as ObservedSessionState;
  // Discord's sign-in and registration answers carry its captcha challenge
  // and its account-state refusals; a request or answer that cannot be read
  // is said, not dropped.
  page.on?.('request', (req: ObservedRequest) => {
    const u = req.url();
    if (!DISCORD_AUTH_CALL.test(new URL(u).pathname) || req.method() !== 'POST')
      return;
    const sent = req.postData();
    if (sent === null) {
      console.error(
        `[wsession] the sign-in POST to ${u} carries no form, so no captcha fields are kept`,
      );
      return;
    }
    try {
      ws.captchaFormData = JSON.parse(sent);
    } catch (error) {
      console.error(
        `[wsession] the form sent to ${u} is not JSON, so its captcha fields are not kept: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    ws.captchaEndpoint = u;
    const h = req.headers();
    ws.captchaHeaders = {};
    for (const k of Object.keys(h)) {
      if (k.startsWith('x-')) ws.captchaHeaders[k] = h[k];
    }
  });
  page.on?.('response', async (res: ObservedResponse) => {
    const u = res.url();
    if (!DISCORD_AUTH_CALL.test(new URL(u).pathname) || res.status() < 400)
      return;
    let d: AuthResponsePayload;
    try {
      d = await res.json();
    } catch (error) {
      console.error(
        `[wsession] the ${res.status()} answer from ${u} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (d.captcha_key !== undefined) {
      ws.captchaResponse = d;
      console.log(
        `[wsession] Captured captcha data: sitekey=${d.captcha_sitekey}`,
      );
    }
    const errs = d?.errors?.login?._errors ?? d?.errors?.email?._errors;
    const code = Array.isArray(errs) ? errs[0]?.code : undefined;
    if (
      typeof code === 'string' &&
      Object.hasOwn(DISCORD_ACCOUNT_REFUSALS, code)
    ) {
      ws.authBlocked = code;
      console.log(`[wsession] Auth blocked by platform: ${code}`);
    }
  });
  // Every response of the context is kept in the ledger written at close;
  // its body only when WELES_CAPTURE_RESPONSE_BODIES=1 asks for bodies, and
  // never during a credential task.
  const captureBodies = process.env.WELES_CAPTURE_RESPONSE_BODIES === '1';
  ctx.on?.('response', (res: ObservedResponse) => {
    const entry = {
      ts: Date.now(),
      method: res.request().method(),
      url: res.url(),
      status: res.status(),
      headers: res.headers(),
      body: '',
    };
    ws.capturedResponses.push(entry);
    if (state._secureCredentialTask || !captureBodies) return;
    // A body we could not read is its own answer in the ledger: an empty
    // string there would read as a response that arrived empty.
    const read: Promise<void> = res
      .text()
      .then(
        (text: string) => {
          entry.body = text;
        },
        (error: unknown) => {
          entry.body = `[body unavailable: ${error instanceof Error ? error.message : String(error)}]`;
        },
      )
      .finally(() => {
        ws.pendingResponseBodies.delete(read);
      });
    ws.pendingResponseBodies.add(read);
  });
  return attachEgressByteCounter(state, ctx, page);
}

// Network.dataReceived accumulates proxy bytes. Keep an unavailable counter
// distinct from a successful attachment with no observed traffic.
async function attachEgressByteCounter(
  state: ObservedSessionState,
  ctx: BrowserContext,
  page: Page,
): Promise<void> {
  let operation = 'BrowserContext.newCDPSession';
  try {
    if (typeof ctx.newCDPSession !== 'function') {
      throw new Error('the browser context does not expose newCDPSession');
    }
    const attached = (await ctx.newCDPSession(
      page,
    )) as unknown as SessionProtocol;
    state._cdp = attached;
    operation = 'Network.dataReceived subscription';
    attached.on('Network.dataReceived', (e) => {
      // encodedDataLength is the bytes on the wire (after compression), the
      // ones the proxy carried; the protocol always states it.
      state._proxyBytes += e.encodedDataLength;
    });
    operation = 'Network.enable';
    await attached.send('Network.enable');
  } catch (error) {
    state._cdpAttachError = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[wsession] CDP attach err: ${state._cdpAttachError}`);
  }
}
