// Operator-assisted LinkedIn recovery. Opens real Chrome, lets the operator
// complete any checkpoint, then stores PerimeterX localStorage and cookies in
// the exact LinkedIn account item in Skarbiec.
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
//   ACCOUNT_ITEM=weles-linkedin-<username>-account node src/trajectories/linkedin/recover/seed_px_storage.mjs
//   USERNAME=<linkedin-username> node src/trajectories/linkedin/recover/seed_px_storage.mjs

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { findAccount, readAccount, updateAccountMetadata } from '../../_shared/skarbiec_accounts.mjs';
import { launchProfileChrome } from '../../../browser/real_chrome.mjs';


const ACCOUNT_ITEM = process.env.ACCOUNT_ITEM ?? '';
const USERNAME = process.env.USERNAME ?? '';
if (!ACCOUNT_ITEM && !USERNAME) { console.error('FAIL: set ACCOUNT_ITEM=<skarbiec-item> or USERNAME=<linkedin-username>'); process.exit(2); }

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) { console.error(`FAIL: chrome binary missing at ${CHROME_BIN}`); process.exit(2); }

const acct = ACCOUNT_ITEM ? readAccount(ACCOUNT_ITEM) : findAccount('linkedin', USERNAME);
if (!acct) { console.error(`FAIL: no LinkedIn account in Skarbiec for ${ACCOUNT_ITEM || USERNAME}`); process.exit(2); }
console.log(`[seed-px] target: ${acct.username} (item=${acct.id})`);

// Persistent context — Chrome keeps cookies/localStorage between requests so
// PX can write its state and we can scrape it on close.
const workRoot = join(homedir(), '.stado', 'work');
mkdirSync(workRoot, { recursive: true });
const userDataDir = mkdtempSync(join(workRoot, 'seed-px-'));
// The launch lives in the reviewed browser boundary; the argument set is the
// one this operator-assisted recovery was verified with.
const browser = await launchProfileChrome({ userDataDir, executablePath: CHROME_BIN });
const page = browser.pages()[0] || await browser.newPage();
console.log('[seed-px] navigating to linkedin.com/login (real Chrome, fingerprint genuine)');
try { await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }); }
catch (e) { console.log(`[seed-px] goto err: ${e.message?.slice(0, 120)}`); }

// Auto-fill from Skarbiec if AUTO_LOGIN=1 and credentials are present.
const email = acct.metadata?.email ?? acct.username;
const password = acct.password;
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
  console.error('FAIL: no PX keys captured. Closed before reaching /feed (or wrong credentials blocked login). Refusing to write empty storage.');
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

// Persist metadata.linkedin_px_storage + cookies in Skarbiec.
const now = new Date().toISOString();
const patch = {
  linkedin_px_storage: lsItems,
  linkedin_px_storage_at: now,
};
if (cookies.length) {
  patch.cookies = cookies;
  patch.cookies_updated_at = now;
  patch.cookies_minted_at = now;
  patch.cookies_stale_at = null;
}
updateAccountMetadata(acct.id, patch);
console.log(`PASS: seeded metadata.linkedin_px_storage (${lsCount} keys) + cookies (${cookies.length}) for ${acct.username}`);
