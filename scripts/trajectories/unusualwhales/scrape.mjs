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
const ticker = (args.ticker || process.env.TICKER || '').toUpperCase();
const page = args.page || process.env.PAGE || 'overview';
const screenshotPath = args.screenshot;
const startDate = args['start-date'] || process.env.START_DATE || '';
const endDate = args['end-date'] || process.env.END_DATE || '';
const qs = (() => {
  const p = new URLSearchParams();
  if (startDate) p.set('start_date', startDate);
  if (endDate) p.set('end_date', endDate);
  if (startDate && !endDate) p.set('end_date', startDate);
  const s = p.toString();
  return s ? `?${s}` : '';
})();
if (!ticker) {
  console.error('FAIL: --ticker required');
  process.exit(1);
}

// Every path below was extracted live from the authenticated UW sidebar
// via scripts/trajectories/unusualwhales/_probe_urls.mjs. Do not add a
// page here without verifying it appears in the <a href> list that probe
// emits, otherwise the scrape will hit a 404.
const PAGE_URLS = {
  // Options-flow alerts — UW's flagship per-trade signal. The /stock/T/flow-alerts
  // page redirects to /option-flow-alerts?ticker_symbol=T which renders 50 rows by
  // default but accepts &limit=N up to 500 (probed 2026-05-09: 50/100/200/500 work,
  // 1000 collapses back to 50). Use limit=500 for max history per scrape.
  option_flow_alerts: (t) => `https://unusualwhales.com/option-flow-alerts?ticker_symbol=${t}&limit=500`,
  overview: (t) => `https://unusualwhales.com/stock/${t}/overview${qs}`,
  chart: (t) => `https://unusualwhales.com/stock/${t}/chart${qs}`,
  flow_alerts: (t) => `https://unusualwhales.com/stock/${t}/flow-alerts${qs}`,
  flow_history: (t) => `https://unusualwhales.com/stock/${t}/options-flow-history${qs}`,
  flow_overview: (t) => `https://unusualwhales.com/stock/${t}/flow-overview${qs}`,
  net_premium: (t) => `https://unusualwhales.com/stock/${t}/net-premium${qs}`,
  nope: (t) => `https://unusualwhales.com/stock/${t}/nope${qs}`,
  darkpool: (t) => `https://unusualwhales.com/stock/${t}/darkpool${qs}`,
  greeks: (t) => `https://unusualwhales.com/stock/${t}/greeks`,
  greek_exposure: (t) => `https://unusualwhales.com/stock/${t}/greek-exposure`,
  chains: (t) => `https://unusualwhales.com/stock/${t}/option-chains`,
  oi_changes: (t) => `https://unusualwhales.com/stock/${t}/open-interest-changes`,
  options_charting: (t) => `https://unusualwhales.com/stock/${t}/options-charting`,
  volatility: (t) => `https://unusualwhales.com/stock/${t}/volatility`,
  insiders: (t) => `https://unusualwhales.com/stock/${t}/insiders`,
  institutions: (t) => `https://unusualwhales.com/stock/${t}/institutions`,
  shorts: (t) => `https://unusualwhales.com/stock/${t}/shorts`,
  analysts: (t) => `https://unusualwhales.com/stock/${t}/analysts`,
  earnings: (t) => `https://unusualwhales.com/stock/${t}/earnings`,
  dividends: (t) => `https://unusualwhales.com/stock/${t}/dividends`,
  financials: (t) => `https://unusualwhales.com/stock/${t}/financials`,
  risk: (t) => `https://unusualwhales.com/stock/${t}/risk`,
  seasonality: (t) => `https://unusualwhales.com/stock/${t}/seasonality`,
  stock_talk: (t) => `https://unusualwhales.com/stock/${t}/stock-talk`,
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

// UW is a paid SaaS dashboard we authenticate to with a single shared
// session; per-request residential rotation is not required and the
// residential pool's pre-flight checks have repeatedly failed on the
// mac-mini host. Default to direct (no proxy). Set PROXY_URL=residential
// (or pass --proxy=residential via params.proxy_url_override) to opt in.
const proxyUrl = process.env.PROXY_URL || 'direct';
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
  await sess.fillSelector(sel(emailIn), email);
  await sess.wait(1);
  await sess.fillSelector(sel(passIn), password);
  await sess.wait(1);
  const submitLoc = sess.page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submitLoc.count()) await submitLoc.click().catch(() => {});
  else await sess.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
  for (let i = 0; i < 30; i++) {
    await sess.wait(2);
    const u = sess.page.url();
    if (!u.includes('/login')) { console.error(`[uw_scrape] logged in, now at ${u}`); return; }
  }
  console.error('FAIL: login did not redirect');
  process.exit(1);
}

// Parse one row of the rendered UW darkpool table into a uw_darkpool_history record.
// Headers/order probed 2026-05-06 from a persisted ORCL snapshot — column lookup
// by header name handles the "" + "Powered by unusualwhales.com" trailing
// columns and any future column shuffling.
function parseUwDarkpoolPrint(headers, rowCells, scrapedAtIso) {
  if (!Array.isArray(rowCells) || rowCells.length < 5) return null;
  const idx = (n) => headers.indexOf(n);
  const get = (n) => { const i = idx(n); return i >= 0 ? rowCells[i] : null; };
  const timeStr = get('Time - PDT / UTC+4'); const tk = get('Ticker'); const priceStr = get('Price'); const sizeStr = get('Size'); const premiumStr = get('Premium');
  if (!timeStr || !tk || !priceStr || !sizeStr || !premiumStr) return null;
  const m = String(timeStr).match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const yr = new Date(scrapedAtIso).getUTCFullYear();
  let cand = new Date(Date.UTC(yr, +m[1] - 1, +m[2], +m[3] + 4, +m[4], +m[5]));
  if (cand > new Date(scrapedAtIso)) cand = new Date(Date.UTC(yr - 1, +m[1] - 1, +m[2], +m[3] + 4, +m[4], +m[5]));
  const num = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
  const dollarMag = (s) => { const c = String(s).replace(/[$,\s]/g, ''); const m2 = c.match(/^([\d.]+)([KMBT])?$/); if (!m2) return null; const n = Number(m2[1]); return n * (m2[2] === 'K' ? 1e3 : m2[2] === 'M' ? 1e6 : m2[2] === 'B' ? 1e9 : m2[2] === 'T' ? 1e12 : 1); };
  const pct = (s) => { const n = Number(String(s).replace(/%/g, '').trim()); return Number.isFinite(n) ? n : null; };
  const orNull = (s) => { const t = (s || '').trim(); return t || null; };
  const price = num(priceStr); const size = Math.round(num(sizeStr) || 0); const premium = dollarMag(premiumStr);
  if (price == null || size === 0 || premium == null) return null;
  return { ticker: tk.trim(), full_datetime: cand.toISOString(), price, size, premium, volume_shares: dollarMag(get('Volume')), pct_vol: pct(get('% Vol')), pct_30d_vol: pct(get('% 30D Vol')), trf_delay: orNull(get('TRF delay')), sector: orNull(get('Sector')), issue_type: orNull(get('Issue Type')), sold_codes: orNull(get('Sold codes')), trade_code: orNull(get('Trade code')), settlement_code: orNull(get('Settlement code')), extended_trading_code: orNull(get('Extended trading code')) };
}

async function upsertDarkpoolPrints(data, ticker, scrapedAtIso) {
  const tables = data?.tables || [];
  const dp = tables.find((t) => Array.isArray(t.headers) && t.headers.includes('Time - PDT / UTC+4'));
  if (!dp) { console.error('[uw_scrape] no darkpool table found in scrape data'); return 0; }
  const parsed = (dp.rows || []).map((r) => parseUwDarkpoolPrint(dp.headers, r, scrapedAtIso)).filter((x) => x != null && x.ticker === ticker);
  if (parsed.length === 0) return 0;
  const supaUrl = process.env.SUPABASE_URL; const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) { console.error('[uw_scrape] missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — skipping upsert'); return 0; }
  const r = await fetch(`${supaUrl}/rest/v1/uw_darkpool_history?on_conflict=ticker,full_datetime,size,premium`, {
    method: 'POST', headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(parsed),
  });
  if (!r.ok) { console.error(`[uw_scrape] upsert HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return 0; }
  return parsed.length;
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

  // For the darkpool page, parse each rendered row and insert into the
  // per-print durable ledger. UW returns at most 50 most-recent prints
  // and there's no historical date-range fetch, so accumulation is
  // forward-looking — daily scrapes naturally grow the table.
  let dpUpserted = 0;
  if (page === 'darkpool') {
    dpUpserted = await upsertDarkpoolPrints(data, ticker, new Date().toISOString());
    console.error(`[uw_scrape] darkpool upserted=${dpUpserted}`);
  }

  // For the options-flow-alerts page, parse each row and insert into the
  // per-trade options-flow ledger. This is UW's flagship signal — per-options-trade
  // alerts with side/call_or_put/strike/expiry/sentiment/Greeks data.
  let ofUpserted = 0;
  if (page === 'option_flow_alerts') {
    const { upsertUwOptionsFlow } = await import('./_option_flow.mjs');
    ofUpserted = await upsertUwOptionsFlow(data, ticker, new Date().toISOString());
    console.error(`[uw_scrape] options-flow upserted=${ofUpserted}`);
  }

  // Persist scrape to Supabase + GCS before exit.
  const persisted = await persistContext({
    ticker,
    page,
    data,
    screenshotPath,
    metadata: { auth: authStatus, source: 'scrape.mjs', dpUpserted, ofUpserted },
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
