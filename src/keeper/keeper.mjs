// Persistent Tencent HY 3D Global session — opens once, never closes.
// Subsequent helper invocations attach via CDP and drive the same page.
//
// Run: node src/keeper/keeper.mjs
// CDP: http://localhost:9223

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { customBrowserSearchHint, findCustomChromium } from '../../dist/session/find_browser.js';

const PORT = 9223;
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
  executablePath: CHROMIUM,
  viewport: { width: 1280, height: 800 },
  args: [
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ],
});

console.log(`[keeper] Chromium launched with CDP on http://localhost:${PORT}`);
console.log(`[keeper] User data dir: ${USER_DATA_DIR}`);

try {
  const jar = JSON.parse(readFileSync(JAR_PATH, 'utf8'));
  if (jar.cookies?.length) { await ctx.addCookies(jar.cookies); console.log(`[keeper] injected ${jar.cookies.length} cookies`); }
} catch (e) { console.log(`[keeper] no cookie jar: ${e.message}`); }

const page = ctx.pages()[0] || await ctx.newPage();
console.log(`[keeper] navigating to ${PORTAL_URL}`);
await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`[keeper] goto warn: ${e.message}`));
console.log(`[keeper] current URL: ${page.url()}`);

console.log('[keeper] === BROWSER STAYS OPEN ===');
console.log('[keeper] Drive via: node src/keeper/action.mjs <action> [args]');
console.log('[keeper] Actions: dump | click <sel> | fill <sel> <text> | nav <url> | screenshot | eval <js>');

// Idle forever. Never close.
await new Promise(() => {});
