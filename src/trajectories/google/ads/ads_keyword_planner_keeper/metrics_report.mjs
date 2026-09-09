// Reading the numbers off the planner table and writing them down. Each keyword
// this run asked about is looked up in the rendered text, the fourteen lines
// that follow it carry its monthly searches, its two changes, its competition
// band and its top-of-page bids, and the harvest record is what the caller of
// this runner reads.

import { SESSION, cid, dashedCustomerId, keywords, norm, preferredEmail, writeResult } from './run_brief.mjs';
import { evalState, idle } from './keeper_browser.mjs';

function parseMoney(value) {
  const match = String(value || '').match(/(?:US)?\$\s?\d+(?:[,.]\d+)?/i);
  return match ? match[0].replace(/\s+/g, '') : null;
}

export function parseRows(text) {
  const lines = String(text || '').split(/\r?\n/).map(norm).filter(Boolean);
  const rows = [];
  for (const keyword of keywords) {
    const wanted = keyword.toLowerCase();
    const index = lines.findIndex((line) => line.toLowerCase() === wanted || line.toLowerCase().includes(wanted));
    if (index < 0) continue;
    const window = lines.slice(index, index + 14);
    const monthly = window.find((line, i) => i > 0 && /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(line));
    const changes = window.filter((line) => /^[-+]?\d+%$/.test(line));
    const competition = window.find((line) => /^(Low|Medium|High)$/i.test(line)) || null;
    const bids = window.map(parseMoney).filter(Boolean);
    rows.push({
      keyword: window[0] || keyword,
      avgMonthlySearches: monthly ? Number(monthly.replace(/,/g, '')) : null,
      avgMonthlySearchesText: monthly || null,
      threeMonthChange: changes[0] || null,
      yoyChange: changes[1] || null,
      competition,
      adImpressionShare: window.find((line) => /^<?\s?\d+(?:\.\d+)?%$/.test(line)) || null,
      topOfPageBidLow: bids[0] || null,
      topOfPageBidHigh: bids[1] || null,
      raw: window,
    });
  }
  return rows.filter((row) => row.avgMonthlySearchesText || row.competition || row.topOfPageBidLow);
}

export async function waitForResults() {
  let last = null;
  for (let i = 0; i < 48; i += 1) {
    await idle('short');
    const s = await evalState(20_000);
    last = s;
    const rows = parseRows(s.text || '');
    if (rows.length) return { state: s, rows };
    if (/No keywords|No results|No account|Unable|error/i.test(s.text || '') && /Keyword Planner/i.test(s.text || '')) break;
  }
  return { state: last || await evalState(20_000), rows: [] };
}

export function writeKeywordReport(result, steps) {
  const report = {
    ok: result.rows.length > 0,
    source: 'google_ads_keyword_planner_keeper_existing_window',
    session: SESSION,
    customer: cid,
    customerDashed: dashedCustomerId(cid),
    accountEmail: preferredEmail(),
    keywords,
    url: result.state?.url || '',
    title: result.state?.title || '',
    capturedAt: new Date().toISOString(),
    rows: result.rows,
    textPreview: norm(result.state?.text || '').slice(0, 3000),
    steps,
  };
  writeResult(report, report.ok ? 0 : 7);
}
