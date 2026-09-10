/**
 * Async Playwright API — 1:1 port of weles/async_api.py
 *
 * Launches Playwright with custom Chromium binary + fingerprint spoofing.
 */

import { existsSync } from 'node:fs';
import type { BrowserContext, LaunchOptions } from 'playwright';
import { generate, toConfig } from './fingerprint.js';
import { hostHardware, honestHostEnabled } from './runtime/host_hardware.js';
import { pruneRecordings } from './runtime/prune.js';
import { runRecordingsDir } from './session/run-recordings.js';
import { findCustomBrowser } from './session/find_browser.js';
import type { Persona } from './browser/persona.js';
import { CHROMIUM_ARGS } from './browser/launch/support.js';
import { launchChromiumContext } from './browser/launch/chromium.js';
import { launchFirefoxContext } from './browser/launch/firefox.js';
import type { PreparedContextOptions, RuntimeFingerprintConfig } from './browser/launch/support.js';


export interface AsyncNewBrowserOptions {
  os?: string;
  browser?: string;
  proxy?: { server: string; username?: string; password?: string; country?: string; exit_ip?: string; platform?: string };
  locale?: string;
  headless?: boolean;
  recordVideo?: boolean;
  excludeScripts?: string[];
  chromiumPath?: string;
  userDataDir?: string;
  persona?: Persona;
  pageDiagnostics?: boolean;
  userAgent?: string;
}


export async function AsyncNewBrowser(options: AsyncNewBrowserOptions = {}): Promise<BrowserContext> {
  const persona = options.persona;
  const targetOs = persona?.os ?? options.os ?? 'macos';
  const browserType = persona?.browser ?? options.browser ?? 'chromium';
  const isChromium = browserType === 'chromium';
  const headless = options.headless ?? false;
  const pageDiagnostics = options.pageDiagnostics !== false;
  // Network/HAR capture is CDP-level (Network domain, already enabled for routing)
  // and NOT visible to page JS — so it is decoupled from pageDiagnostics. A clean
  // anti-detect run keeps pageDiagnostics=false (no page-visible traps) yet still
  // records the HAR that challenge_outcome decoding needs. WELES_NO_RESPONSE_BODIES=1
  // opts out of the heavy body capture entirely.
  const captureHar = process.env.WELES_NO_RESPONSE_BODIES !== '1';

  const fp = generate({ os: targetOs, browser: browserType });
  const fpConfig: RuntimeFingerprintConfig = toConfig(fp, targetOs, browserType);
  // Allow callers to pin the HTTP + JS userAgent (e.g. to match a captcha
  // solver's UA so a returned clearance cookie stays valid).
  if (options.userAgent) {
    (fpConfig.navigator ?? (fpConfig.navigator = {})).userAgent = options.userAgent;
  }

  // Persona overrides: apply coherent per-session fingerprint values.
  if (persona) {
    const n = fpConfig.navigator ?? {};
    n.platform = persona.platform;
    n.hardwareConcurrency = persona.hardwareConcurrency;
    if (persona.deviceMemory) n.deviceMemory = persona.deviceMemory;
    n.language = persona.language;
    // navigator.languages must be [primary, secondary] when primary has a region tag — real Firefox/Chrome always emit the bare-lang as the second entry (Mozilla intl.accept_languages, Chrome --lang both expand it). Bare single-entry array is engine-impossible and an obvious bot tell.
    n.languages = persona.language.includes('-') ? [persona.language, persona.language.split('-')[0]] : [persona.language];
    fpConfig.screen = { ...(fpConfig.screen ?? {}), width: persona.screen.width, height: persona.screen.height, availWidth: persona.screen.width, availHeight: persona.screen.height - 40, colorDepth: 24, pixelDepth: 24 };
    fpConfig.window = { ...(fpConfig.window ?? {}), devicePixelRatio: persona.screen.dpr, outerWidth: persona.screen.width + 2, outerHeight: persona.screen.height + 80, screenX: 10, screenY: 10 };
    fpConfig.webgl = { ...(fpConfig.webgl ?? {}), vendor: isChromium ? 'Google Inc.' : 'Mozilla', renderer: isChromium ? persona.gpu.renderer : persona.gpu.renderer.replace(/^ANGLE \([^,]+, ANGLE Metal Renderer: ([^,]+).*\)$/, '$1').replace(/^ANGLE \([^,]+, ([^,]+).*\)$/, '$1'), unmaskedVendor: isChromium ? persona.gpu.vendor : persona.gpu.vendor.replace(/^Google Inc\. \((.+)\)$/, '$1'), unmaskedRenderer: isChromium ? persona.gpu.renderer : persona.gpu.renderer.replace(/^ANGLE \([^,]+, ANGLE Metal Renderer: ([^,]+).*\)$/, '$1').replace(/^ANGLE \([^,]+, ([^,]+).*\)$/, '$1') };
    // Canvas noise NOT applied — LSB-flip makes canvas data URL 4x stock-Chrome size, TikTok mssdk flags.
  }

  // Phase 1 honest-host override (project-weles-anti-detect-goal): when the
  // target OS is the real host's OS, report the machine's ACTUAL physics
  // (GPU/cores/RAM/OS-version) rather than a synthetic or stale persona value.
  // The real silicon leaks through the WebGL pixel-hash + backend regardless of
  // what we claim, so a spoofed value is a detectable contradiction, not a
  // disguise. OS version is reported truthfully too (Phase 1 does not lie about
  // it). WELES_HONEST_HOST=0 opts out (e.g. cross-OS personas for TikTok).
  if (honestHostEnabled()) {
    const hw = hostHardware();
    if (hw.osFamily === targetOs) {
      const n = fpConfig.navigator ?? (fpConfig.navigator = {});
      n.hardwareConcurrency = hw.cores;
      n.deviceMemory = hw.deviceMemory;
      if (hw.glRenderer) {
        fpConfig.webgl = {
          ...(fpConfig.webgl ?? {}),
          renderer: hw.glRenderer,
          unmaskedRenderer: hw.glRenderer,
          ...(hw.glUnmaskedVendor ? { unmaskedVendor: hw.glUnmaskedVendor } : {}),
        };
      }
      // Real display geometry: the synthetic persona's screen size + the forced
      // colorDepth:24 are macOS tells in headed production. Headless parity
      // audits need the opposite: real hardware, but viewport-sized screen.
      const honestScreenValue = String(process.env.WELES_HONEST_SCREEN ?? (headless ? '0' : '1')).trim().toLowerCase();
      const honestScreenEnabled = !['0', 'false', 'off', 'no'].includes(honestScreenValue);
      if (hw.screen && honestScreenEnabled) {
        const sc = hw.screen;
        fpConfig.screen = { ...(fpConfig.screen ?? {}),
          width: sc.width, height: sc.height, availWidth: sc.availWidth, availHeight: sc.availHeight,
          availLeft: 0, availTop: sc.availTop, colorDepth: sc.colorDepth, pixelDepth: sc.colorDepth };
        fpConfig.window = { ...(fpConfig.window ?? {}), devicePixelRatio: sc.dpr };
      } else if (hw.osFamily === 'macos' && fpConfig.screen && honestScreenEnabled) {
        // Fallback: at least correct colorDepth to Retina 30 (matches fingerprint.ts:170).
        fpConfig.screen = { ...fpConfig.screen, colorDepth: 30, pixelDepth: 30 };
      }
      // Carried to the cppConfig build below for the platformVersion override.
      fpConfig._honestHost = hw;
      console.log(`[async_api] honest-host: ${hw.chip ?? '?'} / ${hw.cores}c / ${hw.deviceMemory}GB / macOS ${hw.osVersion ?? '?'}`);
    }
  }

  const nav = fpConfig.navigator ?? {};
  const honestScreenValueForViewport = String(process.env.WELES_HONEST_SCREEN ?? (headless ? '0' : '1')).trim().toLowerCase();
  const honestScreenForViewport = !['0', 'false', 'off', 'no'].includes(honestScreenValueForViewport);
  const _hhScreen = honestScreenForViewport ? fpConfig._honestHost?.screen : null;
  // Window (viewport) must not exceed the real panel — a persona screen taller/
  // wider than the honest screen (e.g. 2560x1600 persona on a 2560x1440 panel)
  // is a window-larger-than-screen tell. Cap to the real avail area.
  let viewW = persona?.screen.width ?? 1920;
  let viewH = persona?.screen.height ?? 1080;
  if (_hhScreen) { viewW = Math.min(viewW, _hhScreen.availWidth); viewH = Math.min(viewH, _hhScreen.availHeight); }
  const viewportOverride = process.env.WELES_VIEWPORT?.match(/^(\d{3,4})x(\d{3,4})$/);
  if (viewportOverride) {
    viewW = Math.min(parseInt(viewportOverride[1], 10), _hhScreen?.availWidth ?? 4096);
    viewH = Math.min(parseInt(viewportOverride[2], 10), _hhScreen?.availHeight ?? 2160);
  }
  // DPR must match the real panel (honest-host) so deviceScaleFactor renders at
  // the true scale — a window claiming DPR 1 while screen reports DPR 2 (or the
  // canvas/pixel-hash renders at the wrong scale) is a tell.
  const dpr = _hhScreen?.dpr ?? persona?.screen.dpr ?? 1;
  if (headless && isChromium) {
    fpConfig.screen = {
      ...(fpConfig.screen ?? {}),
      width: viewW,
      height: viewH,
      availWidth: viewW,
      availHeight: viewH,
      availLeft: 0,
      availTop: 0,
      colorDepth: 24,
      pixelDepth: 24,
    };
    fpConfig.window = {
      ...(fpConfig.window ?? {}),
      devicePixelRatio: dpr,
      outerWidth: viewW,
      outerHeight: viewH,
      innerWidth: viewW,
      innerHeight: viewH,
    };
  }

  // tz/locale NOT in ctxOpts (CDP Emulation -> TikTok mssdk detects). --lang + TZ env. Accept-Language IS set via extraHTTPHeaders (header only) so weles Firefox emits 'en-US,en;q=0.5', Chromium 'en-US,en;q=0.9' (computed in persona.ts).
  const ctxOpts: PreparedContextOptions = {
    userAgent: options.userAgent ?? nav.userAgent,
    viewport: { width: viewW, height: viewH },
    screen: { width: viewW, height: viewH },
    deviceScaleFactor: dpr,
    ...(persona?.acceptLanguage ? { extraHTTPHeaders: { 'accept-language': persona.acceptLanguage } } : {}),
  };
  if (process.env.WELES_BROWSER_EVIDENCE_POLICY === 'spis-browser-evidence.1') {
    ctxOpts.acceptDownloads = false;
    ctxOpts.serviceWorkers = 'block';
  }
  if (options.proxy) {
    ctxOpts.proxy = options.proxy;
    if (isChromium) ctxOpts.ignoreHTTPSErrors = true;
  }

  const recordVideo = options.recordVideo ?? (process.env.WELES_DISABLE_RECORDING !== '1');
  if (recordVideo) {
    const recDir = runRecordingsDir(); // G17: recordings/<run_uuid>/<action>/
    // Frame size 1280x720 by default — at 1920x1080 each Arkose canvas repaint sends ~2MB RGBA over Playwright→webm pipe and saturates the CDP channel.
    const [vw, vh] = (process.env.WELES_VIDEO_SIZE ?? '1280x720').split('x').map(n => parseInt(n, 10));
    ctxOpts.recordVideo = { dir: recDir, size: { width: vw || 1280, height: vh || 720 } };
    try {
      const budget = parseInt(process.env.WELES_RECORDINGS_MAX_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);
      pruneRecordings(recDir, budget);
    } catch { /* skip */ }
  }

  // Launch only the checksum-verified, deployment-selected browser release.
  const selectedChromiumPath = isChromium ? findCustomBrowser('chromium') : undefined;
  if (isChromium && !selectedChromiumPath) {
    throw new Error('WELES_CHROMIUM_BINARY_NOT_FOUND: install the configured immutable Stado release');
  }
  const chromiumPath = selectedChromiumPath ?? '';
  const launchOpts: LaunchOptions = { headless };
  const args = [...CHROMIUM_ARGS];
  if (process.env.WELES_CHROMIUM_PROFILE_DIRECTORY) {
    args.push(`--profile-directory=${process.env.WELES_CHROMIUM_PROFILE_DIRECTORY}`);
  }
  if (process.env.WELES_BROWSER_EVIDENCE_POLICY === 'spis-browser-evidence.1') {
    const targetHost = String(process.env.WELES_BROWSER_EVIDENCE_TARGET_HOST ?? '');
    let targetAddresses: unknown;
    try { targetAddresses = JSON.parse(process.env.WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON ?? 'null'); } catch {}
    if (!/^[A-Za-z0-9.-]+$/.test(targetHost)
        || !Array.isArray(targetAddresses)
        || targetAddresses.length === 0
        || typeof targetAddresses[0] !== 'string'
        || !/^[0-9A-Fa-f:.]+$/.test(targetAddresses[0])) {
      throw new Error('browser-evidence target resolver binding is invalid');
    }
    const pinnedAddress = targetAddresses[0].includes(':') ? `[${targetAddresses[0]}]` : targetAddresses[0];
    args.push(`--host-resolver-rules=MAP ${targetHost} ${pinnedAddress},MAP * ~NOTFOUND`);
    args.push(
      '--disable-background-networking',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--disable-notifications',
      '--disable-sync',
      '--no-pings',
      '--safebrowsing-disable-auto-update',
      '--block-new-web-contents',
      '--disable-external-intent-requests',
      '--disable-features=AutoLaunchProtocolsFromOrigins,EncryptedClientHello,PreconnectOnNavigation,Prerender2,SpeculationRulesPrefetch,ServiceWorkerStaticRouter,BackgroundFetch,PushMessaging,NotificationTriggers,DownloadBubble',
    );
  }

  // Language + timezone as binary-level signals (real Chrome behavior), not CDP emulation.
  if (persona?.language) args.push(`--lang=${persona.language}`);
  if (persona?.timezone) launchOpts.env = { ...process.env, TZ: persona.timezone };

  const nopechaDir = process.env.WELES_NOPECHA_EXT === '1' ? (process.env.WELES_NOPECHA_EXT_DIR ?? '') : '';
  const useNopecha = Boolean(nopechaDir && existsSync(nopechaDir) && headless === false);
  if (useNopecha) {
    throw new Error('NopeCha stock-browser launch is retired; Weles requires the verified Chromium release');
  }

  const isCustomBinary = isChromium;

  if (isCustomBinary) {
    return launchChromiumContext({
      options, fpConfig, ctxOpts, launchOpts, pageDiagnostics, browserType,
      args, chromiumPath, targetOs, captureHar,
    });
  }

  return launchFirefoxContext({ options, fpConfig, ctxOpts, launchOpts, pageDiagnostics, browserType });
}


export class AsyncWeles {
  private _options: AsyncNewBrowserOptions;
  private _context: BrowserContext | null = null;

  constructor(options: AsyncNewBrowserOptions = {}) {
    this._options = options;
  }

  async start(): Promise<BrowserContext> {
    this._context = await AsyncNewBrowser(this._options);
    return this._context;
  }

  async stop(): Promise<void> {
    if (this._context) { await this._context.close(); this._context = null; }
  }
}
