/**
 * Async Playwright API — 1:1 port of weles/async_api.py
 *
 * Launches Playwright with custom Chromium binary + fingerprint spoofing.
 */

import { existsSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type BrowserContext, type Browser } from 'playwright';
import { generate, toConfig, toCppConfig } from './fingerprint.js';
import { buildInitScript } from './scripts/loader.js';
import { pruneRecordings } from './prune.js';
import { launchWelesFirefox, firefoxIdentityFor } from './browser/firefox_launch.js';
import {
  WEBAUTHN_REJECT_SCRIPT,
  ARKOSE_OBSERVER_SCRIPT,
  ARKOSE_OBSERVER_SCRIPT_STOCK,
  FETCH_REGISTER_INTERCEPT_SCRIPT,
} from './browser/init_scripts.js';
import type { Persona } from './browser/persona.js';

const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  // Pin window to known screen position so native input drivers (cliclick) can map CSS→screen without Accessibility perms.
  '--window-position=0,0',
  // claude.ai's "Continue with Google" uses GIS in popup mode and
  // posts the credential back to the opener via postMessage. The
  // default popup-blocker eats that popup, breaking OAuth (FAIL
  // diagnostic 05:31Z: callback not received within 180s after
  // GIS got to /gsi/transform with no opener tab). Allow it.
  '--disable-popup-blocking',
  // HTTP/2 + QUIC + TLS1.3 early-data + DNS-HTTPS + HTTPS Upgrades are default-on in Chrome 147. Disabling emits ALPN/TLS-ext/akamaiH2 deltas TikTok+Akamai flag. Switch providers, never globally disable.
];

export interface AsyncNewBrowserOptions {
  os?: string;
  browser?: string;
  proxy?: { server: string; username?: string; password?: string; country?: string; exit_ip?: string; platform?: string };
  locale?: string;
  headless?: boolean;
  recordVideo?: boolean;
  excludeScripts?: string[];
  chromiumPath?: string;
  persona?: Persona;
}

export async function AsyncNewBrowser(options: AsyncNewBrowserOptions = {}): Promise<BrowserContext> {
  const persona = options.persona;
  const targetOs = persona?.os ?? options.os ?? 'macos';
  const browserType = persona?.browser ?? options.browser ?? 'chromium';
  const isChromium = browserType === 'chromium';
  const headless = options.headless ?? false;

  const fp = generate({ os: targetOs, browser: browserType });
  const fpConfig = toConfig(fp, targetOs, browserType);

  // Persona overrides: apply coherent per-session fingerprint values.
  if (persona) {
    const n = fpConfig.navigator ?? {};
    n.platform = persona.platform;
    n.hardwareConcurrency = persona.hardwareConcurrency;
    if (persona.deviceMemory) n.deviceMemory = persona.deviceMemory;
    n.language = persona.language;
    n.languages = [persona.language];
    // colorDepth/pixelDepth = 30 on macOS (Retina/HDR 10-bit) and 24 elsewhere.
    // 2026-05-14: prior hardcoded 24 leaked macOS-persona inconsistency (Mac UA + 24-bit color) and made PerimeterX run Canvas.toDataURL deep-fingerprint. The Apple-host Metal-rendered canvas hash then didn't match LinkedIn's expected mac-Chrome hash database, so createAccount returned challengeUrl. Confirmed via .work/diff/diff_fingerprint.mjs on run9 (M3 macOS, FAIL): screen.colorDepth=24 + Canvas.toDataURL triggered at t=2566ms vs run7 (M1 macOS, PASS) which never read either.
    // availLeft/availTop reflect the real desktop chrome (0/33 on macOS for menubar, 0/0 elsewhere) — PerimeterX checks availTop presence.
    const _depth = persona.os === 'macos' ? 30 : 24;
    const _availTop = persona.os === 'macos' ? 33 : 0;
    fpConfig.screen = { ...(fpConfig.screen ?? {}), width: persona.screen.width, height: persona.screen.height, availWidth: persona.screen.width, availHeight: persona.screen.height - 40, availLeft: 0, availTop: _availTop, colorDepth: _depth, pixelDepth: _depth };
    fpConfig.window = { ...(fpConfig.window ?? {}), devicePixelRatio: persona.screen.dpr, outerWidth: persona.screen.width + 2, outerHeight: persona.screen.height + 80, screenX: 10, screenY: 10 };
    fpConfig.webgl = { ...(fpConfig.webgl ?? {}), vendor: isChromium ? 'Google Inc.' : 'Mozilla', renderer: persona.gpu.renderer, unmaskedVendor: persona.gpu.vendor, unmaskedRenderer: persona.gpu.renderer };
    // Canvas noise NOT applied — LSB-flip makes canvas data URL 4x stock-Chrome size, TikTok mssdk flags.
  }

  const nav = fpConfig.navigator ?? {};
  // Firefox identity is owned by general.*.override prefs + the weles FF binary
  // patches. The Chrome-shaped navigator.js spoof and a Chrome ctxOpts.userAgent
  // would re-clobber that with a Chrome UA on a Gecko engine (instant Cloudflare
  // engine-consistency fail), so drop navigator.js and use the real Gecko UA.
  const ffId = isChromium ? null : firefoxIdentityFor(nav.platform, persona?.os);
  const initScript = buildInitScript(
    fpConfig,
    isChromium ? options.excludeScripts : [...(options.excludeScripts ?? []), 'navigator.js'],
  );
  const viewW = persona?.screen.width ?? 1920;
  const viewH = persona?.screen.height ?? 1080;
  const dpr = persona?.screen.dpr ?? 1;

  // tz/locale NOT set in ctxOpts — Playwright routes via CDP Emulation which TikTok mssdk detects. Pass --lang + TZ env instead.
  const ctxOpts: Record<string, any> = {
    userAgent: ffId ? ffId.ua : nav.userAgent,
    viewport: { width: viewW, height: viewH },
    screen: { width: viewW, height: viewH },
    deviceScaleFactor: dpr,
  };
  if (options.proxy) {
    ctxOpts.proxy = options.proxy;
    if (isChromium) ctxOpts.ignoreHTTPSErrors = true;
  }

  const recordVideo = options.recordVideo ?? (process.env.WELES_DISABLE_RECORDING !== '1');
  if (recordVideo) {
    const recDir = join(process.cwd(), 'recordings');
    // Frame size 1280x720 by default — at 1920x1080 each Arkose canvas repaint sends ~2MB RGBA over Playwright→webm pipe and saturates the CDP channel.
    const [vw, vh] = (process.env.WELES_VIDEO_SIZE ?? '1280x720').split('x').map(n => parseInt(n, 10));
    ctxOpts.recordVideo = { dir: recDir, size: { width: vw || 1280, height: vh || 720 } };
    try {
      const budget = parseInt(process.env.WELES_RECORDINGS_MAX_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);
      pruneRecordings(recDir, budget);
    } catch { /* skip */ }
  }

  // Launch: custom Chromium with --weles-fingerprint, or stock Playwright
  const chromiumPath = options.chromiumPath ?? process.env.CHROMIUM_PATH ?? '';
  const launchOpts: Record<string, any> = { headless };
  const args = [...CHROMIUM_ARGS];

  // Language + timezone as binary-level signals (real Chrome behavior), not CDP emulation.
  if (persona?.language) args.push(`--lang=${persona.language}`);
  if (persona?.timezone) launchOpts.env = { ...process.env, TZ: persona.timezone };

  // NopeCha auto-solver loads via launchPersistentContext only (chromium.launch+--load-extension yields empty serviceWorkers). Mutually exclusive with weles binary.
  const nopechaDir = process.env.WELES_NOPECHA_EXT === '1' ? (process.env.WELES_NOPECHA_EXT_DIR ?? '') : '';
  const useNopecha = nopechaDir && existsSync(nopechaDir) && headless === false;
  if (useNopecha) {
    args.push(`--disable-extensions-except=${nopechaDir}`);
    args.push(`--load-extension=${nopechaDir}`);
    console.log(`[async_api] loading NopeCha extension from ${nopechaDir}`);
  }

  const isCustomBinary = isChromium && chromiumPath && existsSync(chromiumPath) && process.env.WELES_USE_STOCK_CHROMIUM !== '1' && !useNopecha;

  if (isCustomBinary) {
    launchOpts.executablePath = chromiumPath;
    const cppConfig = toCppConfig(fpConfig, targetOs);
    const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-'));
    const fpFile = join(fpDir, 'config.json');
    writeFileSync(fpFile, JSON.stringify(cppConfig));
    args.push(`--weles-fingerprint=${fpFile}`);
    // Diagnostics opt-in: WELES_CHROMIUM_NETLOG=1 writes per-launch netlog + verbose stderr. Off by default (netlogs grow to 100+ MB).
    const diagDir = join(process.cwd(), 'recordings');
    let netLogPath = '';
    if (process.env.WELES_CHROMIUM_NETLOG === '1') {
      netLogPath = join(diagDir, `netlog_${Date.now()}_${Math.floor(Math.random() * 1e6)}.json`);
      args.push('--enable-logging=stderr');
      args.push('--v=1');
      args.push('--vmodule=*/net/*=2,*/proxy*=2,*/http/*=2');
      args.push(`--log-net-log=${netLogPath}`);
      args.push('--net-log-capture-mode=Everything');
    }
    // Opt-in HTTP/1.1 mode via WELES_DISABLE_HTTP2=1 — only when a residential proxy drops h2 frames inside CONNECT tunnels. Keeps h2 on by default for TikTok mssdk / Akamai h2 parity.
    if (process.env.WELES_DISABLE_HTTP2 === '1') {
      args.push('--disable-http2');
      args.push('--disable-quic');
    }
    launchOpts.args = args;
    // Re-enable breakpad so crash dumps appear in ~/Library/Logs/DiagnosticReports.
    launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader', '--disable-breakpad'];
    console.log(`[async_api] Launching custom Chromium: ${chromiumPath}`);
    console.log(`[async_api] headless=${headless} proxy=${!!options.proxy} recordVideo=${recordVideo}`);
    console.log(`[async_api] fingerprint config: ${fpFile}`);
    if (netLogPath) console.log(`[async_api] netlog: ${netLogPath}`);
    const pwBrowser = await chromium.launch(launchOpts);
    const proc = (pwBrowser as any).process?.();
    const pid = proc?.pid;
    console.log(`[async_api] Browser launched, PID=${pid} hasProc=${!!proc} hasStdout=${!!proc?.stdout} hasStderr=${!!proc?.stderr}`);

    if (proc?.stderr) proc.stderr.on('data', (c: Buffer) => { const l = c.toString().trim(); if (l) console.log(`[chromium:stderr] ${l.slice(0, 1000)}`); });
    if (proc?.stdout) proc.stdout.on('data', (c: Buffer) => { const l = c.toString().trim(); if (l) console.log(`[chromium:stdout] ${l.slice(0, 1000)}`); });
    if (proc) {
      proc.on('exit', (code: number | null, signal: string | null) => console.log(`[chromium:exit] code=${code} signal=${signal} pid=${pid}`));
      proc.on('close', (code: number | null, signal: string | null) => console.log(`[chromium:close] code=${code} signal=${signal}${netLogPath ? ' netlog=' + netLogPath : ''}`));
      proc.on('error', (err: Error) => console.log(`[chromium:error] ${err.message}`));
    }
    pwBrowser.on('disconnected', () => console.log(`[chromium:disconnected] pwBrowser disconnected pid=${pid}`));

    // Custom Chromium handles userAgent/screen via C++ — only pass viewport, proxy, recordVideo. tz via TZ env, lang via --lang.
    const customCtxOpts: Record<string, any> = { viewport: { width: viewW, height: viewH }, deviceScaleFactor: dpr };
    if (ctxOpts.proxy) { customCtxOpts.proxy = ctxOpts.proxy; customCtxOpts.ignoreHTTPSErrors = true; }
    if (ctxOpts.recordVideo) customCtxOpts.recordVideo = ctxOpts.recordVideo;
    console.log(`[async_api] Context opts: ${JSON.stringify(customCtxOpts, (k, v) => k === 'password' ? '***' : v)}`);
    const context = await pwBrowser.newContext(customCtxOpts);
    context.setDefaultNavigationTimeout(0);
    console.log(`[async_api] Context created`);
    // No initScript (would layer on C++ spoofs, regress TikTok). Inject Chrome 147 stubs only — fills Sanitizer/AnimationTrigger/TimelineTrigger gap pre-146 Chromium lacks.
    try {
      const stubPath = join(__dirname, 'scripts', 'chrome147_stubs.js');
      await context.addInitScript(readFileSync(stubPath, 'utf-8'));
    } catch (e) { console.log(`[async_api] stub script load failed: ${(e as Error).message}`); }
    if (process.env.WELES_INSTRUMENT === '1') {
      try {
        const trapPath = join(__dirname, 'diagnostics', 'property_trap.js');
        await context.addInitScript(readFileSync(trapPath, 'utf-8'));
        // Sibling files: input event recorder + canvas/audio/window-flag fingerprint hooks.
        const fpPath = join(__dirname, 'diagnostics', 'fingerprint_hooks.js');
        await context.addInitScript(readFileSync(fpPath, 'utf-8'));
        const inputPath = join(__dirname, 'diagnostics', 'input_recorder.js');
        await context.addInitScript(readFileSync(inputPath, 'utf-8'));
        console.log('[async_api] property-trap + fingerprint-hooks + input-recorder installed (WELES_INSTRUMENT=1)');
      } catch (e) { console.log(`[async_api] property-trap install failed: ${(e as Error).message}`); }
    }
    await context.addInitScript(WEBAUTHN_REJECT_SCRIPT);
    await context.addInitScript(ARKOSE_OBSERVER_SCRIPT);
    await context.addInitScript(FETCH_REGISTER_INTERCEPT_SCRIPT);
    const origClose = context.close.bind(context);
    (context as any).close = async () => { await origClose(); await pwBrowser?.close(); };
    return context;
  }

  // Stock Playwright: full fingerprint spoofing via JS init scripts
  let pwBrowser: Browser | null = null;
  let extContext: any = null;
  if (isChromium) {
    launchOpts.args = args;
    launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader'];
    if (useNopecha) {
      // Extensions only load via launchPersistentContext (verified 2026-05-03).
      const userData = mkdtempSync(join(tmpdir(), 'weles-pc-'));
      extContext = await chromium.launchPersistentContext(userData, { ...launchOpts, ...ctxOpts });
      console.log(`[async_api] launchPersistentContext userData=${userData}`);
    } else {
      pwBrowser = await chromium.launch(launchOpts);
    }
  } else {
    pwBrowser = await launchWelesFirefox({ launchOpts, persona, nav, fpConfig, proxy: options.proxy });
  }

  const context = extContext ?? await pwBrowser!.newContext(ctxOpts);
  context.setDefaultNavigationTimeout(0);

  // Strip Accept-Language on TikTok same-origin sub-requests (Chrome 147 default-on ReduceAcceptLanguage omits it; weles emits unconditionally; webmssdk signs into x-mssdk-info). EXCEPTION: passport/web/* CORS preflight needs it.
  await context.route('**/*', async (route: any) => {
    const req = route.request();
    const url = req.url();
    if (/passport\/web\//.test(url)) { await route.continue(); return; }
    if (/tiktok\.com|tiktokv\.us|tiktokcdn|byteoversea|mssdk\./.test(url) && req.isNavigationRequest() === false) {
      const headers = { ...req.headers() };
      delete headers['accept-language'];
      await route.continue({ headers });
      return;
    }
    await route.continue();
  });

  await context.addInitScript(initScript);
  await context.addInitScript(WEBAUTHN_REJECT_SCRIPT);
  await context.addInitScript(ARKOSE_OBSERVER_SCRIPT_STOCK);
  await context.addInitScript(FETCH_REGISTER_INTERCEPT_SCRIPT);

  const origClose = context.close.bind(context);
  (context as any).close = async () => { await origClose(); await pwBrowser?.close(); };

  return context;
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
