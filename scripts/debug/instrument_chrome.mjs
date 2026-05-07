// Human-reference instrumentation runner for the property-trap diff.
//
// The weles side is already covered by WELES_INSTRUMENT=1 (any trajectory):
//   WELES_INSTRUMENT=1 node scripts/trajectories/<...>.mjs
//   -> writes .work/inst/<label>_<ts>.json (full property-trap dump)
//
// This script is the missing chrome side. It launches real Chrome with the
// SAME init script (dist/diagnostics/property_trap.js) and same per-frame
// polling cadence WSession uses, so the JSON output format is identical and
// can be diffed directly against any weles WELES_INSTRUMENT=1 dump.
//
// Usage:
//   PLATFORM=reddit USERNAME=<dbusername> TARGET_URL=<url> node instrument_chrome.mjs
//   PLATFORM=tiktok TARGET_URL=https://www.tiktok.com/signup/... node instrument_chrome.mjs
//
// Output: .work/inst/chrome_<platform>_<ts>.json (matches weles format)

import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..');
const TRAP_PATH = join(WELES_ROOT, 'dist', 'diagnostics', 'property_trap.js');
if (!existsSync(TRAP_PATH)) throw new Error(`property_trap.js not built at ${TRAP_PATH} — run "npm run build" first`);
const TRAP_SCRIPT = readFileSync(TRAP_PATH, 'utf-8');

const PLATFORM = (process.env.PLATFORM || 'reddit').toLowerCase();
const TARGET_URL = process.env.TARGET_URL || (
  PLATFORM === 'reddit' ? 'https://old.reddit.com/r/CasualConversation/new/' :
  PLATFORM === 'tiktok' ? 'https://www.tiktok.com/signup/phone-or-email/email' :
  ''
);
if (!TARGET_URL) throw new Error('TARGET_URL env required (no default for platform=' + PLATFORM + ')');

const USERNAME = process.env.USERNAME || process.env.REDDIT_USERNAME || '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) throw new Error(`chrome binary missing: ${CHROME_BIN}`);

const OUT_DIR = join(WELES_ROOT, '.work', 'inst');
mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(OUT_DIR, `chrome_${PLATFORM}_${ts}.json`);
console.log(`[inst-chrome] platform=${PLATFORM} target=${TARGET_URL}`);
console.log(`[inst-chrome] output -> ${OUT}`);

const userDataDir = `/tmp/inst-chrome-${PLATFORM}-${Date.now()}`;
const browser = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_BIN,
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars', '--lang=en-US'],
  ignoreDefaultArgs: ['--enable-automation', '--disable-breakpad'],
});

if (USERNAME) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('USERNAME set but SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing');
  const acctRes = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?platform=eq.${PLATFORM}&username=eq.${encodeURIComponent(USERNAME)}&select=metadata`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  const rows = await acctRes.json();
  if (!rows?.[0]) throw new Error(`no DB row for platform=${PLATFORM} username=${USERNAME}`);
  const cookies = (rows[0].metadata?.cookies ?? []).filter(c => c?.name && c?.value && c?.domain).map(c => ({ ...c, path: c.path || '/' }));
  if (cookies.length) await browser.addCookies(cookies);
  console.log(`[inst-chrome] injected ${cookies.length} cookies`);
}

await browser.addInitScript(TRAP_SCRIPT);

const page = browser.pages()[0] || await browser.newPage();
page.on('pageerror', (e) => console.log(`[inst-chrome] pageerror: ${String(e).slice(0, 200)}`));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(`[inst-chrome] nav -> ${f.url().slice(0, 100)}`); });

console.log(`[inst-chrome] navigating to ${TARGET_URL}`);
const t0 = Date.now();
try { await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
catch (e) { console.log(`[inst-chrome] goto failed: ${String(e).slice(0, 200)}`); }

// Periodic per-frame poll — same shape WSession uses (5s cadence, accumulates
// per-URL with longest-log-wins). Writes JSON every poll so a Ctrl+C never
// loses the last 5s of data.
const accum = new Map();
const reqs = [];
const platformHostFilter = new RegExp(`${PLATFORM}\\.com|reddit\\.com|tiktok\\.com|google\\.com|cloudflare\\.com|arkoselabs\\.com|hcaptcha\\.com|recaptcha`, 'i');
browser.on('request', (req) => {
  try { const u = req.url(); if (!platformHostFilter.test(u)) return; let post = ''; try { post = req.postData()?.slice(0, 4000) || ''; } catch {} reqs.push({ t: Date.now(), phase: 'req', method: req.method(), url: u, headers: req.headers(), postData: post }); } catch {}
});
browser.on('response', async (resp) => {
  try { const u = resp.url(); if (!platformHostFilter.test(u)) return; let body = ''; try { body = (await resp.text()).slice(0, 8000); } catch {} reqs.push({ t: Date.now(), phase: 'res', status: resp.status(), url: u, headers: resp.headers(), body }); } catch {}
});

const interval = setInterval(async () => {
  try {
    for (const p of browser.pages()) {
      for (const f of p.frames()) {
        try {
          const j = await f.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"');
          const log = JSON.parse(j);
          if (!log.length) continue;
          const url = f.url();
          const prev = accum.get(url);
          if (!prev || log.length > prev.log.length) accum.set(url, { url, log });
        } catch {}
      }
    }
    writeFileSync(OUT, JSON.stringify({
      which: 'chrome',
      platform: PLATFORM,
      target: TARGET_URL,
      username: USERNAME || null,
      startedAt: new Date(t0).toISOString(),
      accesses: [...accum.values()],
      requests: reqs,
    }, null, 2));
  } catch {}
}, 5000);

// Optional: drive the LinkedIn edit-intro form fill + save automatically
// (when DRIVE_LINKEDIN_EDIT_INTRO=1 is set). Captures the network + property
// trap of a Playwright-controlled real Chrome doing the same flow as
// linkedin/actions/edit_profile.mjs, so we can diff to find why the save
// mutation POST never fires from the trajectory.
if (process.env.DRIVE_LINKEDIN_EDIT_INTRO === '1' && PLATFORM === 'linkedin') {
  console.log('[inst-chrome] DRIVE_LINKEDIN_EDIT_INTRO=1 — driving form fill');
  await page.waitForTimeout(4000);
  try {
    const fnIn = page.getByLabel('First name', { exact: false }).filter({ visible: true }).first();
    const lnIn = page.getByLabel('Last name', { exact: false }).filter({ visible: true }).first();
    if (await fnIn.count()) {
      await fnIn.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(process.env.DRIVE_FIRST_NAME || 'Anya', { delay: 40 });
      console.log('[inst-chrome] typed first name');
    } else { console.log('[inst-chrome] first-name locator missing'); }
    if (await lnIn.count()) {
      await lnIn.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(process.env.DRIVE_LAST_NAME || 'Sharma', { delay: 40 });
      console.log('[inst-chrome] typed last name');
    } else { console.log('[inst-chrome] last-name locator missing'); }
    // Try Enter-on-form first. If that doesn't fire a save mutation,
    // also try clicking the Save button. Both paths' network shapes
    // recorded for diff.
    if (await lnIn.count()) {
      console.log('[inst-chrome] pressing Enter while focused in last-name');
      await lnIn.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }
    await page.keyboard.press('Tab');
    await page.waitForTimeout(800);
    const saveBtn = page.locator('button:has-text("Save"):not([disabled]):not([aria-disabled="true"])').filter({ visible: true }).last();
    if (await saveBtn.count()) {
      console.log('[inst-chrome] clicking save (humanlike: bbox + mouse.click)');
      const box = await saveBtn.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x - 30, y - 5);
        await page.waitForTimeout(120);
        await page.mouse.move(x, y, { steps: 10 });
        await page.waitForTimeout(80);
        await page.mouse.down();
        await page.waitForTimeout(60);
        await page.mouse.up();
      } else {
        await saveBtn.click();
      }
      await page.waitForTimeout(8000);
      const final = page.url();
      console.log(`[inst-chrome] post-save url=${final}`);
    } else { console.log('[inst-chrome] save button missing'); }
  } catch (e) { console.log(`[inst-chrome] drive err: ${String(e).slice(0, 200)}`); }
  console.log('[inst-chrome] auto-drive complete; closing in 3s for capture');
  await page.waitForTimeout(3000);
  await browser.close().catch(() => {});
} else {
  console.log(`[inst-chrome] window is yours — drive the flow, then Ctrl+C in terminal or close browser to finalize.`);
  await new Promise((resolve) => {
    let resolved = false;
    const done = (why) => { if (resolved) return; resolved = true; console.log(`[inst-chrome] stopping: ${why}`); resolve(); };
    page.on('close', () => done('page closed'));
    browser.on('close', () => done('browser closed'));
    process.on('SIGINT', () => done('SIGINT'));
    process.on('SIGTERM', () => done('SIGTERM'));
  });
}

clearInterval(interval);
// Final flush before close.
try {
  for (const p of browser.pages()) {
    for (const f of p.frames()) {
      try {
        const j = await f.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"');
        const log = JSON.parse(j);
        if (!log.length) continue;
        const url = f.url();
        const prev = accum.get(url);
        if (!prev || log.length > prev.log.length) accum.set(url, { url, log });
      } catch {}
    }
  }
} catch {}
writeFileSync(OUT, JSON.stringify({
  which: 'chrome',
  platform: PLATFORM,
  target: TARGET_URL,
  username: USERNAME || null,
  startedAt: new Date(t0).toISOString(),
  endedAt: new Date().toISOString(),
  accesses: [...accum.values()],
  requests: reqs,
}, null, 2));
console.log(`[inst-chrome] done — wrote ${[...accum.values()].reduce((n, a) => n + a.log.length, 0)} access events across ${accum.size} frames + ${reqs.length} network entries to ${OUT}`);

try { await browser.close(); } catch {}
process.exit(0);
