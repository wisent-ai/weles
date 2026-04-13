/**
 * Async Playwright API — 1:1 port of weles/async_api.py
 *
 * Launches Playwright with custom Chromium binary + fingerprint spoofing.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
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

  if (isChromium && chromiumPath && existsSync(chromiumPath)) {
    launchOpts.executablePath = chromiumPath;
    const cppConfig = toCppConfig(fpConfig, targetOs);
    const fpFile = join(mkdtempSync(join(tmpdir(), 'weles-fp-')), 'config.json');
    writeFileSync(fpFile, JSON.stringify(cppConfig));
    args.push(`--weles-fingerprint=${fpFile}`);
  }

  let pwBrowser: Browser;
  if (isChromium) {
    launchOpts.args = args;
    launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader'];
    pwBrowser = await chromium.launch(launchOpts);
  } else {
    pwBrowser = await firefox.launch(launchOpts);
  }

  const context = await pwBrowser.newContext(ctxOpts);
  await context.addInitScript(initScript);

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
