// Scrape a public tradingview.com per-symbol page for a ticker.
// No login required — all pages here are public.
// Usage: node scripts/trajectories/tradingview/scrape.mjs --ticker ORCL --page technicals [--screenshot /path.png]
// Pages (verified from the TV symbol page DOM):
//   technicals, forecast, analysis, analysis-overview
//   financials-overview, financials-income-statement, financials-revenue, financials-dividends
//   news, ideas, options-chain, seasonals, holdings, etfs
//   economic-calendar, reports-history, minds, documents, overview

console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('../unusualwhales/_envload.mjs');
const { persistContext } = await import('../unusualwhales/_persist.mjs');
loadEnv();

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ticker = (args.ticker || process.env.TICKER || '').toUpperCase();
const pageKey = args.page || process.env.PAGE || 'overview';
const screenshotPath = args.screenshot;
if (!ticker) { console.error('FAIL: --ticker required'); process.exit(1); }

const ALLOWED = new Set([
  'overview', 'technicals', 'forecast',
  'financials-overview', 'financials-income-statement', 'financials-revenue', 'financials-dividends',
  'analysis', 'analysis-overview', 'news', 'ideas',
  'options-chain', 'seasonals', 'holdings', 'etfs',
  'economic-calendar', 'reports-history', 'minds', 'documents',
]);
if (!ALLOWED.has(pageKey)) {
  console.error(`FAIL: unknown page '${pageKey}'. Allowed: ${Array.from(ALLOWED).join(', ')}`);
  process.exit(1);
}

const s = await WSession.start({ label: `tv_scrape_${ticker}_${pageKey}`, proxy: process.env.PROXY_URL || 'oxylabs' });

try {
  // Resolve exchange prefix by navigating /symbols/TICKER/ and reading the
  // redirected URL. TV sends ORCL to NYSE-ORCL, NVDA to NASDAQ-NVDA, etc.
  console.error(`[tv] resolving exchange prefix for ${ticker}`);
  await s.goto(`https://www.tradingview.com/symbols/${ticker}/`);
  await s.wait(3);
  const finalUrl = s.page.url();
  const m = finalUrl.match(/\/symbols\/([A-Z]+-[A-Z0-9.]+)\//);
  const symbolId = m ? m[1] : null;
  if (!symbolId) {
    console.error(`FAIL: could not resolve exchange prefix, landed at ${finalUrl}`);
    process.exit(1);
  }
  console.error(`[tv] resolved ${ticker} -> ${symbolId}`);

  const base = `https://www.tradingview.com/symbols/${symbolId}`;
  const url = pageKey === 'overview' ? `${base}/` : `${base}/${pageKey}/`;
  if (pageKey !== 'overview' || s.page.url() !== url) {
    console.error(`[tv] navigating to ${url}`);
    await s.goto(url);
  }

  let ready = false;
  let reloaded = false;
  for (let i = 0; i < 40; i++) {
    const len = await s.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) { ready = true; console.error(`[tv] rendered after ${i + 1}s (bodyLen=${len})`); break; }
    if (i === 20 && !reloaded) {
      reloaded = true;
      console.error('[tv] 20s blank — hard reload');
      await s.page.reload().catch(() => {});
    }
    await s.wait(1);
  }
  if (!ready) { console.error('FAIL: page never rendered'); process.exit(1); }
  await s.wait(4);

  if (screenshotPath) {
    await s.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error(`[tv] screenshot: ${screenshotPath}`);
  }

  const data = await s.page.evaluate(`(() => {
    const out = {
      url: location.href,
      title: document.title,
      symbolId: ${JSON.stringify(symbolId)},
    };
    out.tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map(t => ({
      headers: Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim()).slice(0, 20),
      rows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 100).map(r =>
        Array.from(r.querySelectorAll('td, th')).map(c => c.innerText.trim())
      ),
    }));
    out.statItems = Array.from(document.querySelectorAll('[class*="item-"], [class*="stats-"], dl dt, dl dd'))
      .slice(0, 80)
      .map(e => (e.innerText || '').trim())
      .filter(t => t && t.length > 0 && t.length < 120);
    out.bodyText = (document.body?.innerText || '').slice(0, 10000);
    return out;
  })()`);

  const persisted = await persistContext({
    ticker,
    page: `tv_${pageKey}`,
    data,
    screenshotPath,
    metadata: { source: 'tradingview/scrape.mjs', symbolId },
  });
  console.error(`[tv] persisted row id=${persisted.id} uri=${persisted.screenshot_uri || 'none'}`);

  process.stdout.write(JSON.stringify({ ticker, page: `tv_${pageKey}`, ...data, stock_context: persisted }) + '\n');
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
