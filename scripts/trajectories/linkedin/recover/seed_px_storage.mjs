// One-shot operator script. Opens real Chrome on linkedin.com/login, lets the
// human drive the flow (type creds, solve any checkpoint captcha by hand, land
// on /feed). On browser close, extracts:
//   - localStorage PerimeterX + reCAPTCHA keys (PXdOjV695v_*, _pxvid, pxsid,
//     px_*, _px_*, rc::*, _grecaptcha)
//   - All linkedin.com cookies (li_at, JSESSIONID, _px_, etc.)
// PATCHes both into social_accounts.metadata for the target account.
//
// Why: weles automation cannot clear /checkpoint on a cold-start session
// because PerimeterX challenges every brand-new visitor on a residential
// proxy. Diff harness 2026-05-03 (.work/inst/linkedin_login_diff_2026-05-03T
// 21-02-42-556Z.md lines 25-30) confirmed chrome's session reads __pxvid +
// writes px_hvd while weles reads/writes neither. Once metadata.
// linkedin_px_storage is seeded once per account (this script), every
// subsequent linkedin_login restores it before form-fill and PX recognises
// the returning visitor.
//
// Usage:
//   ACCOUNT_ID=<uuid> node scripts/trajectories/linkedin/recover/seed_px_storage.mjs
//   USERNAME=<dbusername> node scripts/trajectories/linkedin/recover/seed_px_storage.mjs

import { chromium } from 'playwright';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const DATABASE_URL = process.env.WELES_DATABASE_URL ?? '';
const DATABASE_TOKEN = process.env.WELES_DATABASE_TOKEN ?? '';
if (!DATABASE_URL || !DATABASE_TOKEN) { console.error('FAIL: WELES_DATABASE_URL + WELES_DATABASE_TOKEN required'); process.exit(Number('2')); }

const ACCOUNT_ID = process.env.ACCOUNT_ID ?? '';
const USERNAME = process.env.USERNAME ?? '';
if (!ACCOUNT_ID && !USERNAME) { console.error('FAIL: set ACCOUNT_ID=<uuid> or USERNAME=<linkedin-username>'); process.exit(2); }

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) { console.error(`FAIL: chrome binary missing at ${CHROME_BIN}`); process.exit(2); }

// Resolve the account row up-front so we fail fast on bad ID/username.
const idFilter = ACCOUNT_ID ? `id=eq.${ACCOUNT_ID}` : `platform=eq.linkedin&username=eq.${encodeURIComponent(USERNAME)}`;
const acctRes = await fetch(`${DATABASE_URL}/rest/v1/social_accounts?${idFilter}&select=id,username,metadata`, { headers: { apikey: DATABASE_TOKEN, Authorization: `Bearer ${DATABASE_TOKEN}` } });
const accts = await acctRes.json();
if (!accts?.[0]?.id) { console.error(`FAIL: no social_accounts row for ${ACCOUNT_ID || USERNAME}`); process.exit(2); }
const acct = accts[0];
console.log(`[seed-px] target: ${acct.username} (id=${acct.id.slice(0,8)})`);

// Persistent context — Chrome keeps cookies/localStorage between requests so
// PX can write its state and we can scrape it on close.
const userDataDir = mkdtempSync(join(tmpdir(), 'seed-px-'));
const browser = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_BIN,
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars'],
  ignoreDefaultArgs: ['--enable-automation', '--disable-breakpad'],
});
const page = browser.pages()[0] || await browser.newPage();
console.log('[seed-px] navigating to linkedin.com/login (real Chrome, fingerprint genuine)');
try { await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }); }
catch (e) { console.log(`[seed-px] goto err: ${e.message?.slice(0, 120)}`); }

// Auto-fill from DB metadata if AUTO_LOGIN=1 + creds present.
const email = acct.metadata?.email;
const password = acct.metadata?.password;
if (process.env.AUTO_LOGIN === '1' && email && password) {
  try {
    const userInput = page.locator('input#username, input[name="session_key"], input[type="email"][autocomplete*="username"], input[type="email"]').filter({ visible: true }).first();
    await userInput.waitFor({ state: 'visible' });
    await humanFill(page, userInput, email);
    const pwInput = page.locator('input#password, input[name="session_password"], input[type="password"]').filter({ visible: true }).first();
    await humanFill(page, pwInput, password);
    console.log('[seed-px] auto-filled credentials, submitting');
    // Submit by pressing Enter inside the password field — LinkedIn's
    // /login form binds Enter to the form's default submit, sidestepping
    // the variable button selectors (id="organic-div-form" submit
    // button has dynamic class names that break direct selectors).
    await pwInput.press('Enter');
    await page.waitForURL((url) => !/\/login(\?|$)/.test(url.toString())).catch(() => {});
    console.log(`[seed-px] post-submit url=${page.url()}`);
  } catch (e) { console.log(`[seed-px] auto-login err: ${e.message?.slice(0, 120)}`); }
}

console.log('[seed-px] window is yours (or auto-login result above). Close Chrome to capture state.');
await new Promise((resolve) => {
  let resolved = false;
  const done = (why) => { if (resolved) return; resolved = true; console.log(`[seed-px] stopping: ${why}`); resolve(); };
  page.on('close', () => done('page closed'));
  browser.on('close', () => done('browser closed'));
  process.on('SIGINT', () => done('SIGINT'));
  process.on('SIGTERM', () => done('SIGTERM'));
});

// Extract localStorage on the linkedin.com origin. Page may already be closed
// when we get here — re-open a tab if needed to access the origin.
const PX_RE = /^(PXdOjV695v_|_pxvid|pxsid|_?px_|rc::|_grecaptcha)/;
let lsItems = {};
try {
  let scrapePage = browser.pages().find((p) => p.url().includes('linkedin.com')) ?? browser.pages()[0];
  if (!scrapePage || scrapePage.isClosed()) scrapePage = await browser.newPage();
  if (!scrapePage.url().includes('linkedin.com')) {
    await scrapePage.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  lsItems = await scrapePage.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const out = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && re.test(k)) out[k] = localStorage.getItem(k); } } catch {}
    return out;
  }, PX_RE.source).catch(() => ({}));
} catch (e) { console.log(`[seed-px] localStorage scrape err: ${e.message?.slice(0, 120)}`); }
const lsCount = Object.keys(lsItems).length;
console.log(`[seed-px] captured ${lsCount} PX localStorage keys`);
if (lsCount === 0) {
  console.error('FAIL: no PX keys captured. Closed before reaching /feed (or wrong creds blocked login). Refusing to PATCH empty storage.');
  await browser.close().catch(() => {});
  process.exit(1);
}

// Capture cookies for the linkedin.com domain.
let cookies = [];
try { cookies = (await browser.cookies()).filter((c) => /linkedin\.com$/.test((c.domain ?? '').replace(/^\./, ''))); }
catch (e) { console.log(`[seed-px] cookies scrape err: ${e.message?.slice(0, 120)}`); }
const liAt = cookies.find((c) => c.name === 'li_at' && c.value);
console.log(`[seed-px] captured ${cookies.length} linkedin.com cookies (li_at=${!!liAt})`);

await browser.close().catch(() => {});

// PATCH metadata.linkedin_px_storage + cookies.
const now = new Date().toISOString();
const merged = {
  ...(acct.metadata ?? {}),
  linkedin_px_storage: lsItems,
  linkedin_px_storage_at: now,
};
if (cookies.length) {
  merged.cookies = cookies;
  merged.cookies_updated_at = now;
  merged.cookies_minted_at = now;
  delete merged.cookies_stale_at;
}
const patchRes = await fetch(`${DATABASE_URL}/rest/v1/social_accounts?id=eq.${acct.id}`, {
  method: 'PATCH',
  headers: { apikey: DATABASE_TOKEN, Authorization: `Bearer ${DATABASE_TOKEN}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  body: JSON.stringify({ metadata: merged }),
});
if (!patchRes.ok) { console.error(`FAIL: PATCH returned ${patchRes.status}: ${(await patchRes.text()).slice(0, 200)}`); process.exit(1); }
console.log(`PASS: seeded metadata.linkedin_px_storage (${lsCount} keys) + cookies (${cookies.length}) for ${acct.username}`);
