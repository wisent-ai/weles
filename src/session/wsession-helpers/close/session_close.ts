/**
 * Closing a WSession: record what the run spent on its proxy, write the run's
 * network, instrumentation, fingerprint, video and captcha records, and close
 * the page and the browser context.
 */

import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captchaSnapshot } from '../../../captcha/events.js';
import { providerFromHost } from '../../../proxy/policy.js';
import { costTracker } from '../../../utils/runtime/cost.js';
import type { WSession } from '../../wsession.js';
import { finalDump } from '../net_record.js';
import { harPath, scrubHar } from '../har_scrub.js';
import { recordingsDir, wsCaptureFingerprint } from './fingerprint_capture.js';
import { loadSpecialAddresses } from '../../../proxy/quality/special-addresses.js';

/** The proxy type whose bytes are priced as mobile traffic. */
const MOBILE_PROXY_TYPE = 'mobile';

/** Indentation of the written captcha event log. */
const CAPTCHA_LOG_INDENT = '  ';

type SessionProxy = {
  server?: string;
  username?: string;
  provider?: string;
  proxy_type?: string;
};

/**
 * Prices the bytes the run sent through its proxy against the provider
 * resolveProxy recorded on the proxy, or the one `providerFromHost` derives
 * from its endpoint. A proxy neither names is reported, not priced under an
 * invented provider.
 */
function recordProxyBytes(s: WSession, proxyBytes: number): void {
  const proxy = s.proxyConfig as SessionProxy | undefined;
  if (!proxy?.server) {
    console.log(
      `[wsession] proxy bytes not recorded: ${proxyBytes} bytes were counted but the session has no proxy server`,
    );
    return;
  }
  const host = new URL(proxy.server).hostname.toLowerCase();
  const provider = proxy.provider ?? providerFromHost(host, proxy.username);
  if (provider === undefined) {
    console.log(
      `[wsession] proxy bytes not recorded: proxy ${host} names no provider and none is known for its endpoint`,
    );
    return;
  }
  costTracker.recordProxyBytes(
    provider,
    proxyBytes,
    proxy.proxy_type === MOBILE_PROXY_TYPE,
  );
}

function describeProxyBytes(
  proxyBytes: number | null,
  counterError: string | null,
): string {
  if (counterError) return `proxy_bytes not counted: ${counterError}`;
  if (proxyBytes === null) return 'proxy_bytes not counted';
  return `proxy_bytes=${proxyBytes}`;
}

/** The video file of the session: its time, in the session's recordings directory. */
function videoPath(s: WSession): string {
  const time = new Date().toISOString().replace(/[:.]/g, '-');
  return join(recordingsDir(s.label), `${time}.webm`);
}

export async function wsClose(s: WSession): Promise<void> {
  const counterError: string | null = (s as any)._cdpAttachError;
  const proxyBytes: number | null = counterError
    ? null
    : (s as any)._proxyBytes;
  console.log(
    `[wsession] close() label=${s.label} ${describeProxyBytes(proxyBytes, counterError)}`,
  );
  if (proxyBytes) {
    try {
      recordProxyBytes(s, proxyBytes);
    } catch (e: any) {
      console.log(`[wsession] proxy-bytes record err: ${e.message}`);
    }
  }
  await (s as any)._cap
    .save('session', s.page)
    .catch((e: any) =>
      console.log(`[wsession] session capture err: ${e.message}`),
    );
  try {
    writeFileSync(
      join(recordingsDir(s.label), 'network.ndjson'),
      s.capturedResponses.map((r) => JSON.stringify(r)).join('\n'),
    );
  } catch (error) {
    console.log(
      `[wsession] network.ndjson write err: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Final merged dump — fires the close-time flush of every frame's
  // property-trap log + writes the same {accesses, requests, console,
  // pageerrors, persona, proxy, versions} shape the interval writer uses,
  // overwriting the in-flight file with the freshest state. Output lives at
  // <session recordings>/<iso>.inst.json so uploadArtifacts picks it up.
  try {
    await finalDump(s);
  } catch (error) {
    console.log(
      `[wsession] finalDump err: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await (s as any)._cdp?.detach?.();
  } catch (error) {
    console.error(
      `[wsession] CDP detach err: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // G18: capture a fingerprint + detection-vector report at close so failed
  // runs carry an automatic diagnosis of why they may have been flagged. The
  // WebRTC routing rules judge addresses by IANA's registries; when they
  // cannot be read, those rules report that they could not judge, with this cause.
  await loadSpecialAddresses().catch((error: unknown) =>
    console.error(
      `[wsession] IANA special-purpose registries unread, WebRTC routing is not judged: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  await wsCaptureFingerprint(s);
  const video = s.page.video?.();
  const dest = videoPath(s);
  console.log(`[wsession] close() video=${!!video} dest=${dest}`);
  await s.page
    .close()
    .catch((e: any) =>
      console.log(`[wsession] page.close error: ${e.message}`),
    );
  if (video) {
    await video.saveAs(dest).catch((e: any) => {
      console.log(`[wsession] video.saveAs error: ${e.message}`);
      try {
        const src = video.path?.() as string | undefined;
        if (src) {
          copyFileSync(src, dest);
          console.log(`[wsession] video copied from ${src}`);
        } else {
          console.log(
            `[wsession] no local video file to copy to ${dest}, the run has no recording`,
          );
        }
      } catch (copyError: any) {
        console.log(
          `[wsession] video copy to ${dest} failed too, the run has no recording: ${copyError.message}`,
        );
      }
    });
  }
  await s.ctx
    .close()
    .catch((error: unknown) =>
      console.log(
        `[wsession] ctx.close error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  // Playwright has sealed the HAR the context recorded; its request bodies,
  // which can carry a typed password, are taken out before it is published.
  if (process.env.WELES_LABEL) scrubHar(harPath(process.env.WELES_LABEL));
  // G8: persist the per-run captcha event log (challenge_faced + the full
  // attempt/marker sequence) for storage backup + worker import. Always written
  // so a no-captcha run is recorded as {challenge_faced:false, events:[]},
  // distinguishable from a missing file.
  if (s.label) {
    try {
      writeFileSync(
        join(recordingsDir(s.label), 'captcha_events.json'),
        JSON.stringify(captchaSnapshot(), null, CAPTCHA_LOG_INDENT),
      );
    } catch (error) {
      console.log(
        `[wsession] captcha_events write err: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // The run's cost records go to the Stado job's rollup now, not only at exit,
  // so a close that is followed by more work in the same process keeps them.
  try {
    costTracker.flushLocalSync();
  } catch (error) {
    console.log(
      `[wsession] cost rollup not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(`[wsession] close() done`);
}
