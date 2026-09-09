/**
 * How the browser comes up, and what a freshly built WSession takes over from
 * it. Two halves, in the order WSession.start runs them:
 *
 *  - openSessionBrowser: service placement, the per-run timing seed, the
 *    operator devtools attach path, persona and proxy resolution, the
 *    pre-launch provenance envelope, the verified browser release,
 *    SSLKEYLOGFILE, the browser-evidence policy and the cookie injection —
 *    everything that must happen before a session object can exist.
 *  - adoptLaunchedBrowser: what the new session then owns — its realized proxy
 *    and persona, browser provenance, the SIGTERM seal, its generated
 *    identity, the exit-IP probe, the realized provenance write and the
 *    network instrumentation.
 *
 * Extracted from WSession.start to keep the class file under its 300-line cap.
 * The private constructor stays in the class, so start() is the only caller:
 * open, construct, adopt — the same sequence, the same order of effects.
 */

import { type BrowserContext, type Page, chromium } from 'playwright';
import { join } from 'node:path';
import { AsyncNewBrowser, type AsyncNewBrowserOptions } from '../../async_api.js';
import { type Persona, generatePersona } from '../../browser/persona.js';
import { Capture } from '../../capture/capture.js';
import { installBrowserEvidencePolicy } from '../../agent/browser-evidence-policy.js';
import { resolveProxy } from '../../proxy/config.js';
import { seedHumanTiming } from '../../utils/timing.js';
import type { WSession } from '../wsession.js';
import { SessionStore } from '../store.js';
import { findCustomBrowser } from '../find_browser.js';
import { loadOperatorCdpConfig, type OperatorCdpConfig } from '../operator-cdp.js';
import { enforceWelesServicePlacement } from '../service-placement.js';
import { runRecordingsDir, runRecordingsRoot } from '../run-recordings.js';
import { isSkarbiecCredentialTask } from '../wsession-helpers/credential-store.js';
import { startInstrumentation } from '../wsession-helpers/net_record.js';
import {
  accountProfileDirectory,
  countryHintFromProxyRequest,
  redactProxyForLog,
  type SessionProxy,
  type WSessionOptions,
} from './session-request.js';
import { hashDiagnosticValue, writePrelaunchSessionMeta, writeRealizedSessionMeta } from './run-provenance.js';

function recordingsDir(label?: string): string { return label ? runRecordingsDir(label) : runRecordingsRoot(); }

// async_api decorates the context it returns with the browser release it used
// and the fingerprint the page actually presents.
interface RealizedContext {
  _welesBrowserProvenance?: unknown;
  _welesFingerprintConfig?: Record<string, unknown>;
}

// Provenance and the credential-task flag ride on the session for close() and
// the instrumentation dump; neither is part of the class's declared surface.
interface AdoptingSession {
  _browserProvenance: unknown;
  _secureCredentialTask: boolean;
}

/** A context adopted from the operator's own browser over the devtools port. */
export interface OperatorSession {
  kind: 'operator-cdp';
  ctx: BrowserContext;
  page: Page;
  capture: Capture;
  label: string;
}

/** A browser this run launched, with everything the session records about it. */
export interface LaunchedSession {
  kind: 'launched';
  ctx: BrowserContext;
  page: Page;
  capture: Capture;
  label: string;
  persona: Persona;
  proxy: SessionProxy | undefined;
  proxyRequest: string | null;
  platform: string | undefined;
  timingSeed: number;
}

export type SessionLaunch = OperatorSession | LaunchedSession;

export async function openSessionBrowser(opts: WSessionOptions): Promise<SessionLaunch> {
  enforceWelesServicePlacement('WSession.start');
  const label = opts.label ?? '';
  const secureCredentialTask = isSkarbiecCredentialTask();
  // G9: one per-run human-timing seed, generated at session start and routed
  // into the shared seeded PRNG so every human mouse/typing jitter draw this
  // run is reproducible from the recorded seed. Code paths that never read the
  // seed keep drawing from Math.random, so this only makes behavior
  // reproducible — it does not change the statistical distribution. Recorded
  // into session_meta as a required non-null number (result.run.timing_seed).
  const timingSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
  seedHumanTiming(timingSeed);
  const operatorCdp = opts.operatorCdp ? loadOperatorCdpConfig() : null;
  console.log(`[wsession] start() label=${label} operatorCdp=${Boolean(operatorCdp)} proxy=${redactProxyForLog(opts.proxy)}`);
  if (label && !secureCredentialTask) process.env.WELES_LABEL = label;
  if (operatorCdp) return await adoptOperatorBrowser(operatorCdp, label);
  const proxyRequested = !!opts.proxy && !['none', 'direct'].includes(String(opts.proxy).toLowerCase());
  // WELES_FORCE_BROWSER pins the persona's browser engine globally (e.g. on a
  // host that only has the patched Chromium installed, not Firefox). Explicit
  // opts.browser still wins; unset rolls naturally (60/40 chromium/firefox).
  const persona: Persona = opts.persona ?? generatePersona({ country: countryHintFromProxyRequest(opts.proxy), os: opts.os as Persona['os'] | undefined, browser: (opts.browser ?? process.env.WELES_FORCE_BROWSER) as Persona['browser'] | undefined });
  const proxy = proxyRequested ? await resolveProxy(opts.proxy!, opts.targetHost, persona) : undefined;
  // Pre-launch envelope; overwritten with the realized data after launch.
  writePrelaunchSessionMeta({ label, persona, proxy, proxyRequested: opts.proxy ?? null, timingSeed });
  if (proxyRequested && !proxy) {
    throw new Error(`proxy_unavailable: requested ${opts.proxy} for ${opts.targetHost ?? 'unknown target'}`);
  }
  // WELES_PAGE_DIAGNOSTICS=0 force-disables in-page instrumentation (property-trap,
  // input-recorder) as a clean-room control for signup A/B tests. (Tested on
  // reddit: toggling it changed nothing — the verify-init gate is exit-IP
  // reputation, not in-page instrumentation. Kept as a knob regardless.)
  const instrumentationDisabled = process.env.WELES_NO_INSTRUMENT === '1'
    || process.env.WELES_BROWSER_EVIDENCE_POLICY === 'spis-browser-evidence.1';
  const pageDiagnostics = secureCredentialTask || instrumentationDisabled || process.env.WELES_PAGE_DIAGNOSTICS === '0'
    ? false
    : (opts.pageDiagnostics ?? (label !== 'linkedin_register'));
  const userDataDir = opts.userDataDir ?? process.env.WELES_USER_DATA_DIR ?? accountProfileDirectory(opts, persona.browser);
  const bOpts: AsyncNewBrowserOptions = { os: persona.os, browser: persona.browser, headless: opts.headless ?? (process.env.WELES_HEADLESS === '1'), recordVideo: secureCredentialTask ? false : (opts.record ?? (process.env.WELES_DISABLE_RECORDING !== '1')), locale: opts.locale, persona, proxy, pageDiagnostics, userAgent: opts.userAgent, userDataDir };
  if (opts.chromiumPath || process.env.CHROMIUM_PATH) {
    throw new Error('Explicit browser path overrides are retired; configure the exact Stado browser release version and SHA-256');
  }
  const cp = findCustomBrowser(bOpts.browser);
  if (!cp) throw new Error(`Verified ${bOpts.browser} release not found`);
  if (secureCredentialTask) {
    delete process.env.SSLKEYLOGFILE;
    delete process.env.WELES_LABEL;
  } else if (label && !instrumentationDisabled) {
    process.env.SSLKEYLOGFILE = join(recordingsDir(label), 'sslkey.log');
    process.env.WELES_LABEL = label;
  } else {
    delete process.env.SSLKEYLOGFILE;
  }
  const ctx = await AsyncNewBrowser(bOpts);
  await installBrowserEvidencePolicy(ctx, label);
  const page = ctx.pages()[0] || await ctx.newPage();
  const capture = captureFor(page, label);
  if (label && !instrumentationDisabled) { const s = new SessionStore(); await s.injectPlaywright(ctx, label); }
  return {
    kind: 'launched',
    ctx, page, capture, label, persona,
    proxy: bOpts.proxy,
    proxyRequest: opts.proxy ?? null,
    platform: opts.platform,
    timingSeed,
  };
}

/** What the new session owns once its browser is up. */
export async function adoptLaunchedBrowser(ws: WSession, launch: LaunchedSession): Promise<void> {
  const realized = launch.ctx as BrowserContext & RealizedContext;
  const session = ws as unknown as AdoptingSession;
  ws.proxyConfig = launch.proxy;
  ws.personaConfig = launch.persona;
  session._browserProvenance = realized._welesBrowserProvenance ?? null;
  // G17g: on a worker SIGTERM (graceful timeout), close the context so
  // Playwright seals the HAR + video before the process is hard-killed.
  process.once('SIGTERM', () => { try { void launch.ctx.close?.(); } catch { /* noop */ } });
  if (launch.platform) { ws.identity = await ws.generateIdentity(launch.platform); console.log(`[wsession] identity generated platform=${launch.platform} username_hash=${hashDiagnosticValue(ws.identity.username)}`); }
  await probeExitIp(launch);
  // async_api always attaches the realized fingerprint to the context it built.
  const realizedFingerprint = realized._welesFingerprintConfig as Record<string, unknown>;
  writeRealizedSessionMeta({
    label: launch.label,
    persona: launch.persona,
    proxy: launch.proxy,
    proxyRequested: launch.proxyRequest,
    timingSeed: launch.timingSeed,
    realizedFingerprint,
    browserProvenance: realized._welesBrowserProvenance ?? null,
    identity: ws.identity,
  });
  // Complete-record network capture: NO domain filter, NO body truncation.
  // Captures every request/response (utf8 + base64), WebSocket frames in both
  // directions, TCP serverAddr, TLS securityDetails. Runs on every WSession —
  // keepers and trajectories — without exception. See net_record.ts.
  if (!session._secureCredentialTask && process.env.WELES_NO_INSTRUMENT !== '1') startInstrumentation(ws, launch.ctx, launch.label);
}

// Capture takes the devtools-shaped context it screenshots through; a session
// hands it the one page it owns. The library's own context type is not
// structurally compatible with a Playwright page host, so the single-page
// host is asserted into it here, once.
function captureFor(page: Page, label: string): Capture {
  const pageHost = { newPage: async () => page } as unknown as ConstructorParameters<typeof Capture>[0];
  return new Capture(pageHost, label ? recordingsDir(label) : undefined);
}

// The operator's browser is already running and already logged in: attach to
// its devtools endpoint, take the context and page it offers, and put the
// browser-evidence policy on before anything navigates.
async function adoptOperatorBrowser(operatorCdp: OperatorCdpConfig, label: string): Promise<OperatorSession> {
  const browser = await chromium.connectOverCDP(operatorCdp.endpoint, {
    headers: { Authorization: `Bearer ${operatorCdp.token}` },
  });
  const ctx = browser.contexts().at(Number(false)) || await browser.newContext({
    locale: 'en-US',
    ...(process.env.WELES_BROWSER_EVIDENCE_POLICY === 'spis-browser-evidence.1'
      ? { acceptDownloads: false, serviceWorkers: 'block' as const }
      : {}),
  });
  await installBrowserEvidencePolicy(ctx, label);
  const page = ctx.pages().at(Number(false)) || await ctx.newPage();
  return { kind: 'operator-cdp', ctx, page, capture: captureFor(page, label), label };
}

// Which exit the proxy actually gave us. Recorded on the proxy object itself,
// so provenance and cost accounting read the same value.
async function probeExitIp(launch: LaunchedSession): Promise<void> {
  const proxy = launch.proxy;
  if (!proxy?.server) return;
  try {
    const r = await launch.ctx.request.get('https://api.ipify.org', { timeout: 10_000 });
    if (r.ok()) { const t = (await r.text()).trim(); if (/^[0-9a-fA-F.:]+$/.test(t)) proxy.exit_ip = t; }
  } catch {}
}
