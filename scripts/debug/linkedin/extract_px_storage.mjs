// Extract PerimeterX storage from a real-Chrome bootstrap and persist it to a
// LinkedIn account item in Skarbiec.
// Usage: ACCOUNT_ITEM=weles-linkedin-<username>-account node scripts/debug/linkedin/extract_px_storage.mjs

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAccount, updateAccountMetadata } from '../../trajectories/_shared/skarbiec_accounts.mjs';

const ACCOUNT_ITEM = process.env.ACCOUNT_ITEM;
if (!ACCOUNT_ITEM) { console.error('ACCOUNT_ITEM env required'); process.exit(2); }
const account = readAccount(ACCOUNT_ITEM);

const PX_LS_KEY_RE = /^(PXdOjV695v_|_pxvid|pxsid|_?px_|rc::|_grecaptcha)/;

// Same launch shape as scripts/debug/instrument_chrome.mjs — ignoreDefaultArgs
// drops --enable-automation so navigator.webdriver === false, and
// --disable-blink-features=AutomationControlled removes the additional
// automation flag PX reads. Without these, playwright's chromium reports as
// automation and PX bails before writing localStorage.
const scratchRoot = join(homedir(), '.stado', 'work');
mkdirSync(scratchRoot, { recursive: true });
const userDataDir = mkdtempSync(join(scratchRoot, 'px-extract-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars', '--lang=en-US'],
  ignoreDefaultArgs: ['--enable-automation', '--disable-breakpad'],
});
const page = ctx.pages()[0] || await ctx.newPage();
console.log('[px-extract] navigating to https://www.linkedin.com/login');
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('[px-extract] waiting 15s for PX bootstrap');
await humanIdlePause('long');

// PerimeterX writes its trust state inside the cross-origin
// li.protechts.net iframe (verified 2026-05-04 frame probe) — main-page
// localStorage is empty. Walk every frame and collect storage keyed by
// the iframe's origin; weles can replay each origin via per-frame
// addInitScript later.
const items = {};
for (const f of page.frames()) {
  try {
    const r = await f.evaluate((reSrc) => {
      const re = new RegExp(reSrc);
      const out = { localStorage: {}, sessionStorage: {} };
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && re.test(k)) out.localStorage[k] = localStorage.getItem(k);
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && re.test(k)) out.sessionStorage[k] = sessionStorage.getItem(k);
      }
      return { origin: location.origin, ...out };
    }, PX_LS_KEY_RE.source);
    if (Object.keys(r.localStorage).length || Object.keys(r.sessionStorage).length) {
      items[r.origin] = { localStorage: r.localStorage, sessionStorage: r.sessionStorage };
    }
  } catch {}
}

const cookies = await ctx.cookies();
const pxCookies = cookies.filter((c) => /protechts\.net|perimeterx/.test(c.domain ?? '') || /^_px/.test(c.name));

const totalKeys = Object.values(items).reduce((n, v) => n + Object.keys(v.localStorage).length + Object.keys(v.sessionStorage).length, 0);
console.log(`[px-extract] captured ${totalKeys} keys across ${Object.keys(items).length} origins + ${pxCookies.length} PX cookies`);
for (const [origin, v] of Object.entries(items)) {
  console.log(`  ${origin}: localStorage=${Object.keys(v.localStorage).join(',')} sessionStorage=${Object.keys(v.sessionStorage).join(',')}`);
}
console.log(`  cookies: ${pxCookies.map((c) => `${c.name}@${c.domain}`).join(', ')}`);

updateAccountMetadata(account.id, {
  linkedin_px_storage: items,
  linkedin_px_storage_at: new Date().toISOString(),
  linkedin_px_cookies: pxCookies,
});
console.log(`[px-extract] persisted to ${account.id}`);
await ctx.close();
