// One-shot LinkedIn signup via REAL Chrome (Application/Google Chrome.app),
// NOT the weles binary. Cited 2026-05-06 .work/seed-real-chrome2.log: real
// Chrome on a flagged account lands on /checkpoint/challenge — proving the
// challenge is account-state, not weles-fingerprint. Real Chrome's
// fingerprint passes PX trust at first byte, so a brand-new signup
// completes cleanly. Single-shot — no retries.
//
// Usage:
//   AGENT_DOMAIN=wisentmedia.com node src/trajectories/linkedin/recover/register_via_real_chrome.mjs
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CaptchaSolver } from '../../../../../dist/captcha/solver.js';
import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanScroll } from '../../../../../dist/human/mouse.js';
import { pageSettled } from '../../../../_shared/page/settled.mjs';
import { readScopedProxy } from '../../../../_shared/scoped-secrets.mjs';
import { launchGenuineChrome } from '../../../../browser/real_chrome.mjs';
import { accountItemFor, writeAccount } from '../../../_shared/skarbiec/accounts.mjs';

const AGENT_DOMAIN = process.env.AGENT_DOMAIN ?? 'wisentmedia.com';
const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) { console.error(`FAIL: chrome binary missing at ${CHROME_BIN}`); process.exit(2); }
const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';

function genIdentity() {
  const F = 'Garry,Katie,Logan,Maya,Owen,Riley,Sage,Tess,Wes,Zane,Avery,Bryn,Coral,Dax'.split(',');
  const L = 'Koepp,Bayer,Pratt,Quinn,Reeves,Stone,Vega,West,Yates,Cole,Hart,Lane'.split(',');
  const first = F[Math.floor(Math.random() * F.length)];
  const last = L[Math.floor(Math.random() * L.length)];
  const handle = `${first.toLowerCase()}${last.toLowerCase()}${Math.floor(Math.random() * 9000 + 1000)}`;
  const password = randomBytes(9).toString('base64').replace(/[+/=]/g, '') + '!A1';
  const email = `${handle}@${AGENT_DOMAIN}`;
  return { first, last, handle, email, password };
}

const id = genIdentity();
console.log(`[reg-real] identity: ${id.email} / ${id.first} ${id.last}`);

const NOPECHA_EXT_DIR = process.env.NOPECHA_EXT_DIR || `${process.env.HOME}/weles/var/nopecha-ext`;
const NOPECHA_KEY = process.env.NOPECHA_API_KEY || '';
const userDataDir = mkdtempSync(join(tmpdir(), 'reg-real-'));
// This flow owns a dedicated Oxylabs Mobile grant and cannot run without it.
const oxylabsMobile = readScopedProxy('oxylabsMobile');
const proxySession = Math.floor(Math.random() * Number('9000000') + Number('1000000'));
const proxyOpt = {
  server: 'http://pr.oxylabs.io:7777',
  username: `customer-${oxylabsMobile.username}-cc-us-sessid-${proxySession}`,
  password: oxylabsMobile.password,
};
console.log(`[reg-real] using Oxylabs Mobile sticky=${proxySession}`);
// The launch itself lives in the reviewed browser boundary, with the exact
// argument set this flow was verified with: Chrome's yellow "unsupported
// command-line flag" bar is what LinkedIn's risk engine reads to reject a
// signup (2026-05-06 screenshots), so the flags that raise it are removed
// from Chrome's defaults rather than added.
const browser = await launchGenuineChrome({
  userDataDir,
  executablePath: CHROME_BIN,
  proxy: proxyOpt,
  extensionDir: NOPECHA_EXT_DIR,
});
const page = browser.pages()[0] || await browser.newPage();

// Pre-configure NopeCha extension settings via service worker: enable PX
// auto-solve + inject API key. Cited nopecha-ext/background.js default
// L.perimeterx_auto_solve:!1 (false).
if (NOPECHA_KEY) {
  // Magic URL config — cited nopecha-ext/pages/setup.js. Hash format:
  // KEY|setting=value|setting=value imported by setup content script.
  const hash = `${NOPECHA_KEY}|perimeterx_auto_solve=true|perimeterx_auto_open=true|perimeterx_solve_delay=false`;
  try { await page.goto(`https://nopecha.com/setup#${encodeURIComponent(hash)}`, { waitUntil: 'domcontentloaded' }); await pageSettled(page); console.log(`[reg-real] NopeCha magic-URL configured (px_auto_solve=true)`); }
  catch (e) { console.log(`[reg-real] NopeCha magic-URL err: ${e.message}`); }
}

try {
  await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded' });
  await pageSettled(page);
  await humanScroll(page, 600);
  await pageSettled(page);
  await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', referer: 'https://www.linkedin.com/' });
  await pageSettled(page);

  // Humanized fill — emits real keypress/keyup/keydown events with realistic
  // timing distributions. PX scores these positively. Cited weles/src/human/
  // keyboard.ts humanFill: clicks first, then types char-by-char with delays.
  const emailLoc = page.locator('input[name="email-address"], input#email-address, input[type="email"]').first();
  await humanFill(page, emailLoc, id.email);
  await pageSettled(page);
  const pwLoc = page.locator('input[name="password"], input#password, input[type="password"]').first();
  await humanFill(page, pwLoc, id.password);
  await pageSettled(page);
  console.log('[reg-real] humanized email + password fill');

  // V3 invisible reCAPTCHA — solve + inject before Agree & Join
  const solver = new CaptchaSolver();
  const v3 = await solver.solveRecaptchaV3(RECAPTCHA_SITEKEY, 'https://www.linkedin.com/signup', 'signup');
  if (v3) {
    await page.evaluate((tk) => {
      for (const f of document.querySelectorAll('textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]')) {
        const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(f, tk);
        f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, v3);
    console.log(`[reg-real] V3 token injected (${v3.length}ch)`);
  }

  // Click Agree & Join
  await humanClickLocator(page, page.locator('button:has-text("Agree & Join"), button:has-text("Continue"), button[type="submit"]').first());
  await pageSettled(page);
  console.log(`[reg-real] post-join url=${page.url()}`);

  // Optional name page
  const firstIn = page.locator('input[name="first-name"], input#first-name').first();
  if (await firstIn.isVisible().catch(() => false)) {
    await humanFill(page, firstIn, id.first);
    await pageSettled(page);
    await humanFill(page, page.locator('input[name="last-name"], input#last-name').first(), id.last);
    await pageSettled(page);
    const v3b = await solver.solveRecaptchaV3(RECAPTCHA_SITEKEY, page.url(), 'signup');
    if (v3b) {
      await page.evaluate((tk) => {
        for (const f of document.querySelectorAll('textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]')) {
          const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(f, tk);
          f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, v3b);
    }
    await humanClickLocator(page, page.locator('button:has-text("Continue"), button[type="submit"]').first());
    await pageSettled(page);
    console.log(`[reg-real] post-name url=${page.url()}`);
  }

  // V2 modal: detect by visible "Security verification" modal text (not
  // by iframe presence, since V3 invisible iframe uses the same selector),
  // read once the page has settled after the join click.
  await pageSettled(page);
  const v2Visible = await page.evaluate(() => /Security verification|Let.s do a quick security check/i.test(document.body?.innerText || ''));
  if (v2Visible) {
    console.log('[reg-real] V2 modal detected — finding anchor frame');
    try {
      // LinkedIn /signup V2 modal uses Google's standard reCAPTCHA iframe (no
      // captchaInternal wrapper). The V2 anchor carries a sitekey different
      // from the invisible V3 widget's (RECAPTCHA_SITEKEY); it loads lazily
      // after the modal renders, so it is taken from the frame that navigates
      // to it.
      const isV2Anchor = (f) => {
        const m = (f.url() || '').match(/recaptcha\/(?:enterprise|api2)\/anchor.*[?&]k=([0-9A-Za-z_-]+)/);
        return Boolean(m && m[1] !== RECAPTCHA_SITEKEY);
      };
      let anchorFrame = page.frames().find(isV2Anchor) ?? null;
      if (!anchorFrame) {
        const { promise, resolve } = Promise.withResolvers();
        const onNavigated = (f) => { if (isV2Anchor(f)) resolve(f); };
        page.on('framenavigated', onNavigated);
        anchorFrame = await promise;
        page.off('framenavigated', onNavigated);
      }
      await anchorFrame.waitForLoadState('load');
      const v2Sitekey = anchorFrame.url().match(/[?&]k=([0-9A-Za-z_-]+)/)?.[1];
      console.log(`[reg-real] V2 anchor sitekey=${v2Sitekey?.slice(0, 20)}... url=${anchorFrame.url()}`);
      await humanClickLocator(page, anchorFrame.locator('#recaptcha-anchor'));
      console.log('[reg-real] V2 checkbox clicked');
      // Either the checkbox passes on its own (real Chrome often auto-passes
      // V2 with valid PX trust) or Google opens the image challenge.
      const challenge = page.frameLocator('iframe[src*="bframe"]').first().locator('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical').first();
      await Promise.any([
        anchorFrame.locator('.recaptcha-checkbox[aria-checked="true"]').waitFor({ state: 'attached' }),
        challenge.waitFor({ state: 'visible' }),
      ]);
      const checked = await anchorFrame.locator('.recaptcha-checkbox').getAttribute('aria-checked');
      console.log(`[reg-real] post-click aria-checked=${checked}`);
      if (checked !== 'true') {
        // Image challenge: screenshot the grid, classify via NopeCha, click
        // tiles, click Verify. The dist-bundled solveRecaptchaV2 doesn't work
        // on /signup because it expects the captchaInternal wrapper.
        const bframe = page.frames().find(f => /recaptcha\/(enterprise|api2)\/bframe/.test(f.url()));
        if (!bframe) throw new Error('bframe never appeared after V2 click');
        const instruction = await bframe.evaluate(() => document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical')?.innerText ?? '');
        const gridSize = await bframe.evaluate(() => { const t = document.querySelector('table.rc-imageselect-table-44, table.rc-imageselect-table-33, table.rc-imageselect-table'); if (!t) return 3; return t.querySelectorAll('tr')[0]?.querySelectorAll('td').length || 3; });
        console.log(`[reg-real] V2 grid challenge: "${instruction.replace(/\n/g,' ')}" ${gridSize}x${gridSize}`);
        const gridHandle = await bframe.$('div.rc-imageselect-payload, table.rc-imageselect-table-44, table.rc-imageselect-table-33, table.rc-imageselect-table');
        const gridImg = (await gridHandle.screenshot({ type: 'jpeg', quality: 90 })).toString('base64');
        // NopeCha recognition: one result read; the API has no push or blocking answer.
        const npKey = process.env.NOPECHA_API_KEY;
        let positions = null;
        if (npKey) {
          const post = await (await fetch('https://api.nopecha.com/v1/recognition/recaptcha', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${npKey}` }, body: JSON.stringify({ type: 'recaptcha', task: instruction.replace(/\n/g, ' ').trim(), image_data: [gridImg], grid: `${gridSize}x${gridSize}` }) })).json();
          if (post?.data) {
            const get = await (await fetch(`https://api.nopecha.com/v1/recognition/recaptcha?id=${post.data}`, { headers: { Authorization: `Basic ${npKey}` } })).json();
            if (Array.isArray(get?.data)) positions = get.data.map((v, i) => v ? i + 1 : 0).filter(Boolean);
            else if (get?.error === 14) console.log(`[reg-real] captcha_nopecha_processing: job ${post.data} has no result yet`);
          }
        }
        console.log(`[reg-real] V2 NopeCha positions=${JSON.stringify(positions)}`);
        if (positions?.length) {
          for (const pos of positions) {
            const row = Math.floor((pos - 1) / gridSize) + 1;
            const col = (pos - 1) % gridSize + 1;
            try { await humanClickLocator(page, bframe.locator(`table tr:nth-child(${row}) td:nth-child(${col})`)); } catch { /* tile may have animated away */ }
            await pageSettled(page);
          }
        }
        try { await humanClickLocator(page, bframe.locator('#recaptcha-verify-button')); } catch { /* verify button may have moved */ }
        console.log('[reg-real] V2 verify clicked');
        await pageSettled(page);
      }
      try { await humanClickLocator(page, page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit"), button[type="submit"]').last()); } catch { /* submit button may be missing */ }
      await pageSettled(page);
      console.log(`[reg-real] post-V2 url=${page.url()}`);
    } catch (e) { console.log(`[reg-real] V2 handler err: ${e.message}`); }
  }

  // Wait for /feed or final state
  await page.waitForURL((url) => /linkedin\.com\/(feed|checkpoint\/challenge|home)/.test(url.toString())).catch(() => {});
  console.log(`[reg-real] settled url=${page.url()}`);
  console.log('[reg-real] manual step needed if /checkpoint/email-pin — solve in Chrome window then close.');
} catch (e) {
  console.log(`[reg-real] err: ${e.message}`);
}

console.log('[reg-real] window is yours. Close Chrome to capture session state.');
await new Promise((resolve) => {
  browser.on('close', () => resolve());
  process.on('SIGINT', () => resolve());
  process.on('SIGTERM', () => resolve());
});

// Capture localStorage PX keys + cookies
const PX_RE = /^(PXdOjV695v_|_pxvid|pxsid|_?px_|rc::|_grecaptcha)/;
let lsItems = {};
try {
  let scrapePage = browser.pages().find((p) => p.url().includes('linkedin.com')) ?? browser.pages()[0];
  if (!scrapePage || scrapePage.isClosed()) scrapePage = await browser.newPage();
  if (!scrapePage.url().includes('linkedin.com')) await scrapePage.goto('https://www.linkedin.com/feed/').catch(() => {});
  lsItems = await scrapePage.evaluate((reSrc) => {
    const re = new RegExp(reSrc); const out = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && re.test(k)) out[k] = localStorage.getItem(k); } } catch {}
    return out;
  }, PX_RE.source).catch(() => ({}));
} catch {}

let cookies = [];
try { cookies = (await browser.cookies()).filter((c) => /linkedin\.com$/.test((c.domain ?? '').replace(/^\./, ''))); } catch {}
const liAt = cookies.find((c) => c.name === 'li_at' && c.value);
console.log(`[reg-real] captured ${Object.keys(lsItems).length} PX keys, ${cookies.length} cookies, li_at=${!!liAt}`);
await browser.close().catch(() => {});

if (!liAt) { console.error('FAIL: no li_at cookie — registration did not complete'); process.exit(1); }

const now = new Date().toISOString();
const metadata = {
  email: id.email, password: id.password, status: 'created',
  created_via: 'real-chrome-signup',
  cookies, cookies_minted_at: now, cookies_updated_at: now, cookies_minted_persona: 'real-chrome-macos',
  linkedin_px_storage: lsItems, linkedin_px_storage_at: now,
};
const item = accountItemFor('linkedin', id.handle);
writeAccount({
  id: item,
  platform: 'linkedin',
  username: id.handle,
  password: id.password,
  metadata,
  displayName: `${id.first} ${id.last}`,
});
console.log(`PASS: registered ${id.handle} in Skarbiec item=${item} with li_at + ${Object.keys(lsItems).length} PX keys`);
