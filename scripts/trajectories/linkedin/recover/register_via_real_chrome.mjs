// One-shot LinkedIn signup via REAL Chrome (Application/Google Chrome.app),
// NOT the weles binary. Cited 2026-05-06 .work/seed-real-chrome2.log: real
// Chrome on a flagged account lands on /checkpoint/challenge — proving the
// challenge is account-state, not weles-fingerprint. Real Chrome's
// fingerprint passes PX trust at first byte, so a brand-new signup
// completes cleanly. Single-shot — no retries.
//
// Usage:
//   AGENT_DOMAIN=wisentmedia.com node scripts/trajectories/linkedin/recover/register_via_real_chrome.mjs
import { chromium } from 'playwright';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause, humanScroll } from '../../../../dist/human/mouse.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('FAIL: SUPABASE env required'); process.exit(2); }
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
// Route real Chrome through Oxylabs Mobile sticky if creds present.
// Without a proxy the local Mac IP gets silently rejected by LinkedIn at
// /signup (cited 2026-05-06 .work/reg-real-2.log: V3 token solved + injected
// twice, post-join + post-name URL both stayed at /signup).
let proxyOpt;
if (process.env.OXYLABS_MOBILE_USERNAME && process.env.OXYLABS_MOBILE_PASSWORD) {
  const sess = Math.floor(Math.random() * 9000000 + 1000000);
  proxyOpt = {
    server: 'http://pr.oxylabs.io:7777',
    username: `customer-${process.env.OXYLABS_MOBILE_USERNAME}-cc-us-sessid-${sess}`,
    password: process.env.OXYLABS_MOBILE_PASSWORD,
  };
  console.log(`[reg-real] using Oxylabs Mobile sticky=${sess}`);
}
const browser = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_BIN,
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  // Both --no-sandbox AND --disable-blink-features=AutomationControlled
  // trigger Chrome's yellow "unsupported command-line flag" warning bar,
  // which LinkedIn's risk engine detects and uses to reject signups
  // (cited 2026-05-06 screenshots .work/chrome-no-sandbox-small.jpg and
  // .work/chrome-sandbox-fixed-small.jpg). Suppress both. With
  // --enable-automation also in ignoreDefaultArgs, navigator.webdriver
  // stays false without needing --disable-blink-features.
  args: ['--disable-infobars',
    ...(existsSync(NOPECHA_EXT_DIR) ? [`--disable-extensions-except=${NOPECHA_EXT_DIR}`, `--load-extension=${NOPECHA_EXT_DIR}`] : []),
  ],
  ignoreDefaultArgs: ['--enable-automation', '--disable-breakpad', '--no-sandbox', '--disable-blink-features=AutomationControlled'],
  ...(proxyOpt ? { proxy: proxyOpt } : {}),
});
const page = browser.pages()[0] || await browser.newPage();

// Pre-configure NopeCha extension settings via service worker: enable PX
// auto-solve + inject API key. Cited nopecha-ext/background.js default
// L.perimeterx_auto_solve:!1 (false).
if (NOPECHA_KEY) {
  // Magic URL config — cited nopecha-ext/pages/setup.js. Hash format:
  // KEY|setting=value|setting=value imported by setup content script.
  const hash = `${NOPECHA_KEY}|perimeterx_auto_solve=true|perimeterx_auto_open=true|perimeterx_solve_delay=false`;
  try { await page.goto(`https://nopecha.com/setup#${encodeURIComponent(hash)}`, { waitUntil: 'domcontentloaded' }); await humanIdlePause('deliberate'); console.log(`[reg-real] NopeCha magic-URL configured (px_auto_solve=true)`); }
  catch (e) { console.log(`[reg-real] NopeCha magic-URL err: ${e.message?.slice(0,100)}`); }
}

try {
  await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await humanScroll(page, { direction: 'down', distance: 600 }).catch(() => {});
  await humanIdlePause('short');
  await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', referer: 'https://www.linkedin.com/' });
  await humanIdlePause('deliberate');

  // Humanized fill — emits real keypress/keyup/keydown events with realistic
  // timing distributions. PX scores these positively. Cited weles/src/human/
  // keyboard.ts humanFill: clicks first, then types char-by-char with delays.
  const emailLoc = page.locator('input[name="email-address"], input#email-address, input[type="email"]').first();
  await humanFill(page, emailLoc, id.email);
  await humanIdlePause('short');
  const pwLoc = page.locator('input[name="password"], input#password, input[type="password"]').first();
  await humanFill(page, pwLoc, id.password);
  await humanIdlePause('deliberate');
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
  await humanIdlePause('long');
  console.log(`[reg-real] post-join url=${page.url()}`);

  // Optional name page
  const firstIn = page.locator('input[name="first-name"], input#first-name').first();
  if (await firstIn.isVisible().catch(() => false)) {
    await humanFill(page, firstIn, id.first);
    await humanIdlePause('short');
    await humanFill(page, page.locator('input[name="last-name"], input#last-name').first(), id.last);
    await humanIdlePause('deliberate');
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
    await humanIdlePause('long');
    console.log(`[reg-real] post-name url=${page.url()}`);
  }

  // V2 modal: detect by visible "Security verification" modal text (not
  // by iframe presence, since V3 invisible iframe uses the same selector).
  // Cited 2026-05-06 .work/reg-real-humanized.log + .work/chrome-humanized-small.jpg:
  // V2 anchor iframe loads AFTER initial detection window, so use the
  // modal-text trigger then wait for V2 anchor sitekey.
  for (let i = 0; i < 30; i++) {
    const v2Visible = await page.evaluate(() => /Security verification|Let.s do a quick security check/i.test(document.body?.innerText || '')).catch(() => false);
    if (v2Visible) {
      console.log('[reg-real] V2 modal detected — finding anchor frame');
      try {
        // LinkedIn /signup V2 modal uses Google's standard reCAPTCHA
        // iframe (no captchaInternal wrapper). Walk page.frames() to find
        // the anchor frame directly. Cited 2026-05-06 register attempts:
        // captchaInternal selector timed out on /signup but anchor URL
        // pattern recaptcha/enterprise/anchor or recaptcha/api2/anchor
        // is present in page.frames().
        // Filter: V2 modal anchor has sitekey DIFFERENT from V3
        // (RECAPTCHA_SITEKEY 6LcIy_MqAA...). V3 widget is invisible
        // background, V2 is the visible "I'm not a robot" modal. Cited
        // 2026-05-06: register found anchor with k=6LcIy... (V3) and
        // clicking it timed out because that widget has no visible
        // checkbox to click. The V2 anchor uses a different sitekey
        // (e.g. 6LfmKkwrAAAAAAgHjKMj from earlier extraction).
        let anchorFrame = null;
        let v2Sitekey = null;
        // 60s window — V2 anchor iframe loads lazily after modal renders.
        for (let j = 0; j < 120; j++) {
          for (const f of page.frames()) {
            const u = f.url() || '';
            if (!/recaptcha\/(enterprise|api2)\/anchor/.test(u)) continue;
            const m = u.match(/[?&]k=([0-9A-Za-z_-]+)/);
            if (m && m[1] !== RECAPTCHA_SITEKEY) { anchorFrame = f; v2Sitekey = m[1]; break; }
          }
          if (anchorFrame) break;
          await humanIdlePause('short');
        }
        if (!anchorFrame) throw new Error(`V2 anchor frame not found (only V3 anchor present). frames=${page.frames().map(f => (f.url()||'').slice(0,80)).join('|').slice(0,400)}`);
        console.log(`[reg-real] V2 anchor sitekey=${v2Sitekey?.slice(0, 20)}... url=${anchorFrame.url().slice(0, 80)}`);
        await humanClickLocator(page, anchorFrame.locator('#recaptcha-anchor'));
        console.log('[reg-real] V2 checkbox clicked');
        await humanIdlePause('deliberate');
        // Check if auto-passed (real Chrome often auto-passes V2 with valid PX trust)
        const checked = await page.frameLocator('iframe[src*="anchor"]').first().locator('.recaptcha-checkbox').getAttribute('aria-checked').catch(() => null);
        console.log(`[reg-real] post-click aria-checked=${checked}`);
        // Image challenge: wait for bframe with grid, screenshot, classify
        // via NopeCha API, click tiles, click Verify. The dist-bundled
        // solveRecaptchaV2 doesn't work on /signup because it expects
        // captchaInternal wrapper.
        let bframe = null;
        for (let k = 0; k < 20; k++) {
          bframe = page.frames().find(f => /recaptcha\/(enterprise|api2)\/bframe/.test(f.url()));
          if (bframe) {
            const ready = await bframe.evaluate(() => !!document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical')).catch(() => false);
            if (ready) break;
          }
          await humanIdlePause('short');
        }
        if (!bframe) throw new Error('bframe never appeared after V2 click');
        const instruction = await bframe.evaluate(() => document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical')?.innerText ?? '');
        const gridSize = await bframe.evaluate(() => { const t = document.querySelector('table.rc-imageselect-table-44, table.rc-imageselect-table-33, table.rc-imageselect-table'); if (!t) return 3; return t.querySelectorAll('tr')[0]?.querySelectorAll('td').length || 3; });
        console.log(`[reg-real] V2 grid challenge: "${instruction.replace(/\n/g,' ').slice(0,60)}" ${gridSize}x${gridSize}`);
        const gridHandle = await bframe.$('div.rc-imageselect-payload, table.rc-imageselect-table-44, table.rc-imageselect-table-33, table.rc-imageselect-table');
        const gridImg = (await gridHandle.screenshot({ type: 'jpeg', quality: 90 })).toString('base64');
        // NopeCha recognition
        const npKey = process.env.NOPECHA_API_KEY;
        let positions = null;
        if (npKey) {
          const post = await (await fetch('https://api.nopecha.com/v1/recognition/recaptcha', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${npKey}` }, body: JSON.stringify({ type: 'recaptcha', task: instruction.replace(/\n/g, ' ').trim(), image_data: [gridImg], grid: `${gridSize}x${gridSize}` }) })).json();
          if (post?.data) {
            for (let p = 0; p < 30; p++) {
              await humanIdlePause('deliberate');
              const get = await (await fetch(`https://api.nopecha.com/v1/recognition/recaptcha?id=${post.data}`, { headers: { Authorization: `Basic ${npKey}` } })).json();
              if (Array.isArray(get?.data)) { positions = get.data.map((v, i) => v ? i + 1 : 0).filter(Boolean); break; }
              if (get?.error && get.error !== 14) break;
            }
          }
        }
        console.log(`[reg-real] V2 NopeCha positions=${JSON.stringify(positions)}`);
        if (positions?.length) {
          for (const pos of positions) {
            const row = Math.floor((pos - 1) / gridSize) + 1;
            const col = (pos - 1) % gridSize + 1;
            try { await humanClickLocator(page, bframe.locator(`table tr:nth-child(${row}) td:nth-child(${col})`)); } catch { /* tile may have animated away */ }
            await humanIdlePause('short');
          }
        }
        try { await humanClickLocator(page, bframe.locator('#recaptcha-verify-button')); } catch { /* verify button may have moved */ }
        console.log('[reg-real] V2 verify clicked');
        await humanIdlePause('long');
        try { await humanClickLocator(page, page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit"), button[type="submit"]').last()); } catch { /* submit button may be missing */ }
        await humanIdlePause('long');
        console.log(`[reg-real] post-V2 url=${page.url()}`);
      } catch (e) { console.log(`[reg-real] V2 handler err: ${e.message?.slice(0, 120)}`); }
      break;
    }
    await humanIdlePause('short');
  }

  // Wait for /feed or final state
  await page.waitForURL((url) => /linkedin\.com\/(feed|checkpoint\/challenge|home)/.test(url.toString())).catch(() => {});
  console.log(`[reg-real] settled url=${page.url()}`);
  console.log('[reg-real] manual step needed if /checkpoint/email-pin — solve in Chrome window then close.');
} catch (e) {
  console.log(`[reg-real] err: ${e.message?.slice(0, 200)}`);
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
const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts`, {
  method: 'POST',
  headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ platform: 'linkedin', username: id.handle, display_name: `${id.first} ${id.last}`, is_active: true, metadata }),
});
if (!insertRes.ok) { console.error(`FAIL: INSERT returned ${insertRes.status}: ${(await insertRes.text()).slice(0, 200)}`); process.exit(1); }
const inserted = await insertRes.json();
console.log(`PASS: registered ${id.handle} (id=${inserted[0]?.id?.slice(0, 8)}) with li_at + ${Object.keys(lsItems).length} PX keys`);
