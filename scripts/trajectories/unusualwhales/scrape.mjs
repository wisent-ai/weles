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
// `pages` is comma-separated; if present, scrape all of them in one
// Playwright session (login once, navigate per page, persist per page).
// Single-job-per-ticker shape — replaces the old one-job-per-page blast.
const pagesArg = args.pages || process.env.PAGES || '';
const pagesList = pagesArg ? pagesArg.split(',').map((p) => p.trim()).filter(Boolean) : null;
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
  const submit = async () => {
    const submitLoc = sess.page.locator('button[type="submit"], input[type="submit"]').first();
    if (await submitLoc.count()) await submitLoc.click().catch(() => {});
    else await sess.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
  };
  const redirected = async (secs) => {
    for (let i = 0; i < secs; i += 2) {
      await sess.wait(2);
      if (!sess.page.url().includes('/login')) { console.error(`[uw_scrape] logged in, now at ${sess.page.url()}`); return true; }
    }
    return false;
  };
  // UW's login carries a risk-based Google reCAPTCHA v2 checkbox that silently
  // auto-passes for low-risk sessions and only demands an image challenge
  // otherwise. So submit with plain credentials first (the common case), and
  // only pay for a captcha solve when that submit is actually blocked. The
  // solve is time-bounded: a hard image challenge can burn 5min+ per provider
  // across the solver chain, which must never wedge the worker.
  await sess.fillSelector(sel(emailIn), email);
  await sess.wait(1);
  await sess.fillSelector(sel(passIn), password);
  await sess.wait(1);
  await submit();
  if (await redirected(30)) return;
  console.error('[uw_scrape] plain submit blocked — attempting captcha solve');
  await sess.goto('https://unusualwhales.com/login');
  await sess.fillSelector(sel(emailIn), email);
  await sess.wait(1);
  await sess.fillSelector(sel(passIn), password);
  await sess.wait(1);
  const CAPTCHA_TIMEOUT_MS = 150_000;
  try {
    const res = await Promise.race([
      sess.solveCaptcha(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`captcha solve exceeded ${CAPTCHA_TIMEOUT_MS}ms`)), CAPTCHA_TIMEOUT_MS)),
    ]);
    console.error(`[uw_scrape] captcha: ${res}`);
  } catch (e) { console.error(`[uw_scrape] captcha solve aborted: ${e.message}`); }
  await submit();
  if (await redirected(30)) return;
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

// Scrape one UW page within an already-authenticated Playwright session.
async function scrapeOnePage(sess, tk, pg, ssPath) {
  if (!PAGE_URLS[pg]) { console.error(`[uw_scrape] unknown page '${pg}'`); return { skipped: true, reason: 'unknown_page' }; }
  const url = PAGE_URLS[pg](tk);
  console.error(`[uw_scrape] [${pg}] -> ${url}`);
  await sess.goto(url);
  let ready = false; let reloaded = false;
  for (let i = 0; i < 60; i += 1) {
    let len = 0;
    try { len = await sess.page.evaluate(() => document.body?.innerText?.length || 0); } // allow-raw-playwright: read-only render check
    catch (e) { console.error(`[uw_scrape] [${pg}] render-poll evaluate threw: ${e.message}`); }
    if (len > 500) { ready = true; console.error(`[uw_scrape] [${pg}] rendered after ${i + 1}s (${len})`); break; }
    if (i === 15 && !reloaded) {
      reloaded = true;
      try { await sess.page.reload(); } catch (e) { console.error(`[uw_scrape] [${pg}] reload threw: ${e.message}`); }
    }
    await sess.wait(1);
  }
  if (!ready) { console.error(`[uw_scrape] [${pg}] never rendered — skipping`); return { skipped: true, reason: 'never_rendered' }; }
  await sess.wait(5);
  // For pages with a TIME RANGE calendar picker (option_flow_alerts),
  // drive the picker to the largest preset before extracting. Confirmed
  // on /dark-pool-flow (2026-05-08): the page disclaimer caps the
  // free-tier window at 7 calendar days, so "Last 7 Days" is the
  // maximum-history preset available.
  if (pg === 'option_flow_alerts') {
    try {
      const timeBtn = sess.page.locator('button:has-text("TIME RANGE")').first();
      if (await timeBtn.count()) {
        await timeBtn.click();
        await sess.wait(2);
        const last7 = sess.page.locator('button:has-text("Last 7 Days")').first();
        if (await last7.count()) { await last7.click(); await sess.wait(1); }
        const applyBtn = sess.page.locator('button:has-text("Apply")').first();
        if (await applyBtn.count()) { await applyBtn.click(); await sess.wait(8); }
        console.error(`[uw_scrape] [${pg}] applied Last 7 Days TIME RANGE`);
      }
    } catch (e) { console.error(`[uw_scrape] [${pg}] TIME RANGE drive threw: ${e.message}`); }
  }
  const authStatus = await sess.page.evaluate(() => { const b = document.body?.innerText || ''; return { stale: /Viewing data from.*days ago.*Subscribe for live/i.test(b), guest: /Sign In/.test(b) && !/Sign Out/.test(b) }; }); // allow-raw-playwright: read-only DOM
  // UW renders inside inner scroll container; `fullPage:true` misses it.
  // Resize viewport to deepest scrollHeight, snapshot, restore.
  if (ssPath) {
    try {
      const maxH = await sess.page.evaluate(() => {
        let h = Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0);
        for (const el of document.querySelectorAll('*')) { const st = getComputedStyle(el); if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) h = Math.max(h, el.scrollHeight + 200); }
        return Math.min(h, 8000);
      });
      const origVp = sess.page.viewportSize();
      if (maxH > origVp.height) await sess.page.setViewportSize({ width: origVp.width, height: maxH }); // allow-raw-playwright: viewport resize for full-content capture
      await sess.wait(2);
      await sess.page.screenshot({ path: ssPath, fullPage: false }); // allow-raw-playwright: viewport-sized PNG (sized to full content)
      if (maxH > origVp.height) await sess.page.setViewportSize(origVp); // allow-raw-playwright: restore
      console.error(`[uw_scrape] [${pg}] screenshot at ${maxH}px tall`);
    } catch (e) { console.error(`[uw_scrape] [${pg}] screenshot threw: ${e.message}`); }
  }
  const data = await sess.page.evaluate(() => { // allow-raw-playwright: read-only DOM extraction
    const out = { url: location.href, title: document.title };
    out.tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map((t) => ({
      headers: Array.from(t.querySelectorAll('thead th, thead td')).map((h) => h.innerText.trim()),
      rows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 500).map((r) => Array.from(r.querySelectorAll('td, th')).map((c) => c.innerText.trim())),
    }));
    // Non-table extractors for UW pages that render charts/cards/SVG instead of tables.
    // Pages confirmed table-empty 2026-05-10: financials, insiders, dividends, volatility,
    // options_charting, net_premium, risk, greek_exposure, chart.
    out.cards = Array.from(document.querySelectorAll('[class*="card" i], [class*="Card" i], [class*="kpi" i], [class*="metric" i]')).slice(0, 50).map((el) => {
      const label = el.querySelector('[class*="label" i], [class*="title" i], h3, h4, h5')?.innerText?.trim() || '';
      const value = el.querySelector('[class*="value" i], [class*="figure" i], strong, b')?.innerText?.trim() || el.innerText?.trim().slice(0, 100) || '';
      return { label, value };
    }).filter((c) => c.label || c.value);
    // ChartIQ / Highcharts / Recharts / D3 series data — every <path d="M...">
    // SVG path that draws a line or bar plus the data-point text labels.
    out.svgSeries = Array.from(document.querySelectorAll('svg')).slice(0, 5).map((svg) => ({
      pathCount: svg.querySelectorAll('path').length,
      circleCount: svg.querySelectorAll('circle').length,
      rectCount: svg.querySelectorAll('rect').length,
      textLabels: Array.from(svg.querySelectorAll('text')).slice(0, 200).map((t) => t.innerText?.trim() || t.textContent?.trim() || '').filter(Boolean),
      ariaLabels: Array.from(svg.querySelectorAll('[aria-label]')).slice(0, 50).map((e) => e.getAttribute('aria-label')).filter(Boolean),
    }));
    // ChartIQ canvas charts expose data via window.CIQ — capture if present.
    out.ciq = (typeof window.CIQ !== 'undefined') ? Object.keys(window.CIQ).slice(0, 50) : null;
    // Highcharts data accessor
    if (typeof window.Highcharts !== 'undefined' && window.Highcharts.charts) {
      out.highcharts = window.Highcharts.charts.filter(Boolean).slice(0, 3).map((c) => c.series?.map((s) => ({ name: s.name, dataLen: s.data?.length || 0, sampleData: (s.data || []).slice(0, 5).map((d) => ({ x: d.x, y: d.y })) })));
    }
    out.bodyText = (document.body?.innerText || '').slice(0, 10000);
    return out;
  });
  let dpUpserted = 0; let ofUpserted = 0;
  if (pg === 'darkpool') dpUpserted = await upsertDarkpoolPrints(data, tk, new Date().toISOString());
  if (pg === 'option_flow_alerts') {
    const { upsertUwOptionsFlow } = await import('./_option_flow.mjs');
    ofUpserted = await upsertUwOptionsFlow(data, tk, new Date().toISOString());
  }
  const persisted = await persistContext({ ticker: tk, page: pg, data, screenshotPath: ssPath, metadata: { auth: authStatus, source: 'scrape.mjs', dpUpserted, ofUpserted } });
  console.error(`[uw_scrape] [${pg}] persisted=${persisted.id} dp=${dpUpserted} of=${ofUpserted}`);
  return { data, persisted, dpUpserted, ofUpserted };
}

try {
  await doLogin(s);
  await s.wait(3);
  const allPages = pagesList && pagesList.length > 0 ? pagesList : [page];
  const results = [];
  for (const pg of allPages) {
    // Per-page screenshot: in single-page mode, honor the --screenshot CLI
    // path if provided; otherwise (multi-page or no path) write a temp PNG
    // per page so persistContext can upload each to GCS alongside its
    // stock_context row. Previously multi-page mode silently passed null
    // here, so 25-page jobs produced zero screenshots.
    const ssPath = (allPages.length === 1 && screenshotPath) ? screenshotPath : path.join(os.tmpdir(), `uw_${ticker}_${pg}_${Date.now()}.png`);
    try { results.push({ page: pg, ...(await scrapeOnePage(s, ticker, pg, ssPath)) }); }
    catch (e) { console.error(`[uw_scrape] [${pg}] threw: ${e.message}`); results.push({ page: pg, error: e.message }); }
    if (ssPath !== screenshotPath) { try { fs.unlinkSync(ssPath); } catch (e) { /* tolerable */ } }
    // Free renderer memory before next page (SIGKILL 137 happened at 24000px cap).
    try { await s.goto('about:blank'); } catch (e) { console.error(`[uw_scrape] about:blank: ${e.message}`); }
  }
  process.stdout.write(JSON.stringify({ ticker, pages: allPages, results }) + '\n');
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await (global._s || s).close().catch(() => {});
}
