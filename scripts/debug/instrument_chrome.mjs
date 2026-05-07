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
    // Wait for React hydration to complete before attempting save —
    // RSC hydration of the form's onClick can take 4-6s after navigate.
    // Save button being VISIBLE doesn't mean its handler is attached.
    console.log('[inst-chrome] waiting 6s for hydration');
    await page.waitForTimeout(6000);
    // Check if there's a button with explicit form-action attribute
    // or a hidden submit input that the visible Save proxies to.
    const saveDiag = await page.evaluate(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll('button, input[type="submit"]'))) {
        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0;
        const txt = (el.textContent || el.value || '').trim().slice(0, 30);
        if (!/save|submit/i.test(txt) && !/save|submit/i.test(el.getAttribute('aria-label') || '')) continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          text: txt,
          aria: el.getAttribute('aria-label') || '',
          type: el.getAttribute('type') || '',
          formaction: el.getAttribute('formaction') || '',
          formId: el.closest('form')?.id || '(no form)',
          formAction: el.closest('form')?.action || '',
          visible,
        });
      }
      return out;
    }).catch(() => []);
    console.log(`[inst-chrome] save candidates after hydration: ${JSON.stringify(saveDiag)}`);
    // 2026-05-07 DOM enumeration found the visible "Save" button is
    // type="button" (decorative proxy, no form ancestor), and the actual
    // save trigger is a HIDDEN button[type="submit"] with formAction
    // pointing at the edit URL. Click the hidden submit directly via JS.
    const submitResult = await page.evaluate(() => {
      const submit = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]')).find(b => b.getAttribute('formaction') || b.closest('form')?.action || /\/edit\//.test(b.getAttribute('formaction') || '') || (b.tagName === 'BUTTON' && /submit/i.test(b.textContent || '')));
      if (!submit) return 'no-hidden-submit-found';
      submit.click();
      return `clicked-hidden-submit text="${(submit.textContent || '').trim().slice(0, 30)}" formaction="${submit.getAttribute('formaction') || ''}"`;
    }).catch((e) => `err:${String(e).slice(0, 60)}`);
    console.log(`[inst-chrome] hidden submit dispatch: ${submitResult}`);
    await page.waitForTimeout(8000);
    const final = page.url();
    console.log(`[inst-chrome] post-save url=${final}`);
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
