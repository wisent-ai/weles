// Scrape one volumeleaders.com page for a given ticker.
// Usage: node scripts/trajectories/volumeleaders/scrape.mjs --ticker ORCL --page trades [--screenshot /path.png]
// Pages: trades | clusters | cluster_bombs | levels | level_touches | chart |
//        institutional_volume | ah_institutional_volume | total_volume | exhaustion

console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('./_envload.mjs');
const { persistContext } = await import('../unusualwhales/_persist.mjs');
loadEnv();

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ticker = (args.ticker || '').toUpperCase();
const pageKey = args.page || 'trades';
const screenshotPath = args.screenshot;
if (!ticker) { console.error('FAIL: --ticker required'); process.exit(1); }

const email = process.env.VL_EMAIL;
const password = process.env.VL_PASSWORD;
if (!email || !password) { console.error('FAIL: VL creds not set'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const base = 'https://www.volumeleaders.com';

// URLs use the exact query-parameter structure the VL sidebar produces,
// with the Tickers field substituted for the requested symbol.
const PAGE_URLS = {
  trades: (t) => `${base}/Trades?Tickers=${t}&StartDate=${today}&EndDate=${today}&MinVolume=0&MaxVolume=2000000000&Conditions=-1&VCD=0&RelativeSize=0&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&EvenShared=-1&SecurityTypeKey=-1&MinPrice=0&MaxPrice=100000&MinDollars=100000&MaxDollars=30000000000&TradeRank=-1&TradeRankSnapshot=-1&MarketCap=0&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1&SectorIndustry=&PresetSearchTemplateID=87&ViewMode=Automatic`,
  clusters: (t) => `${base}/TradeClusters?Tickers=${t}&StartDate=${today}&EndDate=${today}&MinVolume=0&MaxVolume=2000000000&VCD=0&SecurityTypeKey=-1&RelativeSize=0&MinPrice=0&MaxPrice=100000&MinDollars=100000&MaxDollars=30000000000&TradeClusterRank=-1&SectorIndustry=&PresetSearchTemplateID=87&ViewMode=Automatic`,
  cluster_bombs: (t) => `${base}/TradeClusterBombs?Tickers=${t}&StartDate=${today}&EndDate=${today}&MinVolume=0&MaxVolume=2000000000&VCD=0&RelativeSize=0&MinDollars=0&MaxDollars=30000000000&TradeClusterBombRank=-1&SectorIndustry=&ViewMode=Automatic`,
  levels: (t) => `${base}/TradeLevels?Ticker=${t}&MinVolume=0&MaxVolume=2000000000&VCD=0&RelativeSize=0&MinPrice=0&MaxPrice=100000&MinDollars=100000&MaxDollars=30000000000&StartDate=${today}&EndDate=${today}&TradeLevelRank=-1&TradeLevelCount=50&ViewMode=Automatic`,
  level_touches: (t) => `${base}/TradeLevelTouches?Tickers=${t}&MinVolume=0&MaxVolume=2000000000&VCD=0&RelativeSize=0&MinPrice=0&MaxPrice=100000&MinDollars=100000&MaxDollars=30000000000&StartDate=${today}&EndDate=${today}&TradeLevelRank=10&PresetSearchTemplateID=87&ViewMode=Automatic`,
  chart: (t) => `${base}/Chart0?Ticker=${t}&StartDate=${today}&EndDate=${today}&MinVolume=0&MaxVolume=2000000000&MinDollars=100000&MaxDollars=30000000000&MinPrice=0&MaxPrice=100000&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&EvenShared=-1&SecurityTypeKey=-1&VolumeProfile=0&Levels=5&TradeCount=3&VCD=0&TradeRank=-1&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1&ViewMode=Automatic`,
  institutional_volume: (t) => `${base}/InstitutionalVolume?Date=${today}&Tickers=${t}&PresetSearchTemplateID=87&ViewMode=Automatic`,
  ah_institutional_volume: (t) => `${base}/AHInstitutionalVolume?Date=${today}&Tickers=${t}&PresetSearchTemplateID=87&ViewMode=Automatic`,
  total_volume: (t) => `${base}/TotalVolume?Date=${today}&Tickers=${t}&PresetSearchTemplateID=87&ViewMode=Automatic`,
  exhaustion: (_t) => `${base}/ExhaustionScore`,
};
if (!PAGE_URLS[pageKey]) {
  console.error(`FAIL: unknown page '${pageKey}'. Options: ${Object.keys(PAGE_URLS).join(', ')}`);
  process.exit(1);
}

const s = await WSession.start({ label: `vl_scrape_${ticker}_${pageKey}`, proxy: process.env.PROXY_URL || 'oxylabs' });

async function login() {
  console.error('[vl] logging in');
  await s.goto(`${base}/Login`);
  for (let i = 0; i < 30; i++) {
    const ok = await s.page.evaluate('document.querySelector("input[name=Email]") && document.querySelector("input[name=Password]")').catch(() => false);
    if (ok) break;
    await s.wait(1);
  }
  const fill = (sel, val) => s.page.evaluate(`(({ sel, val }) => { const el = document.querySelector(sel); if (!el) return false; el.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })(${JSON.stringify({ sel, val })})`);
  await fill('input[name="Email"]', email); await s.wait(1);
  await fill('input[name="Password"]', password); await s.wait(1);
  await s.page.evaluate(`(() => { const b = document.querySelector('button[type="submit"], input[type="submit"]'); if (b) b.click(); else document.querySelector('form')?.requestSubmit(); })()`);
  for (let i = 0; i < 30; i++) {
    await s.wait(2);
    if (!s.page.url().toLowerCase().includes('/login')) return;
  }
  throw new Error('login did not redirect');
}

try {
  await login();
  await s.wait(3);

  const url = PAGE_URLS[pageKey](ticker);
  console.error(`[vl] navigating to ${url}`);
  await s.goto(url);

  // Wait for the page's main table(s) to render.
  let ready = false;
  let reloaded = false;
  for (let i = 0; i < 40; i++) {
    const len = await s.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) { ready = true; console.error(`[vl] rendered after ${i + 1}s (bodyLen=${len})`); break; }
    if (i === 20 && !reloaded) {
      reloaded = true;
      console.error('[vl] 20s blank — hard reload');
      await s.page.reload().catch(() => {});
    }
    await s.wait(1);
  }
  if (!ready) {
    console.error('FAIL: page never rendered');
    process.exit(1);
  }
  await s.wait(5);

  if (screenshotPath) {
    await s.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error(`[vl] screenshot: ${screenshotPath}`);
  }

  const data = await s.page.evaluate(`(() => {
    const out = { url: location.href, title: document.title };
    out.tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map(t => ({
      headers: Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim()).slice(0, 20),
      rows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 100).map(r =>
        Array.from(r.querySelectorAll('td, th')).map(c => c.innerText.trim())
      ),
    }));
    out.bodyText = (document.body?.innerText || '').slice(0, 10000);
    return out;
  })()`);

  const persisted = await persistContext({
    ticker,
    page: `vl_${pageKey}`,
    data,
    screenshotPath,
    metadata: { source: 'volumeleaders/scrape.mjs' },
  });
  console.error(`[vl] persisted row id=${persisted.id} gcs=${persisted.gcs_url || 'none'}`);

  process.stdout.write(JSON.stringify({ ticker, page: `vl_${pageKey}`, ...data, stock_context: persisted }) + '\n');
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
