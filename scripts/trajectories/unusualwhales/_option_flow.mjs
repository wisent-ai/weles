// Parser + upserter for UW /option-flow-alerts rendered table rows.
// Verified column→value mapping 2026-05-09 from a live ORCL probe.
//
// Headers (23 cols): Time, Ticker, Side, Bid/Ask, Contract, DTE, Stock,
//   Spot, Rule/Unusual Whales, % OTM, Size, Premium, Bid/Ask Prem,
//   🐻/🐂 Prem, Volume, OI, Vol/OI, IV Change, Earnings, Marketcap,
//   Sector, "", "Powered by unusualwhales.com"
// Cells per row (24): the rendered row has an icon cell at index 1 that
// is not represented in the headers list, so cells from index 2 onward
// represent values for headers from index 1 onward — header→cell shift
// is +1 for everything after the icon column.

const num = (s) => { const n = Number(String(s || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const dollarMag = (s) => { const c = String(s || '').replace(/[$,\s]/g, ''); const m = c.match(/^([\d.]+)([KMBT])?$/); if (!m) return null; const n = Number(m[1]); return n * (m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : m[2] === 'T' ? 1e12 : 1); };
const pct = (s) => { const n = Number(String(s || '').replace(/%/g, '').trim()); return Number.isFinite(n) ? n : null; };
const orNull = (s) => { const t = String(s || '').trim(); return t || null; };
const intOrNull = (s) => { const n = parseInt(String(s || '').replace(/[,\s]/g, ''), 10); return Number.isFinite(n) ? n : null; };

// Parse strike range "$1.24-$1.51" into {low, high}, or single "$1.24" → {low: 1.24, high: null}
function parseStrike(s) {
  if (!s) return { low: null, high: null };
  const m = String(s).match(/^\$([\d.]+)(?:-\$([\d.]+))?$/);
  if (!m) return { low: null, high: null };
  return { low: Number(m[1]), high: m[2] ? Number(m[2]) : null };
}

function parseExpiry(s) {
  // "05/08/2026" → "2026-05-08"
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function parseEarningsDays(s) {
  // "-1d", "6d" → -1, 6
  const m = String(s || '').match(/^(-?\d+)d$/);
  return m ? Number(m[1]) : null;
}

export function parseUwOptionsFlowRow(rowCells, scrapedAtIso) {
  if (!Array.isArray(rowCells) || rowCells.length < 23) return null;
  // Cell layout (0-indexed): 0=Time, 1=icon(empty), 2=Ticker, 3=BID/ASK,
  // 4=Strike, 5=DTE, 6=call/put, 7=Expiry, 8=EarnDays, 9=Spot,
  // 10=PerContractPremium, 11=Rule, 12=%OTM, 13=Size, 14=TotalPremium,
  // 15=Bid/Ask%, 16=Bear/Bull%, 17=Volume, 18=OI, 19=Vol/OI, 20=IV%,
  // 21=earnings (??), 22=MarketCap, 23=Sector
  const timeStr = rowCells[0];
  const ticker = (rowCells[2] || '').trim();
  const side = (rowCells[3] || '').trim();
  const strikeStr = rowCells[4];
  const dte = intOrNull(rowCells[5]);
  const cp = (rowCells[6] || '').trim().toLowerCase();
  const expiry = parseExpiry(rowCells[7]);
  const spot = num(rowCells[9]);
  const perCtrPrem = num(rowCells[10]);
  const ruleText = orNull(rowCells[11]);
  const pctOtm = pct(rowCells[12]);
  const size = intOrNull(rowCells[13]);
  const totalPrem = dollarMag(rowCells[14]);
  const baPct = pct(rowCells[15]);
  const bbPct = pct(rowCells[16]);
  const vol = intOrNull(rowCells[17]);
  const oi = intOrNull(rowCells[18]);
  const volOi = num(rowCells[19]);
  const ivCh = pct(rowCells[20]);
  const marketCap = orNull(rowCells[22]);
  const sector = orNull(rowCells[23]);

  if (!ticker || !timeStr || !side || !cp || !expiry || size == null || totalPrem == null) return null;
  if (cp !== 'call' && cp !== 'put') return null;
  if (side !== 'BID' && side !== 'ASK') return null;
  const strike = parseStrike(strikeStr);
  if (strike.low == null) return null;

  const tm = String(timeStr).match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!tm) return null;
  const yr = new Date(scrapedAtIso).getUTCFullYear();
  let cand = new Date(Date.UTC(yr, +tm[1] - 1, +tm[2], +tm[3] + 4, +tm[4], +tm[5]));
  if (cand > new Date(scrapedAtIso)) cand = new Date(Date.UTC(yr - 1, +tm[1] - 1, +tm[2], +tm[3] + 4, +tm[4], +tm[5]));

  return {
    ticker, full_datetime: cand.toISOString(),
    side_text: side, call_or_put: cp, expiry,
    strike_low: strike.low, strike_high: strike.high,
    dte, spot, rule_text: ruleText, pct_otm: pctOtm,
    size, total_premium: totalPrem, per_contract_premium: perCtrPrem,
    bid_ask_premium_pct: baPct, bear_bull_premium_pct: bbPct,
    volume: vol, open_interest: oi, vol_oi: volOi, iv_change_pct: ivCh,
    market_cap: marketCap, sector,
  };
}

export async function upsertUwOptionsFlow(data, ticker, scrapedAtIso) {
  const tables = data?.tables || [];
  const flow = tables.find((t) => Array.isArray(t.headers) && t.headers.some((h) => /Bid\/Ask Prem|Vol\/OI/.test(h)));
  if (!flow) { console.error('[uw_scrape] no options-flow table found'); return 0; }
  const parsed = (flow.rows || []).map((r) => parseUwOptionsFlowRow(r, scrapedAtIso)).filter((x) => x != null && x.ticker === ticker);
  if (parsed.length === 0) return 0;
  const supaUrl = process.env.SUPABASE_URL; const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) { console.error('[uw_scrape] missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY'); return 0; }
  const r = await fetch(`${supaUrl}/rest/v1/uw_options_flow?on_conflict=ticker,full_datetime,side_text,call_or_put,expiry,strike_low,size,total_premium`, {
    method: 'POST',
    headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(parsed),
  });
  if (!r.ok) { console.error(`[uw_scrape] options-flow upsert HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return 0; }
  return parsed.length;
}
