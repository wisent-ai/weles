// Persistent Tencent HY 3D Global session — kept until an operator stop or browser failure.
// Subsequent helper invocations attach via CDP and drive the same page.
//
// Run on the Stado-selected dedicated host: node src/keeper/keeper.mjs
// CDP: the system picks a free port; Chromium writes it to the profile's
// DevToolsActivePort file, which action.mjs reads.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { customBrowserSearchHint, findCustomChromium } from '../../dist/session/find_browser.js';

const devToolsPort = () => Number(readFileSync(join(USER_DATA_DIR, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
const PORTAL_URL = 'https://3d.hunyuanglobal.com/';
const JAR_PATH = join(homedir(), '.weles', 'cookie-jars', 'tencent.json');
const USER_DATA_DIR = join(homedir(), '.weles', 'tencent_persistent_profile');
// The Weles Chromium is the exact release Stado installed for this
// deployment, found and verified by the same resolver every session uses;
// no build directory under one person's home is assumed.
const CHROMIUM = findCustomChromium();
if (!CHROMIUM) throw new Error(`Weles Chromium is not installed as a verified release: ${customBrowserSearchHint('chromium')}`);

if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  timeout: 0,
  executablePath: CHROMIUM,
  viewport: { width: 1280, height: 800 },
  args: [
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ],
});

ctx.setDefaultTimeout(0);
ctx.setDefaultNavigationTimeout(0);

let page;
let stopping = false;
let closing;
const closeOwnedContext = () => closing ??= ctx.close();
const { promise: lifetime, resolve, reject } = Promise.withResolvers();
const failure = (code, message) => Object.assign(new Error(message), {
  code, pageUrl: page?.url() ?? null, portalUrl: PORTAL_URL, cdpPort: devToolsPort(),
});
const onContextClosed = () => {
  if (stopping) resolve();
  else reject(failure('KEEPER_CONTEXT_CLOSED', 'Keeper browser context closed unexpectedly'));
};
const onPageClosed = () => {
  if (!stopping) reject(failure('KEEPER_PAGE_CLOSED', 'Keeper page closed unexpectedly'));
};
const onPageCrashed = () => reject(failure('KEEPER_PAGE_CRASHED', 'Keeper page crashed'));
const onStop = () => {
  stopping = true;
  closeOwnedContext().then(resolve, reject);
};
ctx.on('close', onContextClosed);
process.on('SIGINT', onStop);
process.on('SIGTERM', onStop);

try {
  // Register lifetime observation before any browser operation can fail.
  const startup = Promise.resolve().then(async () => {
    console.log(`[keeper] Chromium launched with CDP on http://127.0.0.1:${devToolsPort()}`);
    console.log(`[keeper] User data dir: ${USER_DATA_DIR}`);
    let jar;
    try {
      jar = JSON.parse(readFileSync(JAR_PATH, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      console.log(`[keeper] no cookie jar at ${JAR_PATH}; using the persistent profile`);
    }
    if (jar?.cookies?.length) {
      await ctx.addCookies(jar.cookies);
      console.log(`[keeper] injected ${jar.cookies.length} cookies`);
    }
    page = ctx.pages()[0] || await ctx.newPage();
    page.on('close', onPageClosed);
    page.on('crash', onPageCrashed);
    console.log(`[keeper] navigating to ${PORTAL_URL}`);
    const response = await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) {
      throw Object.assign(failure('KEEPER_NAVIGATION_REFUSED', 'Keeper portal navigation did not return a successful HTTP response'), {
        status: response?.status() ?? null,
      });
    }
    console.log(`[keeper] current URL: ${page.url()}`);
    console.log('[keeper] browser ready; an operator stop closes this owned context');
    console.log('[keeper] Drive via: node src/keeper/action.mjs <action> [args]');
    console.log('[keeper] Actions: dump | click <sel> | fill <sel> <text> | nav <url> | screenshot | eval <js>');
  }).catch((error) => {
    if (!stopping) reject(error);
    throw error;
  });
  const [ended, started] = await Promise.allSettled([lifetime, startup]);
  if (ended.status === 'rejected') throw ended.reason;
  if (!stopping && started.status === 'rejected') throw started.reason;
} finally {
  ctx.off('close', onContextClosed);
  page?.off('close', onPageClosed);
  page?.off('crash', onPageCrashed);
  process.off('SIGINT', onStop);
  process.off('SIGTERM', onStop);
  await closeOwnedContext();
}
