/**
 * Async Playwright API — 1:1 port of weles/async_api.py
 *
 * Launches Playwright with custom Chromium binary + fingerprint spoofing.
 */

import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, firefox, type BrowserContext, type Browser } from 'playwright';
import { generate, toConfig, toCppConfig } from './fingerprint.js';
import { buildInitScript } from './scripts/loader.js';
import { pruneRecordings } from './prune.js';

const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
];

export interface AsyncNewBrowserOptions {
  os?: string;
  browser?: string;
  proxy?: { server: string; username?: string; password?: string };
  locale?: string;
  headless?: boolean;
  recordVideo?: boolean;
  excludeScripts?: string[];
  chromiumPath?: string;
}

export async function AsyncNewBrowser(options: AsyncNewBrowserOptions = {}): Promise<BrowserContext> {
  const targetOs = options.os ?? 'macos';
  const browserType = options.browser ?? 'chromium';
  const isChromium = browserType === 'chromium';
  const headless = options.headless ?? false;

  const fp = generate({ os: targetOs, browser: browserType });
  const fpConfig = toConfig(fp, targetOs, browserType);
  const initScript = buildInitScript(fpConfig, options.excludeScripts);

  const nav = fpConfig.navigator ?? {};

  const ctxOpts: Record<string, any> = {
    userAgent: nav.userAgent,
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  };

  if (options.locale) ctxOpts.locale = options.locale;
  if (options.proxy) {
    ctxOpts.proxy = options.proxy;
    if (isChromium) ctxOpts.ignoreHTTPSErrors = true;
  }

  const recordVideo = options.recordVideo ?? (process.env.WELES_DISABLE_RECORDING !== '1');
  if (recordVideo) {
    const recDir = join(process.cwd(), 'recordings');
    ctxOpts.recordVideo = { dir: recDir };
    try {
      const budget = parseInt(process.env.WELES_RECORDINGS_MAX_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);
      pruneRecordings(recDir, budget);
    } catch { /* skip */ }
  }

  // Launch: custom Chromium with --weles-fingerprint, or stock Playwright
  const chromiumPath = options.chromiumPath ?? process.env.CHROMIUM_PATH ?? '';
  const launchOpts: Record<string, any> = { headless };
  const args = [...CHROMIUM_ARGS];

  const isCustomBinary = isChromium && chromiumPath && existsSync(chromiumPath);

  if (isCustomBinary) {
    launchOpts.executablePath = chromiumPath;
    const cppConfig = toCppConfig(fpConfig, targetOs);
    const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-'));
    const fpFile = join(fpDir, 'config.json');
    writeFileSync(fpFile, JSON.stringify(cppConfig));
    args.push(`--weles-fingerprint=${fpFile}`);
    launchOpts.args = args;
    launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader'];
    console.log(`[async_api] Launching custom Chromium: ${chromiumPath}`);
    console.log(`[async_api] headless=${headless} proxy=${!!options.proxy} recordVideo=${recordVideo}`);
    console.log(`[async_api] fingerprint config: ${fpFile}`);
    const pwBrowser = await chromium.launch(launchOpts);
    const pid = (pwBrowser as any).process?.()?.pid;
    console.log(`[async_api] Browser launched, PID=${pid}`);

    // Capture Chromium stderr for crash/error diagnostics
    const proc = (pwBrowser as any).process?.();
    if (proc?.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) console.log(`[chromium:stderr] ${line.slice(0, 1000)}`);
      });
    }

    // Custom Chromium handles userAgent/screen via C++ — only pass viewport, proxy, recordVideo
    const customCtxOpts: Record<string, any> = { viewport: { width: 1920, height: 1080 } };
    if (ctxOpts.proxy) { customCtxOpts.proxy = ctxOpts.proxy; customCtxOpts.ignoreHTTPSErrors = true; }
    if (ctxOpts.recordVideo) customCtxOpts.recordVideo = ctxOpts.recordVideo;
    console.log(`[async_api] Context opts: ${JSON.stringify(customCtxOpts, (k, v) => k === 'password' ? '***' : v)}`);
    const context = await pwBrowser.newContext(customCtxOpts);
    context.setDefaultNavigationTimeout(0);
    console.log(`[async_api] Context created`);
    await context.addInitScript(`try{var _og=navigator.credentials.get.bind(navigator.credentials);navigator.credentials.get=function(o){return o&&o.publicKey?new Promise(function(){}):_og(o)}}catch(e){}`);
    // Watch for Arkose iframe via MutationObserver — capture data before Twitter removes it
    await context.addInitScript(`try{window.__arkoseData=null;new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(n.tagName==='IFRAME'&&n.id==='arkoseFrame'){var s=n.getAttribute('src')||'';var pk=(s.match(/\\/([A-F0-9-]{36})\\//)||[])[1]||'';var bl=(s.match(/[?&]data=([^&]+)/)||[])[1]||'';window.__arkoseData={publicKey:pk,blob:decodeURIComponent(bl),subdomain:(new URL(s)).origin,ts:Date.now()};console.log('[arkose] captured pkey='+pk.slice(0,12))}})})}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}`);
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
    pwBrowser = await firefox.launch(launchOpts);
  }

  const context = await pwBrowser.newContext(ctxOpts);
  context.setDefaultNavigationTimeout(0);
  await context.addInitScript(initScript);
  // WebAuthn passkey stub — block passkey prompts (same as custom Chromium path)
  await context.addInitScript(`try{var _og=navigator.credentials.get.bind(navigator.credentials);navigator.credentials.get=function(o){return o&&o.publicKey?new Promise(function(){}):_og(o)}}catch(e){}`);
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
