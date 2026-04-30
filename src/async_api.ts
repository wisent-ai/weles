/**
 * Async Playwright API — 1:1 port of weles/async_api.py
 *
 * Launches Playwright with custom Chromium binary + fingerprint spoofing.
 */

import { existsSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, firefox, type BrowserContext, type Browser } from 'playwright';
import { generate, toConfig, toCppConfig, toFirefoxWelesPrefs } from './fingerprint.js';
import { buildInitScript } from './scripts/loader.js';
import { pruneRecordings } from './prune.js';
import { findCustomBrowser } from './session/find_browser.js';
import type { Persona } from './browser/persona.js';

const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  // Pin the window to a known screen position so native OS input drivers
  // (scripts/trajectories/* using cliclick) can compute screen coordinates
  // from CSS coordinates without needing AppleScript Accessibility perms.
  '--window-position=0,0',
  // HTTP/2, QUIC, TLS1.3 early data, DNS-HTTPS records, and HTTPS Upgrades
  // are ALL enabled in real Chrome 147. Disabling them here — a past workaround
  // for PacketStream proxies dropping h2 frames — emits distinctive fingerprints
  // (ALPN without h2, missing TLS `application_settings` (17613) extension,
  // akamaiH2 fingerprint absent). TikTok and Akamai both flag this. If a proxy
  // provider breaks with h2, switch providers for that flow (Oxylabs residential
  // + mobile tunnel HTTP/2 fine) rather than globally disabling it.
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
    if (persona.deviceMemory) n.deviceMemory = persona.deviceMemory;  // optional override; default = host RAM (matches real Chrome)
    n.language = persona.language;
    n.languages = [persona.language];
    fpConfig.screen = { ...(fpConfig.screen ?? {}), width: persona.screen.width, height: persona.screen.height, availWidth: persona.screen.width, availHeight: persona.screen.height - 40, colorDepth: 24, pixelDepth: 24 };
    fpConfig.window = { ...(fpConfig.window ?? {}), devicePixelRatio: persona.screen.dpr, outerWidth: persona.screen.width + 2, outerHeight: persona.screen.height + 80, screenX: 10, screenY: 10 };
    fpConfig.webgl = { ...(fpConfig.webgl ?? {}), vendor: isChromium ? 'Google Inc.' : 'Mozilla', renderer: persona.gpu.renderer, unmaskedVendor: persona.gpu.vendor, unmaskedRenderer: persona.gpu.renderer };
    // Canvas noise intentionally NOT applied — see fingerprint.ts. The LSB-flip
    // makes our canvas data URL 4x the size of real Chrome for the same content,
    // which TikTok mssdk flags. We leave canvas unmodified so the bitmap matches
    // stock Chrome on this GPU.
  }

  const initScript = buildInitScript(fpConfig, options.excludeScripts);

  const nav = fpConfig.navigator ?? {};

  const viewW = persona?.screen.width ?? 1920;
  const viewH = persona?.screen.height ?? 1080;
  const dpr = persona?.screen.dpr ?? 1;

  const ctxOpts: Record<string, any> = {
    userAgent: nav.userAgent,
    viewport: { width: viewW, height: viewH },
    screen: { width: viewW, height: viewH },
    deviceScaleFactor: dpr,
    // Do NOT set timezoneId or locale here — Playwright routes them through
    // CDP Emulation.setTimezoneOverride / setLocaleOverride, which TikTok's
    // mssdk detects. Measured 2026-04-18: weles with locale set in ctxOpts
    // sends Accept-Language on every TikTok sub-request; real Chrome omits
    // it on same-origin sub-requests because the ReduceAcceptLanguage feature
    // is enabled by default. Pass --lang + TZ environment instead (see below).
  };
  if (options.proxy) {
    ctxOpts.proxy = options.proxy;
    if (isChromium) ctxOpts.ignoreHTTPSErrors = true;
  }

  const recordVideo = options.recordVideo ?? (process.env.WELES_DISABLE_RECORDING !== '1');
  if (recordVideo) {
    const recDir = join(process.cwd(), 'recordings');
    // Cap recorded frame size independently of viewport. At 1920x1080 every
    // Arkose canvas repaint sends ~2MB of RGBA through Playwright's pipe for
    // webm encoding; under heavy puzzle animation this saturates the CDP
    // channel and the session disconnects mid-solve. 1280x720 cuts per-frame
    // payload by 55% (2.07M px -> 0.92M px) which keeps the channel responsive
    // while still producing a legible recording. Override via WELES_VIDEO_SIZE=WxH.
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

  // Pass language + timezone as binary-level signals instead of CDP emulation
  // (removed from ctxOpts above). --lang sets Accept-Language the way real
  // Chrome does; TZ env var is honored by the renderer for Date/Intl.
  if (persona?.language) args.push(`--lang=${persona.language}`);
  if (persona?.timezone) launchOpts.env = { ...process.env, TZ: persona.timezone };

  const isCustomBinary = isChromium && chromiumPath && existsSync(chromiumPath);

  if (isCustomBinary) {
    launchOpts.executablePath = chromiumPath;
    const cppConfig = toCppConfig(fpConfig, targetOs);
    const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-'));
    const fpFile = join(fpDir, 'config.json');
    writeFileSync(fpFile, JSON.stringify(cppConfig));
    args.push(`--weles-fingerprint=${fpFile}`);
    // Diagnostics opt-in via env (WELES_CHROMIUM_NETLOG=1 writes per-launch
    // netlog + verbose stderr). Off by default — netlogs grow to 100+ MB and
    // filled the disk during extended signup sessions.
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
    // Opt-in HTTP/1.1-only mode. Residential proxy relays (PacketStream,
    // Oxylabs rotating) sometimes silently drop HTTP/2 frames inside a
    // CONNECT tunnel — tunnel 200s fine, then the GET hangs 30-60s.
    // Enable per-flow via WELES_DISABLE_HTTP2=1 when using a proxy that
    // breaks h2. Keeps h2 on by default so TikTok's mssdk / Akamai h2
    // fingerprints match stock Chrome.
    if (process.env.WELES_DISABLE_HTTP2 === '1') {
      args.push('--disable-http2');
      args.push('--disable-quic');
    }
    launchOpts.args = args;
    // Re-enable breakpad so crash dumps appear in ~/Library/Logs/DiagnosticReports.
    // Playwright adds --disable-breakpad by default, which suppresses them entirely.
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

    // Custom Chromium handles userAgent/screen via C++ — only pass viewport, proxy, recordVideo
    const customCtxOpts: Record<string, any> = { viewport: { width: viewW, height: viewH }, deviceScaleFactor: dpr };
    // Do NOT set timezoneId or locale here — see note above, Playwright routes
    // them through CDP Emulation.setTimezoneOverride / setLocaleOverride which
    // TikTok's mssdk detects. Timezone is passed via TZ env var on launch;
    // language via --lang binary flag.
    if (ctxOpts.proxy) { customCtxOpts.proxy = ctxOpts.proxy; customCtxOpts.ignoreHTTPSErrors = true; }
    if (ctxOpts.recordVideo) customCtxOpts.recordVideo = ctxOpts.recordVideo;
    console.log(`[async_api] Context opts: ${JSON.stringify(customCtxOpts, (k, v) => k === 'password' ? '***' : v)}`);
    const context = await pwBrowser.newContext(customCtxOpts);
    context.setDefaultNavigationTimeout(0);
    console.log(`[async_api] Context created`);
    // NOTE: NOT calling `context.addInitScript(initScript)` — that would layer
    // navigator.js/webgl.js/automation.js on top of weles's C++ spoofs and
    // regress to blocking at /region/ instead of /register_verify_login/.
    // But we DO inject the Chrome 147 API stubs — weles is Chromium 145 and
    // lacks Sanitizer / AnimationTrigger / TimelineTrigger{,Range,RangeList}.
    // TikTok's JS can `typeof window.Sanitizer !== 'undefined'` as a one-liner
    // to detect pre-146 Chromium. Surgical stubs = no prototype overrides, no
    // descriptor-mismatch signals — only adds missing globals.
    try {
      const stubPath = join(__dirname, 'scripts', 'chrome147_stubs.js');
      await context.addInitScript(readFileSync(stubPath, 'utf-8'));
    } catch (e) { console.log(`[async_api] stub script load failed: ${(e as Error).message}`); }
    if (process.env.WELES_INSTRUMENT === '1') {
      try {
        const trapPath = join(__dirname, 'diagnostics', 'property_trap.js');
        await context.addInitScript(readFileSync(trapPath, 'utf-8'));
        console.log('[async_api] property-trap instrumentation installed (WELES_INSTRUMENT=1)');
      } catch (e) { console.log(`[async_api] property-trap install failed: ${(e as Error).message}`); }
    }
    // WebAuthn passkey stub — block passkey prompts. Must reject with
    // NotAllowedError (like a real browser without authenticator), NOT
    // return a hanging Promise — Reddit's anti-bot detects the
    // never-resolving Promise and loops (39x vs 4x on human).
    await context.addInitScript(`try{var _og=navigator.credentials.get.bind(navigator.credentials);navigator.credentials.get=function(o){if(o&&o.publicKey){var exc=new DOMException('The operation is not supported.','NotAllowedError');return Promise.reject(exc)}return _og(o)}}catch(e){}`);
    // Arkose: capture iframe data via MutationObserver
    // Arkose iframe-data observer. Do NOT pre-create window.__arkoseData — that
    // shows up as an extra own-window property on every page, including about:blank
    // and TikTok, and fingerprint diffs flag it. Only materialize the property when
    // an Arkose iframe actually appears.
    await context.addInitScript(`try{new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(n.tagName==='IFRAME'&&n.id==='arkoseFrame'){var s=n.getAttribute('src')||'';var pk=(s.match(/\\/([A-F0-9-]{36})\\//)||[])[1]||'';var bl=(s.match(/[?&]data=([^&]+)/)||[])[1]||'';window.__arkoseData={publicKey:pk,blob:decodeURIComponent(bl),subdomain:(new URL(s)).origin,ts:Date.now()};console.log('[arkose] captured pkey='+pk.slice(0,12))}})})}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}`);
    // Intercept fetch to capture captcha data from API responses (Discord/hCaptcha Enterprise pattern)
    await context.addInitScript(`try{var _of=window.fetch;window.fetch=function(){var u=arguments[0],o=arguments[1]||{};if(typeof u==='string'&&u.includes('/auth/register')&&o.method==='POST'){try{window.__weles_form_data=JSON.parse(o.body)}catch(e){}try{var h=o.headers||{};window.__weles_extra_headers={};for(var k in h){if(k.startsWith('x-'))window.__weles_extra_headers[k]=h[k]}}catch(e){}}return _of.apply(this,arguments).then(function(r){if(typeof u==='string'&&u.includes('/auth/register')&&r.status>=400){r.clone().json().then(function(d){if(d.captcha_key!==undefined)window.__weles_captcha_response=d}).catch(function(){})}return r})}}catch(e){}`);
    const origClose = context.close.bind(context);
    (context as any).close = async () => { await origClose(); await pwBrowser.close(); };
    return context;
  }

  // Stock Playwright: use full fingerprint spoofing via JS init scripts
  let pwBrowser: Browser;
  if (isChromium) {
    launchOpts.args = args;
    launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader'];
    pwBrowser = await chromium.launch(launchOpts);
  } else {
    // Firefox parity: pref-level fingerprint enforcement (iframe-safe).
    // general.*/dom.* honored by stock Firefox; weles.fingerprint.* only
    // honored by the weles-patched binary (stock ignores unknown keys).
    launchOpts.firefoxUserPrefs = Object.assign({
      'privacy.resistFingerprinting': false, 'privacy.fingerprintingProtection': false, 'dom.webdriver.enabled': false,
    }, persona?.language && { 'intl.accept_languages': persona.language },
       nav.userAgent && { 'general.useragent.override': nav.userAgent },
       nav.platform && { 'general.platform.override': nav.platform },
       nav.oscpu && { 'general.oscpu.override': nav.oscpu },
       nav.appVersion && { 'general.appversion.override': nav.appVersion },
       nav.hardwareConcurrency && { 'dom.maxHardwareConcurrency': nav.hardwareConcurrency },
       toFirefoxWelesPrefs(fpConfig));
    const ffBin = findCustomBrowser('firefox');
    if (ffBin) launchOpts.executablePath = ffBin;
    pwBrowser = await firefox.launch(launchOpts);
  }

  const context = await pwBrowser.newContext(ctxOpts);
  context.setDefaultNavigationTimeout(0);

  // Strip Accept-Language on same-origin TikTok sub-requests. Real Chrome 147
  // with ReduceAcceptLanguage (default on) omits this header on sub-requests;
  // weles's binary emits it unconditionally and that's one of the signals
  // webmssdk signs into x-mssdk-info, allowing TikTok to recognise the session
  // as non-Chrome. Measured 2026-04-18 via side-by-side manual captures.
  // EXCEPTION: passport/web/* (region, login, etc.) are cross-origin POSTs
  // requiring CORS preflight — without accept-language the OPTIONS response
  // mismatches the request headers and Chrome aborts with ERR_FAILED.
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (/passport\/web\//.test(url)) {
      await route.continue();
      return;
    }
    if (/tiktok\.com|tiktokv\.us|tiktokcdn|byteoversea|mssdk\./.test(url) && req.isNavigationRequest() === false) {
      const headers = { ...req.headers() };
      delete headers['accept-language'];
      await route.continue({ headers });
      return;
    }
    await route.continue();
  });

  await context.addInitScript(initScript);
  // WebAuthn passkey stub — block passkey prompts (same as custom Chromium path)
  await context.addInitScript(`try{var _og=navigator.credentials.get.bind(navigator.credentials);navigator.credentials.get=function(o){if(o&&o.publicKey){var exc=new DOMException('The operation is not supported.','NotAllowedError');return Promise.reject(exc)}return _og(o)}}catch(e){}`);
  await context.addInitScript(`try{window.__arkoseData=null;new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(n.tagName==='IFRAME'&&n.id==='arkoseFrame'){var s=n.getAttribute('src')||'';var pk=(s.match(/\\/([A-F0-9-]{36})\\//)||[])[1]||'';var bl=(s.match(/[?&]data=([^&]+)/)||[])[1]||'';window.__arkoseData={publicKey:pk,blob:decodeURIComponent(bl),subdomain:(new URL(s)).origin,ts:Date.now()};console.log('[arkose] captured pkey='+pk.slice(0,12))}})})}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}`);
  await context.addInitScript(`try{var _of=window.fetch;window.fetch=function(){var u=arguments[0],o=arguments[1]||{};if(typeof u==='string'&&u.includes('/auth/register')&&o.method==='POST'){try{window.__weles_form_data=JSON.parse(o.body)}catch(e){}try{var h=o.headers||{};window.__weles_extra_headers={};for(var k in h){if(k.startsWith('x-'))window.__weles_extra_headers[k]=h[k]}}catch(e){}}return _of.apply(this,arguments).then(function(r){if(typeof u==='string'&&u.includes('/auth/register')&&r.status>=400){r.clone().json().then(function(d){if(d.captcha_key!==undefined)window.__weles_captcha_response=d}).catch(function(){})}return r})}}catch(e){}`);

  const origClose = context.close.bind(context);
  (context as any).close = async () => { await origClose(); await pwBrowser.close(); };

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
