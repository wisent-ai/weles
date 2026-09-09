// How long the research runs and what it is worth. The saturation loop keeps
// asking the model router which paid-search intents are still uncovered, runs
// each new batch of seed keywords through Keyword Planner, merges the metric
// rows it gets back, and stops when the router says the intents are covered or
// offers nothing new. The ranking turns those rows into ordered opportunities.

import { normalizeKeyword } from './request_intake.mjs';
import { runKeywordPlanner } from './keeper_harvest.mjs';
import { generateKeywordsWithRouter } from './model_router.mjs';

function parseVolume(row) {
  const explicit = Number(row?.avgMonthlySearches);
  if (Number.isFinite(explicit)) return explicit;
  const digits = String(row?.avgMonthlySearchesText || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

function parseBid(row, key) {
  const n = Number(String(row?.[key] || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseSignedPercent(value) {
  const n = Number(String(value || '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Google Ads labels competition Low, Medium or High. Low costs a keyword
// nothing in this ranking, and so does a row Google left unlabelled.
function competitionPenalty(competition) {
  if (competition === 'Medium') return 0.2;
  if (competition === 'High') return 0.45;
  return 0;
}

function rankKeywordRows(rows) {
  return [...(rows || [])].map((row) => {
    const volume = parseVolume(row);
    const yoy = parseSignedPercent(row.yoyChange);
    const lowBid = parseBid(row, 'topOfPageBidLow');
    const competition = row.competition || null;
    const score = Math.log10(volume + 1) + Math.max(-1, Math.min(2, yoy / 100)) - competitionPenalty(competition) - (lowBid ? Math.min(0.4, lowBid / 25) : 0);
    return { ...row, score: Number(score.toFixed(4)) };
  }).sort((a, b) => b.score - a.score);
}

function uniqueKeywords(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const keyword = normalizeKeyword(value);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

function mergeRows(existingRows, newRows) {
  const byKeyword = new Map(existingRows.map((row) => [normalizeKeyword(row.keyword).toLowerCase(), row]));
  for (const row of newRows || []) {
    const key = normalizeKeyword(row.keyword).toLowerCase();
    if (!key || byKeyword.has(key)) continue;
    byKeyword.set(key, row);
  }
  return [...byKeyword.values()];
}


export async function runKeywordReport(input, generation) {
  let keywords = uniqueKeywords([...input.seedKeywords, ...generation.keywords]);
  if (!keywords.length) throw new Error('no keyword candidates to check');

  const generations = [generation];
  const rounds = [];
  const checkedKeywords = [];
  const checkedKeys = new Set();
  let rows = [];
  let lastRun = null;
  let accountEmail = null;
  let capturedAt = null;
  let url = null;
  let stdout = '';
  let stderr = '';
  let saturated = Boolean(generation.saturated);
  let saturationRationale = generation.rationale || null;

  while (true) {
    const pendingKeywords = keywords.filter((keyword) => !checkedKeys.has(keyword.toLowerCase()));
    if (pendingKeywords.length) {
      const run = await runKeywordPlanner({ ...input, keywords: pendingKeywords });
      lastRun = run;
      for (const keyword of pendingKeywords) {
        checkedKeys.add(keyword.toLowerCase());
        checkedKeywords.push(keyword);
      }
      stdout += `\n--- saturation round ${rounds.length + 1} stdout ---\n${run.stdout || ''}`;
      stderr += `\n--- saturation round ${rounds.length + 1} stderr ---\n${run.stderr || ''}`;

      const roundRows = run.report?.rows || [];
      rows = mergeRows(rows, roundRows);
      accountEmail = run.report?.accountEmail || accountEmail;
      capturedAt = run.report?.capturedAt || capturedAt;
      url = run.report?.url || url;

      rounds.push({
        keywords: pendingKeywords,
        ok: Boolean(run.ok),
        exitCode: run.exitCode,
        rowCount: roundRows.length,
        blocked: run.report?.blocked || null,
        resultFile: run.resultFile,
      });

      if (run.report?.blocked === 'keeper_not_ready') break;
    }

    if (saturated) break;

    const nextGeneration = await generateKeywordsWithRouter(input, { checkedKeywords, rows });
    generations.push(nextGeneration);
    saturated = Boolean(nextGeneration.saturated);
    saturationRationale = nextGeneration.rationale || saturationRationale;
    const nextKeywords = uniqueKeywords(nextGeneration.keywords)
      .filter((keyword) => !keywords.some((existing) => existing.toLowerCase() === keyword.toLowerCase()));
    if (!nextKeywords.length) {
      saturated = true;
      saturationRationale = nextGeneration.rationale || 'model-router returned no new deduped intent keywords';
      break;
    }
    keywords = uniqueKeywords([...keywords, ...nextKeywords]);
  }

  const uncheckedKeywords = keywords.filter((keyword) => !checkedKeys.has(keyword.toLowerCase()));
  return {
    ok: rows.length > 0,
    exitCode: rows.length > 0 ? 0 : lastRun?.exitCode ?? 7,
    resultFile: lastRun?.resultFile || null,
    stdout,
    stderr,
    keeper: lastRun?.keeper || null,
    report: {
      ok: rows.length > 0,
      source: 'google_ads_keyword_planner_saturation_report',
      session: input.session,
      customer: input.customerId,
      accountEmail,
      keywords,
      checkedKeywords,
      uncheckedKeywords,
      rows,
      capturedAt,
      url,
      rounds,
      generations,
      saturated,
      saturationRationale,
    },
  };
}

export function buildKeywordReport(input, generation, run) {
  const rows = run.report?.rows || [];
  const ranked = rankKeywordRows(rows);
  return {
    ok: Boolean(run.ok),
    source: 'weles_keyword_report',
    customer: input.customerId,
    accountEmail: run.report?.accountEmail || null,
    subject: input.subject || null,
    product: input.product || null,
    niche: input.niche || null,
    audience: input.audience || null,
    generated: generation,
    generations: run.report?.generations || [generation],
    saturated: Boolean(run.report?.saturated),
    saturationRationale: run.report?.saturationRationale || null,
    metrics: {
      ok: Boolean(run.report?.ok),
      rowCount: rows.length,
      checkedKeywordCount: run.report?.checkedKeywords?.length || 0,
      uncheckedKeywordCount: run.report?.uncheckedKeywords?.length || 0,
      roundCount: run.report?.rounds?.length || 0,
      capturedAt: run.report?.capturedAt || null,
      url: run.report?.url || null,
    },
    checkedKeywords: run.report?.checkedKeywords || [],
    uncheckedKeywords: run.report?.uncheckedKeywords || [],
    rounds: run.report?.rounds || [],
    topOpportunities: ranked,
    rows,
    plannerReport: run.report,
  };
}
