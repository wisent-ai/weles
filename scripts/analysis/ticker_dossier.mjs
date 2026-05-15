// ORCL dossier extractor — reads the latest stock_context rows from
// Supabase and computes derived metrics from each page's tables.
// No trade recommendation; output is the inputs a human (or downstream
// scorer) needs to form one.
const TICKER = (process.env.TICKER || 'ORCL').toUpperCase();
const SUPA = process.env.SUPABASE_URL || 'https://yqizdfkfnmhddfemdxtq.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.CONTENT_SR_KEY;
if (!KEY) { console.error('FAIL: SUPABASE_SERVICE_ROLE_KEY/CONTENT_SR_KEY env not set'); process.exit(2); }

async function latestByPage() {
  const r = await fetch(`${SUPA}/rest/v1/stock_context?select=page,data,captured_at&ticker=eq.${TICKER}&order=captured_at.desc&limit=400`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) { console.error('FAIL: supabase', r.status, await r.text()); process.exit(2); }
  const rows = await r.json();
  const byPage = new Map();
  for (const row of rows) if (!byPage.has(row.page)) byPage.set(row.page, row);
  return byPage;
}

const num = (s) => { const n = Number(String(s ?? '').replace(/[$,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
const dollarMag = (s) => { const c = String(s ?? '').replace(/[$,\s]/g, ''); const m = c.match(/^(-?[\d.]+)([KMBT])?$/); if (!m) return null; const n = Number(m[1]); return n * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2]] || 1); };
const pct = (s) => num(s);

function findTable(row, headerPred) {
  const tables = row?.data?.tables || [];
  return tables.find((t) => Array.isArray(t.headers) && t.headers.some(headerPred));
}

function analyzeOptionFlow(row) {
  if (!row) return null;
  const t = findTable(row, (h) => /Bid\/Ask Prem|Vol\/OI/.test(h));
  if (!t) return { error: 'no flow table' };
  let callPrem = 0; let putPrem = 0; let nAtAsk = 0; let nAtBid = 0; let ivChange = []; let topStrikes = {};
  const sample = (t.rows || []).filter((r) => Array.isArray(r) && r.length >= 22);
  for (const r of sample) {
    const side = (r[3] || '').trim();
    const cp = (r[6] || '').toLowerCase().trim();
    const strike = (r[4] || '').trim();
    const totalPrem = dollarMag(r[14]);
    const iv = num(r[20]);
    if (totalPrem == null) continue;
    if (cp === 'call') callPrem += totalPrem;
    if (cp === 'put') putPrem += totalPrem;
    if (side === 'ASK') nAtAsk += 1;
    if (side === 'BID') nAtBid += 1;
    if (iv != null) ivChange.push(iv);
    if (strike) topStrikes[`${cp}_${strike}`] = (topStrikes[`${cp}_${strike}`] || 0) + totalPrem;
  }
  const ts = Object.entries(topStrikes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ k, premium: v }));
  return { alerts_parsed: sample.length, call_premium: callPrem, put_premium: putPrem, cp_ratio: putPrem === 0 ? null : callPrem / putPrem, n_at_ask: nAtAsk, n_at_bid: nAtBid, ask_bid_ratio: nAtBid === 0 ? null : nAtAsk / nAtBid, iv_change_avg_pct: ivChange.length ? ivChange.reduce((a, b) => a + b, 0) / ivChange.length : null, top_strikes_by_premium: ts };
}

function analyzeDarkpool(row) {
  if (!row) return null;
  const t = findTable(row, (h) => /TRF delay|% 30D Vol/.test(h));
  if (!t) return { error: 'no darkpool table' };
  const parsed = (t.rows || []).map((r) => ({ time: r[0], price: num(r[2]), size: num((r[3] || '').replace(/,/g, '')), premium: dollarMag(r[4]), pct30d: num(r[7]) })).filter((p) => p.premium != null);
  parsed.sort((a, b) => (b.pct30d || 0) - (a.pct30d || 0));
  const totalPrem = parsed.reduce((a, b) => a + (b.premium || 0), 0);
  return { prints: parsed.length, total_premium: totalPrem, top_by_pct_30d: parsed.slice(0, 5) };
}

function analyzeSeasonality(row, month) {
  if (!row) return null;
  const t = findTable(row, (h) => h === 'Jan' || h === 'Feb');
  if (!t) return { error: 'no seasonality table' };
  const monthIdx = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }[month];
  const colIdx = (t.headers || []).findIndex((h) => h === month);
  if (colIdx < 0) return { error: `no ${month} column` };
  const samples = (t.rows || []).map((r) => num(r[colIdx])).filter((n) => n != null);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const std = Math.sqrt(variance);
  const positive = samples.filter((n) => n > 0).length;
  return { month, n_years: samples.length, mean_pct: mean, std_pct: std, pct_years_positive: positive / samples.length, recent_5: samples.slice(-5) };
}

function analyzeShorts(row) {
  if (!row) return null;
  const tables = row?.data?.tables || [];
  const borrow = tables.find((t) => (t.headers || []).some((h) => /Borrow Rate/.test(h)));
  const sv = tables.find((t) => (t.headers || []).some((h) => /Short Vol/.test(h)) && (t.headers || []).some((h) => /Total Vol/.test(h)));
  const ftd = tables.find((t) => (t.headers || []).some((h) => /Quantity/.test(h)) && (t.headers || []).some((h) => /Price/.test(h)));
  const out = {};
  if (borrow) { const latest = (borrow.rows || [])[0]; out.latest_borrow_rate_pct = num(latest?.[1]); out.latest_rebate_rate_pct = num(latest?.[2]); }
  if (sv) {
    const recent = (sv.rows || []).slice(0, 10);
    const svRatios = recent.map((r) => { const s = dollarMag(r[2]); const tv = dollarMag(r[3]); return s != null && tv ? s / tv : null; }).filter((x) => x != null);
    out.short_vol_pct_recent_avg = svRatios.length ? svRatios.reduce((a, b) => a + b, 0) / svRatios.length : null;
    out.short_vol_recent_rows = recent.length;
  }
  if (ftd) {
    const rows = ftd.rows || [];
    out.ftd_history_rows = rows.length;
    out.ftd_latest = rows.slice(0, 3).map((r) => ({ date: r[0], qty: num((r[1] || '').replace(/,/g, '')), price: num(r[2]) }));
  }
  return out;
}

function analyzeEarnings(row) {
  if (!row) return null;
  const t = findTable(row, (h) => /Implied Move/.test(h));
  if (!t) return { error: 'no earnings table' };
  const rows = (t.rows || []).filter((r) => Array.isArray(r) && r.length >= 14);
  const recent = rows.slice(0, 8).map((r) => ({ date: r[1], actual_eps: num(r[3]), consensus_eps: num(r[4]), beat_miss_pct: num(r[5]), implied_move_pct: num(r[7]), one_d_move_pct: num(r[12]) }));
  const beats = recent.filter((r) => (r.beat_miss_pct || 0) > 0).length;
  const oneDMoves = recent.map((r) => r.one_d_move_pct).filter((x) => x != null);
  const absMoveAvg = oneDMoves.length ? oneDMoves.reduce((a, b) => a + Math.abs(b), 0) / oneDMoves.length : null;
  return { recent_earnings: recent, beat_rate_last_n: recent.length ? beats / recent.length : null, abs_1d_move_avg_pct: absMoveAvg };
}

function analyzeAnalysts(row, spot) {
  if (!row) return null;
  const t = findTable(row, (h) => /Price Target|Recommendation/.test(h));
  if (!t) return { error: 'no analyst table' };
  const rows = (t.rows || []).filter((r) => Array.isArray(r) && r.length >= 5);
  const targets = rows.map((r) => num(r[2])).filter((x) => x != null);
  const targetMean = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null;
  const targetMin = targets.length ? Math.min(...targets) : null;
  const targetMax = targets.length ? Math.max(...targets) : null;
  return { n_analysts: rows.length, target_mean: targetMean, target_min: targetMin, target_max: targetMax, target_vs_spot_pct: spot && targetMean ? ((targetMean - spot) / spot) * 100 : null, recent_5: rows.slice(0, 5).map((r) => ({ date: r[0], analyst: r[1], target: num(r[2]), move_pct: num(r[3]), rec: r[4] })) };
}

function analyzeInstitutions(row) {
  if (!row) return null;
  const t = findTable(row, (h) => /% Outstanding/.test(h));
  if (!t) return { error: 'no institutions table' };
  const rows = (t.rows || []).filter((r) => Array.isArray(r) && r.length >= 6).slice(0, 10);
  return { top_holders: rows.map((r) => ({ name: r[0], units: r[1], pct_units_change: num(r[2]), pct_outstanding: num(r[3]), avg_price: num(r[5]) })) };
}

function analyzeMaxPain(row) {
  if (!row) return null;
  const t = findTable(row, (h) => /Max Pain/.test(h));
  if (!t) return { error: 'no max-pain table on greeks page' };
  return { max_pain_per_expiry: (t.rows || []).slice(0, 6).map((r) => ({ expiry: r[1], max_pain: num(r[2]), pct_diff_to_current: num(r[3]) })) };
}

function analyzeChainsGrid(row, spot) {
  if (!row) return null;
  // UW chains table: rows have 34 cells. Mapping verified 2026-05-14:
  // CALLS side cells[0-15]: Charm,Vanna,Vega,Theo,Gamma,Theta,Delta,IV,Bid/AskVol,Avg,High,Low,Last,OI,OI,Volume
  // cells[16]=Strike. PUTS side cells[17-32]: Volume,OI,OI,Last,Low,High,Avg,Bid/AskVol,IV,Delta,Theta,Gamma,Theo,Vega,Vanna,Charm
  const t = findTable(row, (h) => h === 'CALLS' || h === 'Strike');
  if (!t) return { error: 'no chains grid table' };
  const rows = (t.rows || []).filter((r) => Array.isArray(r) && r.length >= 30);
  if (!rows.length || spot == null) return { error: 'empty rows or no spot' };
  let bestRow = null; let bestDiff = Infinity;
  for (const r of rows) {
    const k = num(r[16]); if (k == null) continue;
    const d = Math.abs(k - spot);
    if (d < bestDiff) { bestDiff = d; bestRow = r; }
  }
  if (!bestRow) return { error: 'no atm row matched' };
  const atmStrike = num(bestRow[16]);
  const callDelta = num(bestRow[6]);
  const callIV = pct(bestRow[7]);
  const callVol = num((bestRow[15] || '').replace(/,/g, ''));
  const callOI = num((bestRow[14] || '').replace(/,/g, ''));
  const putVol = num((bestRow[17] || '').replace(/,/g, ''));
  const putOI = num((bestRow[18] || '').replace(/,/g, ''));
  const putIV = pct(bestRow[25]);
  const putDelta = num(bestRow[26]);
  const otmCalls = rows.filter((r) => { const k = num(r[16]); return k != null && k > spot; });
  const otmPuts = rows.filter((r) => { const k = num(r[16]); return k != null && k < spot; });
  const c25 = otmCalls.find((r) => { const d = num(r[6]); return d != null && Math.abs(d - 0.25) < 0.08; });
  const p25 = otmPuts.find((r) => { const d = num(r[26]); return d != null && Math.abs(Math.abs(d) - 0.25) < 0.08; });
  const skew = c25 && p25 ? pct(p25[25]) - pct(c25[7]) : null;
  let totalCallOI = 0; let totalPutOI = 0;
  for (const r of rows) {
    const cOI = num((r[14] || '').replace(/,/g, ''));
    const pOI = num((r[18] || '').replace(/,/g, ''));
    if (cOI != null && cOI > 0) totalCallOI += cOI;
    if (pOI != null && pOI > 0) totalPutOI += pOI;
  }
  return { atm_strike: atmStrike, atm_diff_from_spot: bestDiff, atm_call_iv_pct: callIV, atm_put_iv_pct: putIV, atm_call_delta: callDelta, atm_put_delta: putDelta, atm_call_volume: callVol, atm_put_volume: putVol, atm_call_oi: callOI, atm_put_oi: putOI, skew_25d_put_minus_call_iv_pct: skew, total_call_oi: totalCallOI, total_put_oi: totalPutOI, put_call_oi_ratio: totalCallOI ? totalPutOI / totalCallOI : null, n_strikes: rows.length };
}

function extractSpot(byPage) {
  const overview = byPage.get('overview');
  const text = overview?.data?.bodyText || '';
  const m = text.match(/\$([\d.]+)\s*[+−-][\d.]+\s*\(/);
  if (m) return Number(m[1]);
  return null;
}

function extractNextEarnings(byPage) {
  const overview = byPage.get('overview');
  const text = overview?.data?.bodyText || '';
  const m = text.match(/Earnings\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  return m ? m[1] : null;
}

const byPage = await latestByPage();
const spot = extractSpot(byPage);
const nextEarnings = extractNextEarnings(byPage);
const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
const tomorrowMonth = tomorrow.toLocaleString('en-US', { month: 'short' });

const dossier = {
  ticker: TICKER,
  scrape_pages_available: [...byPage.keys()].sort(),
  context: { spot, next_earnings: nextEarnings, tomorrow_iso: tomorrow.toISOString().slice(0, 10), tomorrow_month: tomorrowMonth },
  signals_now: {
    option_flow: analyzeOptionFlow(byPage.get('option_flow_alerts')),
    darkpool: analyzeDarkpool(byPage.get('darkpool')),
  },
  positioning: {
    max_pain: analyzeMaxPain(byPage.get('greeks')),
    chains_atm: analyzeChainsGrid(byPage.get('chains'), spot),
  },
  history: {
    seasonality_this_month: analyzeSeasonality(byPage.get('seasonality'), tomorrowMonth),
    shorts: analyzeShorts(byPage.get('shorts')),
    earnings: analyzeEarnings(byPage.get('earnings')),
    institutions: analyzeInstitutions(byPage.get('institutions')),
  },
  structural: {
    analysts: analyzeAnalysts(byPage.get('analysts'), spot),
  },
};

process.stdout.write(JSON.stringify(dossier, null, 2) + '\n');
