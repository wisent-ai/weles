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
import { humanIdlePause } from '../../dist/human/mouse.js';
import { runRecordingsDir } from '../../dist/session/run-recordings.js';

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
const SUPABASE_URL = process.env.WELES_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.WELES_SUPABASE_SERVICE_ROLE_KEY ?? '';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) throw new Error(`chrome binary missing: ${CHROME_BIN}`);

const hasRunId = Boolean(process.env.ACTION_LOG_ID || process.env.WELES_RUN_ID);
const OUT_DIR = hasRunId ? runRecordingsDir('real_chrome', 'inst') : join(WELES_ROOT, '.work', 'inst');
mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(OUT_DIR, `chrome_${PLATFORM}_${ts}.json`);
console.log(`[inst-chrome] platform=${PLATFORM} target=${TARGET_URL}`);
console.log(`[inst-chrome] output -> ${OUT}`);
writeFileSync(join(OUT_DIR, 'real_chrome_session.json'), JSON.stringify({
  kind: 'instrument_chrome',
  run_id: process.env.ACTION_LOG_ID || process.env.WELES_RUN_ID || null,
  action: process.env.ACTION || null,
  platform: PLATFORM,
  target_url: TARGET_URL,
  browser_binary: CHROME_BIN,
  output_json: OUT,
  launched_at: new Date().toISOString(),
}, null, 2));

const userDataDir = `/tmp/inst-chrome-${PLATFORM}-${Date.now()}`;
const PROXY_URL = process.env.PROXY_URL || '';
let proxyOpt;
if (PROXY_URL) {
  const u = new URL(PROXY_URL);
  proxyOpt = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  console.log(`[inst-chrome] proxy=${proxyOpt.server} user=${proxyOpt.username.slice(0, 12)}...`);
}
const browser = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_BIN,
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  ...(hasRunId ? { recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } } } : {}),
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars', '--lang=en-US'],
  ignoreDefaultArgs: ['--enable-automation', '--disable-breakpad'],
  ...(proxyOpt ? { proxy: proxyOpt } : {}),
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
          const j = await f.evaluate('(()=>{var a=globalThis[Symbol.for("weles.inst")];return a?a.flush():"[]"})()');  // allow-raw-playwright: instrumentation flush
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
      run_id: process.env.ACTION_LOG_ID || process.env.WELES_RUN_ID || null,
      action: process.env.ACTION || null,
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
  console.log('[inst-chrome] DRIVE_LINKEDIN_EDIT_INTRO=1 — driving form fill via weles humanized atoms');
  // Use weles humanized atoms so the apples-to-apples comparison vs the
  // edit_profile trajectory uses identical event semantics. Plain
  // page.keyboard.type() / locator.click() produce different timing
  // signatures than weles humanFill / humanClickLocator.
  const { humanType, humanFill } = await import(`${WELES_ROOT}/dist/human/keyboard.js`);
  const { humanClickLocator, humanIdlePause } = await import(`${WELES_ROOT}/dist/human/mouse.js`);
  await humanIdlePause('deliberate');
  try {
    const fnIn = page.getByLabel('First name', { exact: false }).filter({ visible: true }).first();
    const lnIn = page.getByLabel('Last name', { exact: false }).filter({ visible: true }).first();
    if (await fnIn.count()) {
      await humanClickLocator(page, fnIn);
      await fnIn.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await humanType(page, process.env.DRIVE_FIRST_NAME || 'Anya');
      console.log('[inst-chrome] typed first name (humanized)');
    } else { console.log('[inst-chrome] first-name locator missing'); }
    await humanIdlePause('short');
    if (await lnIn.count()) {
      await humanClickLocator(page, lnIn);
      await lnIn.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await humanType(page, process.env.DRIVE_LAST_NAME || 'Sharma');
      console.log('[inst-chrome] typed last name (humanized)');
    } else { console.log('[inst-chrome] last-name locator missing'); }
    await humanIdlePause('deliberate');
    // Wait for React hydration to complete before attempting save —
    // RSC hydration of the form's onClick can take 4-6s after navigate.
    // Save button being VISIBLE doesn't mean its handler is attached.
    console.log('[inst-chrome] waiting 6s for hydration');
    await humanIdlePause('long');
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
    // Iterate save strategies in-place IN THE SAME SESSION instead of
    // closing the browser between attempts. After each strategy, watch
    // network for the save mutation; if it fires, we're done.
    let mutationFired = false;
    const watchMutation = (label) => page.waitForResponse(
      (r) => r.request().method() === 'POST' && /firstName|lastName|profileEdit|EditIntro/i.test((r.request().postData() || '') + r.url())
    ).then((r) => { console.log(`[inst-chrome:${label}] MUTATION FIRED ${r.status()} ${r.url().slice(0, 120)}`); mutationFired = true; }).catch(() => {});
    const reInit = async (label) => {
      // Re-open the modal so the React form is in a fresh state. Saving in
      // the same modal twice may be blocked by LinkedIn's "no-changes"
      // check; navigating restores the form to current persisted values.
      console.log(`[inst-chrome:${label}] re-opening modal`);
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanIdlePause('deliberate');
      const fn = page.getByLabel('First name', { exact: false }).filter({ visible: true }).first();
      const ln = page.getByLabel('Last name', { exact: false }).filter({ visible: true }).first();
      if (await fn.count()) { await humanClickLocator(page, fn); await fn.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await humanType(page, process.env.DRIVE_FIRST_NAME || 'Anya'); }
      if (await ln.count()) { await humanClickLocator(page, ln); await ln.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await humanType(page, process.env.DRIVE_LAST_NAME || 'Sharma'); }
      await humanIdlePause('deliberate');
    };
    const saveBtnSel = 'button:has-text("Save"):not([disabled]):not([aria-disabled="true"])';
    // Strategy 1: humanClickLocator on visible Save (trajectory's path)
    if (!mutationFired) {
      const w = watchMutation('strat1-humanClick');
      const sb = page.locator(saveBtnSel).filter({ visible: true }).last();
      if (await sb.count()) { await humanClickLocator(page, sb); await Promise.race([w, page.waitForTimeout(6000)]); }  // allow-raw-playwright: Promise.race deadline
    }
    // Strategy 2: focus then Enter (form Enter-submit)
    if (!mutationFired) {
      await reInit('strat2-enter');
      const w = watchMutation('strat2-enter');
      await page.keyboard.press('Enter');
      await Promise.race([w, page.waitForTimeout(5000)]);  // allow-raw-playwright: Promise.race deadline
    }
    // Strategy 3: page.mouse coordinate click on Save button bbox (trusted)
    if (!mutationFired) {
      await reInit('strat3-mouse-coord');
      const w = watchMutation('strat3-mouse-coord');
      const sb = page.locator(saveBtnSel).filter({ visible: true }).last();
      const box = await sb.boundingBox().catch(() => null);
      if (box) { await page.mouse.click(box.x + box.width/2, box.y + box.height/2); }
      await Promise.race([w, page.waitForTimeout(5000)]);  // allow-raw-playwright: Promise.race deadline
    }
    // Strategy 4: dispatchEvent (synthetic - last resort)
    if (!mutationFired) {
      await reInit('strat4-dispatch');
      const w = watchMutation('strat4-dispatch');
      const sb = page.locator(saveBtnSel).filter({ visible: true }).last();
      if (await sb.count()) { await sb.dispatchEvent('click'); }
      await Promise.race([w, page.waitForTimeout(5000)]);  // allow-raw-playwright: Promise.race deadline
    }
    console.log(`[inst-chrome] mutation fired across all strategies: ${mutationFired}`);
    const final = page.url();
    console.log(`[inst-chrome] final url=${final}`);
  } catch (e) { console.log(`[inst-chrome] drive err: ${String(e).slice(0, 200)}`); }
  console.log('[inst-chrome] auto-drive complete; closing in 3s for capture');
  await humanIdlePause('deliberate');
  await browser.close().catch(() => {});
} else {
  console.log(`[inst-chrome] window is yours — drive the flow, then Ctrl+C in terminal or close browser to finalize.`);
  // Optional self-terminating deadline for automated captures. paired/run.mjs
  // sets this so chrome reference captures end without an external killer.
  const CAPTURE_MS = parseInt(process.env.CAPTURE_DURATION_MS || '0', 10);
  await new Promise((resolve) => {
    let resolved = false;
    const done = (why) => { if (resolved) return; resolved = true; console.log(`[inst-chrome] stopping: ${why}`); resolve(); };
    page.on('close', () => done('page closed'));
    browser.on('close', () => done('browser closed'));
    process.on('SIGINT', () => done('SIGINT'));
    process.on('SIGTERM', () => done('SIGTERM'));
    if (CAPTURE_MS > 0) {
      const t = setTimeout(() => done(`CAPTURE_DURATION_MS=${CAPTURE_MS} elapsed`), CAPTURE_MS);
      // Self-exit signal — script is choosing to end its own capture window, not killing an external task.
      t.unref?.();
    }
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
  run_id: process.env.ACTION_LOG_ID || process.env.WELES_RUN_ID || null,
  action: process.env.ACTION || null,
  startedAt: new Date(t0).toISOString(),
  endedAt: new Date().toISOString(),
  accesses: [...accum.values()],
  requests: reqs,
}, null, 2));
console.log(`[inst-chrome] done — wrote ${[...accum.values()].reduce((n, a) => n + a.log.length, 0)} access events across ${accum.size} frames + ${reqs.length} network entries to ${OUT}`);

try { await browser.close(); } catch {}
process.exit(0);
