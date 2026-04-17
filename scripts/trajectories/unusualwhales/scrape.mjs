// Scrape unusualwhales.com ticker data using cached session cookies.
// Usage: node scripts/trajectories/unusualwhales/scrape.mjs --ticker ORCL --page overview
//   pages: overview | flow | darkpool | gex
//   optional: --screenshot /path/to/out.png
// Outputs JSON to stdout on success, non-zero exit on failure.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Redirect all console.log to stderr so stdout is pure JSON output.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('./_envload.mjs');
const { persistContext } = await import('./_persist.mjs');

loadEnv();

// Parse args
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const ticker = (args.ticker || '').toUpperCase();
const page = args.page || 'overview';
const screenshotPath = args.screenshot;
if (!ticker) {
  console.error('FAIL: --ticker required');
  process.exit(1);
}

const PAGE_URLS = {
  overview: (t) => `https://unusualwhales.com/stock/${t}/overview`,
  flow: (t) => `https://unusualwhales.com/stock/${t}/flow-overview`,
  darkpool: (t) => `https://unusualwhales.com/stock/${t}/dark-pool`,
  greeks: (t) => `https://unusualwhales.com/stock/${t}/greeks`,
  chains: (t) => `https://unusualwhales.com/stock/${t}/option-chains`,
};
if (!PAGE_URLS[page]) {
  console.error(`FAIL: unknown page '${page}', must be one of: ${Object.keys(PAGE_URLS).join(', ')}`);
  process.exit(1);
}

const email = process.env.UW_EMAIL;
const password = process.env.UW_PASSWORD;
if (!email || !password) {
  console.error('FAIL: UW_EMAIL and UW_PASSWORD must be set in weles/.env');
  process.exit(1);
}

const proxyUrl = process.env.PROXY_URL || 'residential';
const s = await WSession.start({ label: `uw_scrape_${ticker}`, proxy: proxyUrl });
global._s = s;

async function doLogin(sess) {
  console.error('[uw_scrape] logging in');
  await sess.goto('https://unusualwhales.com/login');
  for (let i = 0; i < 30; i++) {
    const count = await sess.page.evaluate('document.querySelectorAll("input").length').catch(() => 0);
    if (count >= 2) break;
    await sess.wait(1);
  }
  const inputs = await sess.page.evaluate(`(() => Array.from(document.querySelectorAll('input')).map((i, idx) => ({ idx, name: i.name, type: i.type, id: i.id, ph: i.placeholder })))()`);
  const emailIn = inputs.find(i => i.type === 'email' || i.name === 'email' || /email|address/i.test(i.ph || ''));
  const passIn = inputs.find(i => i.type === 'password' || i.name === 'password');
  if (!emailIn || !passIn) {
    console.error(`FAIL: login inputs not found: ${JSON.stringify(inputs)}`);
    process.exit(1);
  }
  const sel = (i) => i.name ? `input[name="${i.name}"]` : i.id ? `input[id="${i.id}"]` : `input[placeholder="${i.ph}"]`;
  const fill = (s, v) => sess.page.evaluate(`(({ sel, val }) => { const el = document.querySelector(sel); if (!el) return false; el.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })(${JSON.stringify({ sel: s, val: v })})`);
  await fill(sel(emailIn), email);
  await sess.wait(1);
  await fill(sel(passIn), password);
  await sess.wait(1);
  await sess.page.evaluate(`(() => { const b = document.querySelector('button[type="submit"], input[type="submit"]'); if (b) b.click(); else document.querySelector('form')?.requestSubmit(); })()`);
  for (let i = 0; i < 30; i++) {
    await sess.wait(2);
    const u = sess.page.url();
    if (!u.includes('/login')) { console.error(`[uw_scrape] logged in, now at ${u}`); return; }
  }
  console.error('FAIL: login did not redirect');
  process.exit(1);
}

try {
  await doLogin(s);
  // Give the SPA a moment to fully boot after login redirect.
  await s.wait(3);

  const url = PAGE_URLS[page](ticker);
  console.error(`[uw_scrape] navigating to ${url}`);
  await s.goto(url);
  const sess = s;

  // Wait for page content to render (up to 60s). If the SPA client-side
  // router hung on the same-origin nav, reload once halfway through.
  let ready = false;
  let lastLen = 0;
  let reloaded = false;
  for (let i = 0; i < 60; i++) {
    const len = await sess.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) { ready = true; console.error(`[uw_scrape] page rendered after ${i + 1}s (bodyText=${len} chars)`); break; }
    if (i % 5 === 0) console.error(`[uw_scrape] waiting for render... bodyText=${len}`);
    if (i === 15 && !reloaded) {
      reloaded = true;
      console.error('[uw_scrape] 15s blank — forcing hard reload');
      await sess.page.reload().catch(() => {});
    }
    lastLen = len;
    await sess.wait(1);
  }
  if (!ready) {
    const curr = sess.page.url();
    console.error(`FAIL: page never rendered. url=${curr} lastLen=${lastLen}`);
    await sess.page.screenshot({ path: '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/trading-tools/screenshots/uw_scrape_fail.png' }).catch(() => {});
    process.exit(1);
  }
  // Let charts/tables settle
  await sess.wait(5);

  // Verify the session is authenticated
  const authStatus = await sess.page.evaluate(`(() => {
    const body = document.body?.innerText || '';
    const stale = /Viewing data from.*days ago.*Subscribe for live/i.test(body);
    const guest = /Sign In/.test(body) && !/Sign Out/.test(body);
    return { stale, guest, hasSignIn: /Sign In/.test(body), hasSignOut: /Sign Out/.test(body) };
  })()`);
  console.error(`[uw_scrape] auth status: ${JSON.stringify(authStatus)}`);

  // Optional screenshot
  if (screenshotPath) {
    await sess.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error(`[uw_scrape] screenshot saved to ${screenshotPath}`);
  }

  // Generic extraction: grab page title, all tables as arrays of rows, top-level text blocks
  const data = await sess.page.evaluate(`(() => {
    const out = { url: location.href, title: document.title };
    // Extract tables
    out.tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map(t => {
      const headers = Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim());
      const rows = Array.from(t.querySelectorAll('tbody tr')).slice(0, 50).map(r =>
        Array.from(r.querySelectorAll('td, th')).map(c => c.innerText.trim())
      );
      return { headers, rows };
    });
    // Extract visible text (truncated)
    out.bodyText = (document.body?.innerText || '').slice(0, 10000);
    return out;
  })()`);

  // Persist scrape to Supabase + GCS before exit.
  const persisted = await persistContext({
    ticker,
    page,
    data,
    screenshotPath,
    metadata: { auth: authStatus, source: 'scrape.mjs' },
  });
  console.error(`[uw_scrape] persisted row id=${persisted.id} gcs=${persisted.gcs_url || 'none'}`);

  // Write JSON directly to real stdout (console.log is redirected).
  process.stdout.write(JSON.stringify({
    ticker,
    page,
    ...data,
    stock_context: persisted,
  }) + '\n');
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await (global._s || s).close().catch(() => {});
}
