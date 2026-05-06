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
const ticker = (args.ticker || process.env.TICKER || '').toUpperCase();
const pageKey = args.page || process.env.PAGE || 'trades';
const screenshotPath = args.screenshot;
if (!ticker) { console.error('FAIL: --ticker required'); process.exit(1); }

const email = process.env.VL_EMAIL;
const password = process.env.VL_PASSWORD;
if (!email || !password) { console.error('FAIL: VL creds not set'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const startDate = args['start-date'] || process.env.START_DATE || today;
const endDate = args['end-date'] || process.env.END_DATE || today;
const minRs = args['min-rs'] || '0';
const maxRank = args['max-rank'] || '-1';
const minDollars = args['min-dollars'] || '100000';
const maxDollars = args['max-dollars'] || '30000000000';
const base = 'https://www.volumeleaders.com';

// URLs use the exact query-parameter structure the VL sidebar produces,
// with the Tickers field substituted for the requested symbol. Date range
// defaults to today but can be overridden via --start-date/--end-date.
const PAGE_URLS = {
  // Trades grid: full param set. VL's TradesView.cshtml template inlines
  // these into the DataTables ajax-config script tag; missing params
  // produce invalid JS (e.g. `"RelativeSize": ,`) that throws a
  // SyntaxError before DataTable can fire POST /Trades/GetTrades.
  // Required: RelativeSize, DarkPools, Sweeps, LatePrints, SignaturePrints,
  // EvenShared, Conditions, VCD, SecurityTypeKey, MarketCap, SectorIndustry,
  // TradeRank, TradeRankSnapshot — values mirror /Chart0's "any" defaults.
  trades: (t) => `${base}/Trades?Tickers=${t}&StartDate=${startDate}&EndDate=${endDate}&MinVolume=0&MaxVolume=2000000000&MinPrice=0&MaxPrice=100000&MinDollars=${minDollars}&MaxDollars=${maxDollars}&Conditions=&VCD=0&SecurityTypeKey=-1&RelativeSize=${minRs}&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&EvenShared=-1&TradeRank=-1&TradeRankSnapshot=-1&MarketCap=-1&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1&SectorIndustry=&ViewMode=Automatic`,
  clusters: (t) => `${base}/TradeClusters?Tickers=${t}&StartDate=${startDate}&EndDate=${endDate}&MinVolume=0&MaxVolume=2000000000&VCD=0&SecurityTypeKey=-1&RelativeSize=${minRs}&MinPrice=0&MaxPrice=100000&MinDollars=${minDollars}&MaxDollars=${maxDollars}&TradeClusterRank=${maxRank}&SectorIndustry=&PresetSearchTemplateID=87&ViewMode=Automatic`,
  cluster_bombs: (t) => `${base}/TradeClusterBombs?Tickers=${t}&StartDate=${startDate}&EndDate=${endDate}&MinVolume=0&MaxVolume=2000000000&VCD=0&RelativeSize=${minRs}&MinDollars=0&MaxDollars=30000000000&TradeClusterBombRank=-1&SectorIndustry=&ViewMode=Automatic`,
  levels: (t) => `${base}/TradeLevels?Ticker=${t}&MinVolume=0&MaxVolume=2000000000&VCD=0&RelativeSize=${minRs}&MinPrice=0&MaxPrice=100000&MinDollars=${minDollars}&MaxDollars=${maxDollars}&StartDate=${startDate}&EndDate=${endDate}&TradeLevelRank=-1&TradeLevelCount=50&ViewMode=Automatic`,
  level_touches: (t) => `${base}/TradeLevelTouches?Tickers=${t}&MinVolume=0&MaxVolume=2000000000&VCD=0&RelativeSize=${minRs}&MinPrice=0&MaxPrice=100000&MinDollars=${minDollars}&MaxDollars=${maxDollars}&StartDate=${startDate}&EndDate=${endDate}&TradeLevelRank=10&PresetSearchTemplateID=87&ViewMode=Automatic`,
  chart: (t) => `${base}/Chart0?Ticker=${t}&StartDate=${startDate}&EndDate=${endDate}&MinVolume=0&MaxVolume=2000000000&MinDollars=${minDollars}&MaxDollars=${maxDollars}&MinPrice=0&MaxPrice=100000&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&EvenShared=-1&SecurityTypeKey=-1&VolumeProfile=0&Levels=5&TradeCount=3&VCD=0&TradeRank=-1&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1&ViewMode=Automatic`,
  institutional_volume: (t) => `${base}/InstitutionalVolume?Date=${startDate}&Tickers=${t}&PresetSearchTemplateID=87&ViewMode=Automatic`,
  ah_institutional_volume: (t) => `${base}/AHInstitutionalVolume?Date=${startDate}&Tickers=${t}&PresetSearchTemplateID=87&ViewMode=Automatic`,
  total_volume: (t) => `${base}/TotalVolume?Date=${startDate}&Tickers=${t}&PresetSearchTemplateID=87&ViewMode=Automatic`,
  exhaustion: (_t) => `${base}/ExhaustionScore`,
};
if (!PAGE_URLS[pageKey]) {
  console.error(`FAIL: unknown page '${pageKey}'. Options: ${Object.keys(PAGE_URLS).join(', ')}`);
  process.exit(1);
}

// VL is a paid SaaS dashboard authenticated with a single session.
// Default direct; override via PROXY_URL or params.proxy_url_override.
const s = await WSession.start({ label: `vl_scrape_${ticker}_${pageKey}`, proxy: process.env.PROXY_URL || 'direct' });

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
  const submitLoc = s.page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submitLoc.count()) await submitLoc.click().catch(() => {});
  else await s.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
  for (let i = 0; i < 30; i++) {
    await s.wait(2);
    if (!s.page.url().toLowerCase().includes('/login')) return;
  }
  throw new Error('login did not redirect');
}

// Build the URL-encoded form body that VL's DataTables-shaped POST /Trades/GetTrades
// expects. Mirror the field set captured in vl_full_body probes 2026-05-06.
function buildGetTradesBody({ ticker, startDate, endDate, minDollars, maxDollars, minRs, start, length }) {
  const f = new URLSearchParams();
  f.append('draw', '1'); f.append('start', String(start)); f.append('length', String(length));
  for (let i = 0; i < 14; i += 1) {
    f.append(`columns[${i}][data]`, 'FullTimeString24');
    f.append(`columns[${i}][searchable]`, 'true');
    f.append(`columns[${i}][orderable]`, 'true');
    f.append(`columns[${i}][search][value]`, '');
    f.append(`columns[${i}][search][regex]`, 'false');
  }
  f.append('order[0][column]', '1'); f.append('order[0][dir]', 'desc');
  f.append('search[value]', ''); f.append('search[regex]', 'false');
  const filt = { Tickers: ticker, StartDate: startDate, EndDate: endDate, MinVolume: '0', MaxVolume: '2000000000', MinPrice: '0', MaxPrice: '100000', MinDollars: String(minDollars), MaxDollars: String(maxDollars), Conditions: '', VCD: '0', SecurityTypeKey: '-1', RelativeSize: String(minRs), DarkPools: '-1', Sweeps: '-1', LatePrints: '-1', SignaturePrints: '-1', EvenShared: '-1', TradeRank: '-1', TradeRankSnapshot: '-1', MarketCap: '-1', IncludePremarket: '1', IncludeRTH: '1', IncludeAH: '1', IncludeOpening: '1', IncludeClosing: '1', IncludePhantom: '1', IncludeOffsetting: '1', SectorIndustry: '' };
  for (const [k, v] of Object.entries(filt)) f.append(k, v);
  return f.toString();
}

// Paginate POST /Trades/GetTrades via the authenticated browser context,
// then upsert into public.vl_trades_history (PK=trade_id, ON CONFLICT DO NOTHING).
async function paginateAndUpsertTrades(sess, t, sd, ed, md, xd, rs) {
  const PAGE_SIZE = 100; const MAX_PAGES = 100; const allRows = [];
  let totalRecords = null;
  for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx += 1) {
    const start = pageIdx * PAGE_SIZE;
    const body = buildGetTradesBody({ ticker: t, startDate: sd, endDate: ed, minDollars: md, maxDollars: xd, minRs: rs, start, length: PAGE_SIZE });
    let resp;
    try {
      resp = await sess.page.evaluate(`(async (b) => { const r = await fetch('/Trades/GetTrades', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b }); const x = await r.text(); return { status: r.status, body: x }; })(${JSON.stringify(body)})`);
    } catch (e) { console.error(`[vl] page=${pageIdx} fetch err ${e.message}`); break; }
    if (resp.status !== 200) { console.error(`[vl] page=${pageIdx} HTTP ${resp.status}`); break; }
    let j; try { j = JSON.parse(resp.body); } catch (e) { console.error(`[vl] page=${pageIdx} parse err`); break; }
    if (totalRecords == null) totalRecords = j.recordsTotal || 0;
    if (!Array.isArray(j.data) || j.data.length === 0) break;
    allRows.push(...j.data);
    console.error(`[vl] page=${pageIdx} fetched=${j.data.length} cumulative=${allRows.length}/${totalRecords}`);
    if (allRows.length >= totalRecords) break;
  }
  if (allRows.length === 0) return 0;
  const supaUrl = process.env.SUPABASE_URL; const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) { console.error('[vl] missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — skipping upsert'); return 0; }
  const mapped = allRows.map((d) => ({
    trade_id: d.TradeID, ticker: d.Ticker, sector: d.Sector || null, industry: d.Industry || null, name: d.Name || null,
    full_datetime: d.FullDateTime, date_key: d.DateKey, time_key: d.TimeKey || null, sequence_number: d.SequenceNumber || null,
    price: d.Price, bid: d.Bid || null, ask: d.Ask || null, dollars: d.Dollars, volume: d.Volume,
    dollars_multiplier: d.DollarsMultiplier || null, trade_count: d.TradeCount || null, trade_rank: d.TradeRank || null,
    trade_rank_snapshot: d.TradeRankSnapshot || null, cumulative_distribution: d.CumulativeDistribution || null,
    is_dark_pool: d.DarkPool === 1, is_sweep: d.Sweep === 1, is_late_print: d.LatePrint === 1,
    is_signature_print: d.SignaturePrint === 1, is_opening_trade: d.OpeningTrade === 1,
    is_closing_trade: d.ClosingTrade === 1, is_phantom_print: d.PhantomPrint === 1,
    inside_bar: d.InsideBar === 1, double_inside_bar: d.DoubleInsideBar === 1,
    trade_conditions: d.TradeConditions || null, rsi_hour: d.RSIHour || null, rsi_day: d.RSIDay || null,
    cancelled: d.Cancelled === 1,
  }));
  const BATCH = 500; let inserted = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const slice = mapped.slice(i, i + BATCH);
    const r = await fetch(`${supaUrl}/rest/v1/vl_trades_history?on_conflict=trade_id`, {
      method: 'POST', headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(slice),
    });
    if (!r.ok) { console.error(`[vl] upsert HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); break; }
    inserted += slice.length;
  }
  return inserted;
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
  // Initial paint isn't enough for VL — the trades / clusters grids hydrate
  // via AJAX after the page loads. Poll up to 60s for any tbody tr with 6+
  // real cells and no "Loading" text. Fall through if pattern doesn't apply
  // so non-grid pages don't fail.
  for (let i = 0; i < 60; i += 1) {
    const ok = await s.page.evaluate(`(() => {
      const rows = document.querySelectorAll('tbody tr');
      for (const r of rows) {
        const txt = r.innerText || '';
        if (/loading/i.test(txt)) continue;
        const cells = r.querySelectorAll('td');
        if (cells.length >= 6 && txt.replace(/\\s+/g, '').length > 20) return true;
      }
      return false;
    })()`).catch(() => false);
    if (ok) { console.error(`[vl] grid hydrated after ${i + 1}s`); break; }
    await s.wait(1);
  }

  if (screenshotPath) {
    await s.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error(`[vl] screenshot: ${screenshotPath}`);
  }

  const data = await s.page.evaluate(`(() => {
    const out = { url: location.href, title: document.title };
    out.tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map(t => ({
      headers: Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim()).slice(0, 20),
      rows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 1000).map(r =>
        Array.from(r.querySelectorAll('td, th')).map(c => c.innerText.trim())
      ),
    }));
    out.bodyText = (document.body?.innerText || '').slice(0, 10000);
    return out;
  })()`);

  // For the trades page, paginate through VL's POST /Trades/GetTrades
  // endpoint and upsert each print into the per-trade vl_trades_history
  // table. The snapshot blob in stock_context is still written below for
  // back-compat with existing readers, but vl_trades_history is the
  // accumulating ledger keyed on TradeID with ON CONFLICT DO NOTHING.
  let perTradeUpserted = 0;
  if (pageKey === 'trades') {
    perTradeUpserted = await paginateAndUpsertTrades(s, ticker, startDate, endDate, minDollars, maxDollars, minRs);
    console.error(`[vl] paginated trades upserted=${perTradeUpserted}`);
  }

  const persisted = await persistContext({
    ticker,
    page: `vl_${pageKey}`,
    data,
    screenshotPath,
    metadata: { source: 'volumeleaders/scrape.mjs', perTradeUpserted },
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
