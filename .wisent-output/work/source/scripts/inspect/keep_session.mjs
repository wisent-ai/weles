// Persistent weles browser session — opens once, never closes.
//
// Generic across providers. Companion act.mjs attaches via CDP for one-shot
// page actions without restarting the browser between iterations.
//
// Usage:
//   node scripts/inspect/keep_session.mjs [--url URL] [--port PORT] [--profile NAME] [--jar PATH]
//
// Defaults:
//   --port 9223
//   --profile inspect_default  (becomes ~/.weles/inspect_profiles/<name>/)
//   --url about:blank
//
// Drive it via: node scripts/inspect/act.mjs <action> [args]

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findCustomBrowser } from '../../dist/session/find_browser.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PORT = Number(arg('port', 9223));
const URL = arg('url', 'about:blank');
const PROFILE = arg('profile', 'inspect_default');
const JAR = arg('jar', '');
const USER_DATA_DIR = join(homedir(), '.weles', 'inspect_profiles', PROFILE);
const CHROMIUM = process.env.CHROMIUM_PATH || findCustomBrowser('chromium');

if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  executablePath: CHROMIUM,
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
  args: [
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ],
});

console.log(`[keep_session] Chromium launched on http://localhost:${PORT}`);
console.log(`[keep_session] profile: ${USER_DATA_DIR}`);

if (JAR) {
  try {
    const jar = JSON.parse(readFileSync(JAR, 'utf8'));
    if (jar.cookies?.length) { await ctx.addCookies(jar.cookies); console.log(`[keep_session] injected ${jar.cookies.length} cookies from ${JAR}`); }
  } catch (e) { console.log(`[keep_session] jar load skipped: ${e.message?.slice(0, 80)}`); }
}

const page = ctx.pages()[0] || await ctx.newPage();
console.log(`[keep_session] navigating to ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`[keep_session] goto warn: ${e.message?.slice(0, 80)}`));
console.log(`[keep_session] current URL: ${page.url()}`);

console.log('[keep_session] === BROWSER STAYS OPEN. Idling forever. ===');
console.log('[keep_session] Drive: node scripts/inspect/act.mjs <action> [args]');
console.log('[keep_session] Actions: dump | click <sel> | fill <sel> <text> | nav <url> | screenshot | eval <js> | url | api <METHOD> <path> [body] | download <url> <out>');

await new Promise(() => {});
