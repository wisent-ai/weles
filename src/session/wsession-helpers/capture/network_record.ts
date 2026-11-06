// Complete-record network capture. Attaches to a Playwright BrowserContext
// and pushes one entry per HTTP request, response, request-failure, and
// WebSocket frame into the shared `reqs` array. NO domain filter, NO body
// truncation. Both utf8 and base64 forms of bodies are recorded so binary
// payloads (gzip-encoded, compressed images, protobufs) survive intact.
// Split out of net_record.ts, which wires it and writes the merged dump.
//
// A request body may carry what a person typed into a masked field. The page
// itself says which fields those are (input type=password), so the body is
// kept only after the values of its frame's masked fields are removed from
// it, in every spelling a body can carry them; until that read lands, or when
// it cannot be made, the body is withheld and says why.

import type { BrowserContext, Frame, Request } from 'playwright';

const MASKED = '<redacted-masked-field>';
const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]+/g;
const WITHHELD =
  '[request body withheld until the masked fields of its page were read]';

/** The non-empty values of the frame's masked inputs, as the page holds them. */
function maskedValues(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(
      document.querySelectorAll('input[type="password"]'),
      (input) => (input as HTMLInputElement).value,
    ).filter((value) => value !== ''),
  );
}

/** Every spelling a typed value takes in a body: as typed, URL-encoded, form-encoded and JSON-escaped. */
function spellings(value: string): string[] {
  return [
    value,
    encodeURIComponent(value),
    new URLSearchParams([['', value]]).toString().replace(/^=/, ''),
    JSON.stringify(value).replace(/^"|"$/g, ''),
  ];
}

function redactBody(
  body: string,
  masked: string[],
): { body: string; redacted: boolean } {
  let kept = body;
  for (const value of masked) {
    for (const spelling of new Set(spellings(value))) {
      kept = kept.split(spelling).join(MASKED);
    }
  }
  kept = kept.replace(EMAIL, '<redacted-email>');
  return { body: kept, redacted: kept !== body };
}

/**
 * The frame that sent a request; null for a service worker's request, which
 * no frame sent. A navigation issued before its frame exists has no frame to
 * read masked fields from: that is answered as the sentence saying so, and
 * the body stays withheld rather than kept unredacted.
 */
function sendingFrame(req: Request): Frame | null | string {
  if (req.serviceWorker()) return null;
  try {
    return req.frame();
  } catch (error) {
    return frameUnavailable(error);
  }
}

function frameUnavailable(error: unknown): string {
  return `[request body withheld: the frame that sent it could not be read, so a typed password could not be removed: ${error instanceof Error ? error.message : String(error)}]`;
}

export function attachCompleteNetRecord(
  ctx: BrowserContext,
  reqs: any[],
): void {
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
      // A body that could not be read is not an empty body: the entry says so.
      let postDataError: string | undefined;
      try {
        const sent = req.postData();
        if (sent !== null) post = sent;
      } catch (readError) {
        postDataError = `postData: ${readError instanceof Error ? readError.message : String(readError)}`;
      }
      let postBytes = '';
      try {
        const b = (req as any).postDataBuffer?.();
        if (b) postBytes = Buffer.from(b).toString('base64');
      } catch (readError) {
        postDataError = `postDataBuffer: ${readError instanceof Error ? readError.message : String(readError)}`;
      }
      const entry: Record<string, unknown> = {
        t: Date.now(),
        phase: 'req',
        method: req.method(),
        url: req.url(),
        resourceType: (req as any).resourceType?.(),
        headers: req.headers(),
        postData: post === '' ? post : WITHHELD,
        postDataRedacted: false,
        postDataBase64: '',
        postDataError,
      };
      reqs.push(entry);
      if (post === '') return;
      // The frame that sent the request holds the masked fields its body
      // could carry; a request no frame sent (a service worker's) has none.
      const frame = sendingFrame(req);
      if (typeof frame === 'string') {
        entry.postData = frame;
        return;
      }
      const masked: Promise<string[]> =
        frame === null ? Promise.resolve([]) : maskedValues(frame);
      masked.then(
        (values) => {
          const kept = redactBody(post, values);
          entry.postData = kept.body;
          entry.postDataRedacted = kept.redacted;
          // Raw bytes are kept only when nothing had to be removed from them.
          if (!kept.redacted) entry.postDataBase64 = postBytes;
        },
        (error: unknown) => {
          entry.postData = `[request body withheld: the masked fields of its page could not be read, so a typed password could not be removed: ${error instanceof Error ? error.message : String(error)}]`;
        },
      );
    } catch (captureError) {
      // A request that could not be described still happened: keep its trace.
      reqs.push({
        t: Date.now(),
        phase: 'req_capture_failed',
        error:
          captureError instanceof Error
            ? captureError.message
            : String(captureError),
      });
    }
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
    try {
      entry.statusText = (resp as any).statusText?.();
    } catch (e: any) {
      entry.statusText_err = String(e?.message ?? e);
    }
    try {
      entry.timing = (resp.request?.() as any).timing?.();
    } catch (e: any) {
      entry.timing_err = String(e?.message ?? e);
    }
    reqs.push(entry);
    if (!captureBodies) return;
    // Fire-and-forget body fetch; mutates entry in place when it lands.
    resp.body().then(
      (buf) => {
        entry.bodyBase64 = Buffer.from(buf).toString('base64');
        try {
          entry.body = buf.toString('utf8');
        } catch (e: any) {
          entry.body_decode_err = String(e?.message ?? e);
        }
      },
      (err) => {
        entry.bodyError = String(err?.message ?? err);
      },
    );
    const sa = (resp as any).serverAddr?.();
    if (sa && typeof sa.then === 'function')
      sa.then(
        (s: any) => {
          entry.serverAddr = s;
        },
        (err: any) => {
          entry.serverAddrError = String(err?.message ?? err);
        },
      );
    const sd = (resp as any).securityDetails?.();
    if (sd && typeof sd.then === 'function')
      sd.then(
        (s: any) => {
          entry.securityDetails = s;
        },
        (err: any) => {
          entry.securityDetailsError = String(err?.message ?? err);
        },
      );
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
    } catch (captureError) {
      reqs.push({
        t: Date.now(),
        phase: 'reqfailed_capture_failed',
        error:
          captureError instanceof Error
            ? captureError.message
            : String(captureError),
      });
    }
  });
  // WebSocket capture: every frame in both directions. A frame's payload is
  // kept as text, or base64 when it is binary; pushing a record cannot fail.
  const framePayload = (payload: unknown): string => {
    if (Buffer.isBuffer(payload)) return payload.toString('base64');
    if (typeof payload === 'string') return payload;
    return `[frame payload of type ${typeof payload}]`;
  };
  (ctx as any).on?.('websocket', (sock: any) => {
    const u = sock.url();
    reqs.push({ t: Date.now(), phase: 'ws-open', url: u });
    sock.on('framesent', (f: { payload: unknown }) => {
      reqs.push({
        t: Date.now(),
        phase: 'ws-tx',
        url: u,
        payload: framePayload(f.payload),
      });
    });
    sock.on('framereceived', (f: { payload: unknown }) => {
      reqs.push({
        t: Date.now(),
        phase: 'ws-rx',
        url: u,
        payload: framePayload(f.payload),
      });
    });
    sock.on('close', () => {
      reqs.push({ t: Date.now(), phase: 'ws-close', url: u });
    });
    sock.on('socketerror', (e: unknown) => {
      reqs.push({ t: Date.now(), phase: 'ws-error', url: u, error: String(e) });
    });
  });
}
