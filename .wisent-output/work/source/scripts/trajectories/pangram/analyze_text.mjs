// Analyze operator-provided text in Pangram's dashboard.
//
// Input precedence:
//   PANGRAM_TEXT > SVC_TEXT > TEXT > PANGRAM_TEXT_FILE > TEXT_FILE > MESSAGE_FILE
//
// Output:
//   recordings/<run>/<action>/pangram_result.json
//   recordings/<run>/<action>/ban_signal.json

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { getSocialAccount, markCookiesStale, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { detectPangramBanSignals } from '../../../dist/platforms/pangram/ban_signals.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { humanClickLocator, humanMove } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { CookieJarStaleError, loadFreshCookieJarOrFail } from '../_shared/cookie-freshness.mjs';

const LABEL = 'pangram_analyze_text';
const RESULT_FILE = 'pangram_result.json';

function baseUrl(raw, fallback) {
  return String(raw || fallback).replace(/\/+$/, '');
}

function dashboardUrl() {
  if (process.env.PANGRAM_ANALYZE_URL) return process.env.PANGRAM_ANALYZE_URL;
  const base = baseUrl(process.env.PANGRAM_BASE_URL || process.env.PANGRAM_URL, 'https://www.pangram.com');
  return `${base}/`;
}

function inputText() {
  const direct = process.env.PANGRAM_TEXT || process.env.SVC_TEXT || process.env.TEXT || '';
  if (direct.trim()) return direct;
  const path = process.env.PANGRAM_TEXT_FILE || process.env.TEXT_FILE || process.env.MESSAGE_FILE || '';
  if (path && existsSync(path)) return readFileSync(path, 'utf8');
  return '';
}

function textStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return {
    chars: text.length,
    words,
    sha256: createHash('sha256').update(text).digest('hex'),
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

function writeJson(name, value) {
  const dir = runRecordingsDir(process.env.ACTION || LABEL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

function supabaseEnv() {
  const url = process.env.WELES_DATABASE_URL ?? '';
  const key = process.env.WELES_DATABASE_TOKEN ?? '';
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function accountKey(acct) {
  return String(acct?.id || acct?.username || 'unknown');
}

function accountDomain(acct) {
  const raw = String(acct?.metadata?.email || acct?.username || '');
  const hit = raw.toLowerCase().match(/@([^>\s]+)/);
  return hit?.[1] || 'unknown';
}

function usageLedgerPath() {
  return process.env.PANGRAM_ACCOUNT_USAGE_FILE || join(process.env.HOME || process.cwd(), '.weles', 'pangram-account-usage.json');
}

function readUsageLedger() {
  const path = usageLedgerPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeUsageLedger(ledger) {
  const path = usageLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

function dailyAccountLimit() {
  const raw = Number(process.env.PANGRAM_ACCOUNT_DAILY_SCAN_LIMIT || 4);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
}

function usageCount(ledger, acct) {
  return Number(ledger?.[todayKey()]?.[accountKey(acct)]?.scan_attempts || 0);
}

function recordAccountUse(acct, stats, pool) {
  if (!acct) return null;
  const ledger = readUsageLedger();
  const day = todayKey();
  ledger[day] = ledger[day] || {};
  const key = accountKey(acct);
  const prev = ledger[day][key] || {};
  ledger[day][key] = {
    account_id: acct.id ?? null,
    username: acct.username ?? null,
    domain: accountDomain(acct),
    scan_attempts: Number(prev.scan_attempts || 0) + 1,
    daily_limit: dailyAccountLimit(),
    last_input_sha256: stats.sha256,
    last_used_at: new Date().toISOString(),
    pool_available_before_run: pool?.available_count ?? null,
  };
  writeUsageLedger(ledger);
  return ledger[day][key];
}

function markAccountExhausted(acct, stats, pool, reason, creditState = null) {
  if (!acct) return null;
  const ledger = readUsageLedger();
  const day = todayKey();
  ledger[day] = ledger[day] || {};
  const key = accountKey(acct);
  const prev = ledger[day][key] || {};
  ledger[day][key] = {
    ...prev,
    account_id: acct.id ?? null,
    username: acct.username ?? null,
    domain: accountDomain(acct),
    scan_attempts: dailyAccountLimit(),
    daily_limit: dailyAccountLimit(),
    exhausted: true,
    exhausted_reason: reason,
    credit_state: creditState,
    last_input_sha256: stats.sha256,
    last_used_at: new Date().toISOString(),
    pool_available_before_run: pool?.available_count ?? null,
  };
  writeUsageLedger(ledger);
  return ledger[day][key];
}

function maxAccountAttempts() {
  const raw = Number(process.env.PANGRAM_MAX_ACCOUNT_ATTEMPTS || 8);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}

function registerAfterCreditFailures() {
  const raw = Number(process.env.PANGRAM_REGISTER_AFTER_CREDIT_FAILURES || 1);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function autoRegisterLedgerPath() {
  return process.env.PANGRAM_AUTO_REGISTER_LEDGER_FILE || join(process.env.HOME || process.cwd(), '.weles', 'pangram-auto-register.json');
}

function readAutoRegisterLedger() {
  const path = autoRegisterLedgerPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAutoRegisterLedger(ledger) {
  const path = autoRegisterLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

function maxAutoRegisters() {
  const raw = Number(process.env.PANGRAM_MAX_AUTO_REGISTERS || 3);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
}

function autoRegisterDirectFallbackEnabled() {
  return process.env.PANGRAM_AUTO_REGISTER_DIRECT_FALLBACK !== '0';
}

function autoRegisterCountToday(ledger) {
  return Number(ledger?.[todayKey()]?.count || 0);
}

async function runPangramRegisterChild(reason, mode, extraEnv = {}) {
  const ledger = readAutoRegisterLedger();
  const limit = maxAutoRegisters();
  const todayCount = autoRegisterCountToday(ledger);
  if (todayCount >= limit) {
    return { success: false, reason: `daily_auto_register_limit ${todayCount}/${limit}` };
  }

  const script = process.env.PANGRAM_REGISTER_SCRIPT || join(process.cwd(), 'scripts/trajectories/pangram/register.mjs');
  if (!existsSync(script)) {
    return { success: false, reason: `register_script_not_found:${script}` };
  }

  const childEnv = {
    ...process.env,
    ...extraEnv,
    PANGRAM_AUTO_REGISTER_RUN: '1',
    WELES_RUN_ID: process.env.WELES_RUN_ID || `pangram-auto-register-${Date.now()}`,
    ACTION: `pangram_auto_register_${mode}_${Date.now()}`,
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      const success = code === 0 && /PASS:\s*pangram account ready/i.test(stdout);
      ledger[todayKey()] = ledger[todayKey()] || { count: 0, runs: [] };
      ledger[todayKey()].count += 1;
      ledger[todayKey()].runs.push({
        reason,
        mode,
        success,
        exitCode: code,
        ts: new Date().toISOString(),
        stdoutTail: stdout.slice(-2000),
        stderrTail: stderr.slice(-1000),
      });
      writeAutoRegisterLedger(ledger);
      resolve({ success, reason: success ? 'registered' : `register_failed:${code}`, stdout, stderr, ledgerDay: ledger[todayKey()] });
    });
  });
}

async function autoRegisterPangramAccount(reason) {
  const first = await runPangramRegisterChild(reason, 'proxy');
  if (first.success || !autoRegisterDirectFallbackEnabled()) return first;

  const output = `${first.reason}\n${first.stdout || ''}\n${first.stderr || ''}`;
  if (!/net::ERR_|proxy|auth|credential|abort/i.test(output)) return first;

  console.log(`[pangram:analyze_text] auto_register proxy failed; retrying direct reason=${first.reason}`);
  const fallback = await runPangramRegisterChild(`${reason}:direct_fallback`, 'direct', { PANGRAM_NO_PROXY: '1' });
  return fallback.success
    ? { ...fallback, fallback_from: first.reason }
    : { ...fallback, fallback_from: first.reason };
}

function domainSummary(accounts) {
  const counts = {};
  for (const acct of accounts || []) {
    const domain = accountDomain(acct);
    counts[domain] = (counts[domain] || 0) + 1;
  }
  return counts;
}

async function fetchActivePangramAccounts() {
  const env = supabaseEnv();
  if (!env) return { accounts: [], reason: 'missing_supabase_env' };
  const headers = { apikey: env.key, Authorization: `Bearer ${env.key}` };
  const selected = 'id,platform,username,metadata,created_at';
  const accountId = process.env.ACCOUNT_ID?.trim();
  const query = accountId
    ? `id=eq.${encodeURIComponent(accountId)}&platform=eq.pangram&is_active=eq.true&select=${selected}&limit=1`
    : `platform=eq.pangram&is_active=eq.true&select=${selected}&order=created_at.asc&limit=${encodeURIComponent(process.env.PANGRAM_ACCOUNT_POOL_LIMIT || '100')}`;
  const res = await fetch(`${env.url}/rest/v1/social_accounts?${query}`, { headers });
  if (!res.ok) return { accounts: [], reason: `supabase_${res.status}` };
  const accounts = await res.json().catch(() => []);
  return { accounts: Array.isArray(accounts) ? accounts : [], reason: accounts?.length ? null : 'no_account' };
}

function sortCandidatesByUsage(accounts, ledger) {
  return [...accounts].sort((a, b) => {
    const usageDelta = usageCount(ledger, a) - usageCount(ledger, b);
    if (usageDelta !== 0) return usageDelta;
    const createdA = Date.parse(a.created_at || '') || 0;
    const createdB = Date.parse(b.created_at || '') || 0;
    return createdB - createdA;
  });
}

async function selectSingleConfiguredAccount() {
  const acct = await getSocialAccount('pangram');
  if (!acct) return { account: null, reason: 'no_account', pool: { available_count: 0, total_accounts: 0 } };
  const sessionOpts = await resolveAccountSession(acct);
  const cookies = loadFreshCookieJarOrFail(acct, {
    platform: 'pangram',
    label: LABEL,
    currentProxyUrl: sessionOpts.proxyUrl,
    currentPersona: sessionOpts.persona,
  });
  return { account: acct, sessionOpts, cookies, reason: null, pool: { available_count: 1, total_accounts: 1 } };
}

async function selectPangramAccountForRun() {
  if (process.env.PANGRAM_ACCOUNT_ROTATION === '0') return selectSingleConfiguredAccount();

  const fetched = await fetchActivePangramAccounts();
  const ledger = readUsageLedger();
  const limit = dailyAccountLimit();
  const accounts = fetched.accounts || [];
  const underLimit = accounts.filter((acct) => usageCount(ledger, acct) < limit);
  const candidates = sortCandidatesByUsage(underLimit, ledger);
  const rejected = [];

  for (const acct of candidates) {
    try {
      const sessionOpts = await resolveAccountSession(acct);
      const cookies = loadFreshCookieJarOrFail(acct, {
        platform: 'pangram',
        label: LABEL,
        currentProxyUrl: sessionOpts.proxyUrl,
        currentPersona: sessionOpts.persona,
      });
      return {
        account: acct,
        sessionOpts,
        cookies,
        reason: null,
        pool: {
          total_accounts: accounts.length,
          available_count: candidates.length,
          rejected_count: rejected.length,
          daily_limit_per_account: limit,
          selected_usage_before_run: usageCount(ledger, acct),
          domains: domainSummary(accounts),
        },
      };
    } catch (err) {
      const reason = err instanceof CookieJarStaleError ? (err.details?.reason || 'stale_cookies') : (err.message || 'account_unusable');
      rejected.push({ account_id: acct.id ?? null, username: acct.username ?? null, reason: String(reason).slice(0, 120) });
      if (err instanceof CookieJarStaleError && acct.id) await markCookiesStale(acct.id).catch(() => {});
    }
  }

  const exhaustedByUsage = accounts.length > 0 && underLimit.length === 0;
  return {
    account: null,
    reason: exhaustedByUsage ? 'quota_exhausted' : (fetched.reason || 'no_fresh_account'),
    pool: {
      total_accounts: accounts.length,
      available_count: candidates.length,
      exhausted_by_daily_limit: accounts.length - underLimit.length,
      rejected_count: rejected.length,
      rejected_accounts: rejected.slice(0, 10),
      daily_limit_per_account: limit,
      domains: domainSummary(accounts),
    },
  };
}

async function withTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizePercent(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return Math.round(value * 10_000) / 100;
  if (value >= 0 && value <= 100) return Math.round(value * 100) / 100;
  return null;
}

function classifyLabel(value) {
  const s = String(value || '').toLowerCase();
  if (/ai[\s-]?assisted|assisted by ai|ai assistance/.test(s)) return 'ai_assisted';
  if (/ai[\s-]?generated|generated by ai|written by ai|likely ai/.test(s)) return 'ai_generated';
  if (s.trim() === 'ai') return 'ai_generated';
  if (/human[\s-]?written|written by human|likely human|\bhuman\b/.test(s)) return 'human';
  return null;
}

function mergeResult(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && v !== undefined && out[k] === undefined) out[k] = v;
  }
  return out;
}

function extractFromObject(obj) {
  const found = {};
  const labels = [];

  function visit(value, path = []) {
    if (value === null || value === undefined) return;
    const key = String(path[path.length - 1] || '').toLowerCase();
    const joined = path.join('.').toLowerCase();
    if (typeof value === 'number') {
      const pct = normalizePercent(value);
      if (pct === null) return;
      if (/confidence|certainty/.test(joined)) found.confidence_percent = pct;
      else if (/human/.test(joined) && /(score|prob|percent|pct|likelihood|ratio|prediction)/.test(joined)) found.human_percent = pct;
      else if (/(^|\.)(ai|machine|generated|synthetic)/.test(joined) && /(score|prob|percent|pct|likelihood|ratio|prediction)/.test(joined)) found.ai_percent = pct;
      else if (/score|probability|prediction|percent|pct/.test(key) && labels.some((l) => classifyLabel(l) === 'ai_generated')) found.ai_percent = pct;
      return;
    }
    if (typeof value === 'string') {
      const label = classifyLabel(value);
      if (label && !found.verdict) found.verdict = label;
      if (label) labels.push(value);
      const pct = value.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (pct && /confidence|certain/i.test(joined)) found.confidence_percent = normalizePercent(pct[1]);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 50).forEach((v, i) => visit(v, [...path, String(i)]));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, [...path, k]);
    }
  }

  visit(obj);
  if (found.ai_percent !== undefined && found.human_percent === undefined) found.human_percent = Math.round((100 - found.ai_percent) * 100) / 100;
  if (found.human_percent !== undefined && found.ai_percent === undefined) found.ai_percent = Math.round((100 - found.human_percent) * 100) / 100;
  return Object.keys(found).length ? { source: 'api', ...found } : null;
}

function extractFromPangramClassify(parsed) {
  const task = Array.isArray(parsed?.tasks) ? parsed.tasks.find((t) => t?.status === 'success' && t?.result?.response?.overall) : null;
  const overall = task?.result?.response?.overall;
  if (!overall) return null;
  const prediction = overall.prediction_short || overall.headline || overall.prediction;
  let verdict = classifyLabel(prediction);
  if (!verdict) {
    const ai = normalizePercent(overall.fraction_ai);
    const human = normalizePercent(overall.fraction_human);
    if (ai !== null && human !== null) verdict = ai > human ? 'ai_generated' : 'human';
  }
  const aiPercent = normalizePercent(overall.fraction_ai);
  const humanPercent = normalizePercent(overall.fraction_human);
  const aiAssistedPercent = normalizePercent(overall.fraction_ai_assisted);
  const confidencePercent = normalizePercent(overall.avg_ai_likelihood);
  return {
    source: 'api',
    api_kind: 'classify-text-sliding-window',
    verdict,
    ai_percent: aiPercent,
    human_percent: humanPercent,
    ai_assisted_percent: aiAssistedPercent,
    avg_ai_likelihood_percent: confidencePercent,
    prediction: overall.prediction || null,
    prediction_short: overall.prediction_short || null,
    headline: overall.headline || null,
    textquery_uuid: task.result.textquery_uuid || null,
  };
}

function extractFromResponses(responses) {
  const skipUrl = /\/api\/(?:feature-flags|session-status|accounts\/get-csrf|user-profiles|plan|team\/pending-invite|cello-create-token)\b/i;
  const interesting = [...responses].reverse().filter((r) => /api|graphql|scan|detect|document|submission|classif|analysis/i.test(r.url) && !skipUrl.test(r.url));
  for (const r of interesting) {
    if (!r.body || !/^[\s[{]/.test(r.body)) continue;
    try {
      const parsed = JSON.parse(r.body);
      const result = /classify-text-sliding-window\/status/i.test(r.url)
        ? extractFromPangramClassify(parsed)
        : extractFromObject(parsed);
      if (result) {
        return {
          ...result,
          response_url: r.url,
          response_status: r.status,
        };
      }
    } catch {
      // Ignore non-JSON API bodies.
    }
  }
  return null;
}

function recordingResponsesFromFiles() {
  const responses = [];
  const dirs = [runRecordingsDir(LABEL), runRecordingsDir(process.env.ACTION || LABEL)];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const filePath = join(dir, name);
      if (name === 'network.ndjson') {
        for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            responses.push({
              url: row.url,
              status: row.status,
              body: row.body,
            });
          } catch {
            // Ignore malformed network rows.
          }
        }
      }
      if (name === 'session.har') {
        try {
          const har = JSON.parse(readFileSync(filePath, 'utf8'));
          for (const entry of har?.log?.entries ?? []) {
            responses.push({
              url: entry?.request?.url,
              status: entry?.response?.status,
              body: entry?.response?.content?.text,
            });
          }
        } catch {
          // Ignore incomplete HAR snapshots.
        }
      }
    }
  }
  return responses;
}

function extractFromRecordedResponses() {
  const responses = recordingResponsesFromFiles();
  return responses.length ? extractFromResponses(responses) : null;
}

function extractFromText(bodyText) {
  const text = String(bodyText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let result = {};
  const resultCue = /(?:your|this)\s+(?:text|content|document|submission)\s+(?:is|was|looks|appears|seems|contains)|(?:analysis|result|verdict|score|probability|likely)\b/i.test(text);
  const marketingOnly = /an ai detector that actually works|detect ai-generated content with\s+\d{1,3}(?:\.\d+)?\s*%\s+accuracy/i.test(text) && !resultCue;
  if (marketingOnly) return null;

  const verdictHit =
    text.match(/(?:your|this)\s+(?:text|content|document|submission)\s+(?:is|was|looks|appears|seems|contains)[^.]{0,160}\b(ai[\s-]?assisted|ai[\s-]?generated|generated by ai|written by ai|likely ai|human[\s-]?written|written by human|likely human)\b/i);
  const verdict = classifyLabel(verdictHit?.[1] || verdictHit?.[0]);
  if (verdict) result.verdict = verdict;

  const nonMarketingPercent = (m) => {
    if (!m) return null;
    const around = text.slice(Math.max(0, (m.index ?? 0) - 90), (m.index ?? 0) + 140);
    const marketingPercent = /accuracy|free checks|third party verified|trusted by|ai detector that actually works/i.test(around);
    const analysisPercent = /(?:your|this)\s+(?:text|content|document|submission)\s+(?:is|was|looks|appears|seems|contains)|analysis|result|verdict|score|probability|likely/i.test(around);
    return marketingPercent && !analysisPercent ? null : normalizePercent(m[1]);
  };

  const aiNearPercent =
    text.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:ai[\s-]?generated|ai|machine|generated)/i) ||
    text.match(/(?:ai[\s-]?generated|ai content|ai writing|generated by ai)[^\d%]{0,60}(\d{1,3}(?:\.\d+)?)\s*%/i);
  const aiPct = nonMarketingPercent(aiNearPercent);
  if (aiPct !== null) result.ai_percent = aiPct;

  const humanNearPercent =
    text.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:human[\s-]?written|human)/i) ||
    text.match(/(?:human[\s-]?written|written by human|human content)[^\d%]{0,60}(\d{1,3}(?:\.\d+)?)\s*%/i);
  const humanPct = nonMarketingPercent(humanNearPercent);
  if (humanPct !== null) result.human_percent = humanPct;

  const conf = text.match(/confidence[^\d%]{0,40}(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (conf) result.confidence_percent = normalizePercent(conf[1]);

  if (result.ai_percent !== undefined && result.human_percent === undefined) result.human_percent = Math.round((100 - result.ai_percent) * 100) / 100;
  if (result.human_percent !== undefined && result.ai_percent === undefined) result.ai_percent = Math.round((100 - result.human_percent) * 100) / 100;
  if (result.verdict === 'human' && result.ai_percent === 100 && result.human_percent === 0) {
    result.ai_percent = 0;
    result.human_percent = 100;
  }
  if (result.verdict === 'ai_generated' && result.human_percent === 100 && result.ai_percent === 0) {
    result.ai_percent = 100;
    result.human_percent = 0;
  }
  if (result.ai_percent !== undefined && result.human_percent !== undefined && result.ai_percent !== result.human_percent) {
    result.verdict = result.ai_percent > result.human_percent ? 'ai_generated' : 'human';
  }
  if (!Object.keys(result).length) return null;
  return { source: 'ui', ...result, body_text_sample: text.slice(0, 500) };
}

function authRequiredState(finalUrl, result) {
  const url = String(finalUrl || '');
  const body = String(result?.body_text_sample || '');
  if (/\/signup\b/i.test(url) && /pendingCheck=true|pendingType=text/i.test(url)) {
    return 'signup_pending_check';
  }
  if (/sign up to check your text for ai|your text has been saved and will be checked immediately after you create your account|create your account to get started/i.test(body)) {
    return 'signup_required_for_result';
  }
  if (/\/(login|signin|sign-in|auth|session|sso)\b/i.test(url)) {
    return 'login_required';
  }
  return null;
}

async function firstWritableLocator(page) {
  const selectors = [
    'textarea[name="text"]',
    'textarea[name*="content" i]',
    'textarea[placeholder*="paste" i]',
    'textarea[placeholder*="text" i]',
    'textarea[placeholder*="document" i]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[type="text"]',
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 6); i++) {
      const one = loc.nth(i);
      const visible = await one.isVisible().catch(() => false);
      const disabled = await one.isDisabled().catch(() => false);
      if (visible && !disabled) return { locator: one, selector };
    }
  }
  return null;
}

async function waitForWritableLocator(page, timeoutMs = Number(process.env.PANGRAM_INPUT_READY_TIMEOUT_MS || 30_000)) {
  const deadline = Date.now() + timeoutMs;
  let lastURL = '';
  while (Date.now() < deadline) {
    const hit = await firstWritableLocator(page);
    if (hit) return hit;
    lastURL = page.url?.() ?? lastURL;
    await page.waitForTimeout(500).catch(() => {});
  }
  throw new Error(`pangram_input_not_found url=${lastURL}`);
}

async function fillInput(page, text) {
  const hit = await waitForWritableLocator(page);
  await hit.locator.scrollIntoViewIfNeeded().catch(() => {});
  if (process.env.PANGRAM_NO_ACCOUNT === '1') {
    await hit.locator.click({ timeout: 5000 }).catch(() => hit.locator.evaluate((el) => el.focus())); // allow-raw-playwright: public checker focus; avoids orphaned human mouse promise during Turnstile waits
  } else {
    await humanClickLocator(page, hit.locator).catch(() => hit.locator.click({ timeout: 5000 }).catch(() => hit.locator.evaluate((el) => el.focus()))); // allow-raw-playwright: focus fallback if humanized click cannot resolve
  }
  if (process.env.PANGRAM_NO_ACCOUNT === '1') {
    const warmupChars = Math.max(0, Number(process.env.PANGRAM_PUBLIC_HUMAN_WARMUP_CHARS || 0));
    const warmup = text.slice(0, warmupChars);
    if (warmup) await withTimeout(humanType(page, warmup), Number(process.env.PANGRAM_PUBLIC_HUMAN_WARMUP_TIMEOUT_MS || 30_000));
  }
  await hit.locator.fill(text, { timeout: 30_000 }); // allow-raw-playwright: after public checker warmup, paste full long section text without spending minutes typing
  const valueLength = await hit.locator.evaluate((el) => {
    if ('value' in el) return String(el.value || '').length;
    return String(el.innerText || el.textContent || '').length;
  }).catch(() => 0);
  if (valueLength < Math.min(text.length, 20)) throw new Error(`pangram_input_fill_failed selector=${hit.selector} length=${valueLength}`);
  return hit.selector;
}

async function dismissCookieBanner(page) {
  const cookieButtons = page.getByRole('button', { name: /allow all|accept all|zgadzam|akceptuj/i });
  const count = await cookieButtons.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 4); i++) {
    const btn = cookieButtons.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    const disabled = await btn.isDisabled().catch(() => true);
    if (visible && !disabled) {
      if (process.env.PANGRAM_NO_ACCOUNT === '1') {
        await btn.click({ timeout: 5000 }).catch(() => btn.evaluate((el) => el.click())); // allow-raw-playwright: public checker cookie click; avoids orphaned human mouse promise
      } else {
        await humanClickLocator(page, btn).catch(() => btn.click({ timeout: 5000 }).catch(() => btn.evaluate((el) => el.click()))); // allow-raw-playwright: cookie fallback if humanized click cannot resolve
      }
      await page.waitForTimeout(500).catch(() => {});
      return 'clicked';
    }
  }
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[id*="Cookie"], [class*="cookie"], [class*="Cookie"], [aria-label*="cookie" i], div'));
    let hidden = 0;
    for (const el of nodes) {
      const text = (el.textContent || '').slice(0, 500);
      if (/This website uses cookies|Allow all|Allow selection|cookie/i.test(text) && el.getClientRects().length) {
        el.style.pointerEvents = 'none';
        if (/This website uses cookies|Allow all|Allow selection/i.test(text)) {
          el.style.display = 'none';
          hidden += 1;
        }
      }
    }
    return hidden ? 'hidden' : 'none';
  }).catch(() => 'none'); // allow-raw-playwright: neutralise cookie banner that covers the scan button
}

async function clickAnalyze(page) {
  const labels = /scan|check|analy[sz]e|submit|run/i;
  const primaryLabels = /^(scan|check)\s+for\s+ai$/i;
  const skip = /scan for ai content|input your text|view results|access past records|detect ai assistance|accuracy|verified|free checks|upload|try it|partner|contact|login|allow/i;
  const byRole = page.getByRole('button', { name: labels });
  const roleCount = await byRole.count().catch(() => 0);
  const candidates = [];
  for (let i = 0; i < Math.min(roleCount, 20); i++) {
    const btn = byRole.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    const disabled = await btn.isDisabled().catch(() => true);
    const name = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (visible && !disabled && labels.test(name) && !skip.test(name)) candidates.push({ btn, name });
  }
  const primary = candidates.filter((c) => primaryLabels.test(c.name));
  const visiblePrimaryCount = await page.getByRole('button', { name: primaryLabels }).count().catch(() => 0);
  const usableCandidates = primary.length ? primary : (visiblePrimaryCount ? [] : candidates);
  usableCandidates.sort((a, b) => {
    const score = (s) => /scan\s*for\s*ai/i.test(s) ? 0 : /scan/i.test(s) ? 1 : /check/i.test(s) ? 2 : 3;
    return score(a.name) - score(b.name);
  });
  if (usableCandidates.length) {
    await usableCandidates[0].btn.scrollIntoViewIfNeeded().catch(() => {});
    if (process.env.PANGRAM_NO_ACCOUNT === '1') {
      await usableCandidates[0].btn.click({ timeout: 5000 }).catch(() => usableCandidates[0].btn.evaluate((el) => el.click())); // allow-raw-playwright: public checker submit; avoids orphaned human mouse promise
    } else {
      await humanClickLocator(page, usableCandidates[0].btn).catch(() => usableCandidates[0].btn.click({ timeout: 5000 }).catch(() => usableCandidates[0].btn.evaluate((el) => el.click()))); // allow-raw-playwright: scan fallback if humanized click cannot resolve
    }
    return `role:button:${usableCandidates[0].name.slice(0, 80)}`;
  }
  const clicked = await page.evaluate(() => {
    const labels = /scan|check|analy[sz]e|submit|run/i;
    const primaryLabels = /^(scan|check)\s+for\s+ai$/i;
    const skip = /scan for ai content|input your text|view results|access past records|detect ai assistance|accuracy|verified|free checks|upload|try it|partner|contact|login|allow/i;
    const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]'));
    const hits = buttons.filter((el) => {
      const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('value') || ''}`;
      return labels.test(text) && !skip.test(text) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    });
    const scoped = hits.filter((el) => primaryLabels.test((el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim()));
    const list = scoped.length ? scoped : hits;
    const score = (el) => {
      const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('value') || ''}`;
      if (/scan\s*for\s*ai/i.test(text)) return 0;
      if (/scan/i.test(text)) return 1;
      if (/check/i.test(text)) return 2;
      return 3;
    };
    list.sort((a, b) => score(a) - score(b));
    const hit = list[0];
    if (!hit) return null;
    hit.click();
    return (hit.textContent || hit.getAttribute('aria-label') || hit.getAttribute('value') || '').trim().slice(0, 80);
  }).catch(() => null);
  if (!clicked) throw new Error('pangram_analyze_button_not_found');
  return `dom:${clicked}`;
}

async function readVisibleCreditState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/Available\s+(\d+)\s*\/\s*(\d+)/i);
    if (!match) return null;
    return {
      available: Number(match[1]),
      total: Number(match[2]),
      sample: text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + 120)),
    };
  }).catch(() => null); // allow-raw-playwright: read-only visible Pangram credit state
}

async function publicVerificationState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const body = document.body?.innerText || '';
    const visibleFrames = Array.from(document.querySelectorAll('iframe')).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      const marker = [
        el.getAttribute('src') || '',
        el.getAttribute('title') || '',
        el.getAttribute('name') || '',
        el.getAttribute('id') || '',
        el.getAttribute('class') || '',
        el.outerHTML.slice(0, 500),
      ].join(' ');
      return {
        marker,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      };
    });
    const turnstileFrames = visibleFrames.filter((frame) => (
      /cloudflare|turnstile|challenge|cf-|verify|human/i.test(frame.marker) ||
      (frame.width >= 180 && frame.height >= 45 && frame.height <= 120)
    )).length;
    const turnstileContainers = Array.from(document.querySelectorAll('div')).filter((el) => {
      const text = (el.textContent || '').trim();
      const html = el.outerHTML || '';
      return !text && /turnstile|cf-turnstile|challenges\.cloudflare\.com/i.test(html);
    }).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        marker: (el.outerHTML || '').slice(0, 500),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        visible: visible(el),
      };
    });
    const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).map((el) => ({
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim(),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      visible: visible(el),
    }));
    const scanButtons = buttons.filter((b) => /^(scan|check)\s+for\s+ai$/i.test(b.text) && b.visible);
    return {
      turnstileFrames,
      turnstileContainers: turnstileContainers.length,
      turnstileContainerBoxes: turnstileContainers,
      visibleFrames,
      verifyText: /verify you are human/i.test(body),
      scanButtons,
      enabledScan: scanButtons.some((b) => !b.disabled),
    };
  }).catch(() => ({ turnstileFrames: 0, turnstileContainers: 0, turnstileContainerBoxes: [], visibleFrames: [], verifyText: false, scanButtons: [], enabledScan: false })); // allow-raw-playwright: read-only public checker state
}

async function clickPublicTurnstileIfPresent(page) {
  const selectors = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[title*="Cloudflare" i]',
    'iframe[title*="challenge" i]',
    'iframe[title*="security" i]',
    'iframe[name*="cf" i]',
    'iframe[id*="cf" i]',
    'iframe[class*="cf" i]',
    'iframe',
    '.cf-turnstile',
    '[class*="turnstile" i]',
    '[id*="turnstile" i]',
    '[data-sitekey]',
    '[data-callback]',
    'xpath=//input[@name="cf-turnstile-response"]/ancestor::div[1]',
    'xpath=//input[@name="cf-turnstile-response"]/ancestor::div[2]',
    'xpath=//input[contains(@id, "cf-chl-widget")]/ancestor::div[1]',
    'xpath=//input[contains(@id, "cf-chl-widget")]/ancestor::div[2]',
    'div',
  ];

  const tried = [];
  for (const selector of selectors) {
    const elements = page.locator(selector);
    const count = await elements.count().catch(() => 0);
    const maxCandidates = selector === 'div' ? 250 : 8;
    for (let i = 0; i < Math.min(count, maxCandidates); i++) {
      const elementLocator = elements.nth(i);
      const box = await elementLocator.boundingBox().catch(() => null);
      const visible = await elementLocator.isVisible().catch(() => false);
      if (!visible || !box || box.width < 80 || box.height < 30) continue;

      const title = await elementLocator.getAttribute('title').catch(() => '') ?? '';
      const src = await elementLocator.getAttribute('src').catch(() => '') ?? '';
      const html = await elementLocator.evaluate((el) => el.outerHTML?.slice(0, 800) || '').catch(() => '');
      const marker = `${selector} ${title} ${src} ${html}`;
      const markerLooksRelevant = /cloudflare|turnstile|challenge|verify|human/i.test(marker);
      const sizeLooksLikeWidget = box.width >= 120 && box.width <= 520 && box.height >= 30 && box.height <= 180;
      const looksRelevant = selector.startsWith('iframe')
        ? (markerLooksRelevant || (box.width >= 180 && box.height >= 45 && box.height <= 120))
        : (markerLooksRelevant && sizeLooksLikeWidget);
      if (!looksRelevant) continue;

      tried.push({
        selector,
        title: title.slice(0, 120),
        src: src.slice(0, 160),
        box: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
      });

      const handle = await elementLocator.elementHandle().catch(() => null);
      const frame = handle && selector.startsWith('iframe')
        ? await handle.contentFrame?.().catch(() => null)
        : null;
      if (frame) {
        const internalCandidates = [
          frame.getByRole('checkbox', { name: /verify|human/i }).first(),
          frame.locator('[role="checkbox"]').first(),
          frame.locator('input[type="checkbox"]').first(),
          frame.locator('label').first(),
        ];
        for (const candidate of internalCandidates) {
          const visibleCandidate = await candidate.isVisible().catch(() => false);
          const candidateBox = await candidate.boundingBox().catch(() => null);
          if (!visibleCandidate || !candidateBox) continue;
          await withTimeout(humanClickLocator(page, candidate), 8000)
            .catch(() => candidate.click({ timeout: 5000 }).catch(() => null)); // allow-raw-playwright: fallback for Turnstile iframe checkbox after bounded human click
          await page.waitForTimeout(3000).catch(() => {});
          return { clicked: true, method: 'frame_locator', tried };
        }
      }

      const targetX = box.x + Math.min(Math.max(26, Math.round(box.width * 0.12)), Math.max(8, box.width - 10));
      const targetY = box.y + Math.min(Math.max(22, Math.round(box.height * 0.5)), Math.max(8, box.height - 8));
      await humanMove(page, targetX, targetY).catch(() => page.mouse.move(targetX, targetY)); // allow-raw-playwright: bounded coordinate fallback for cross-origin Turnstile iframe
      await page.mouse.click(targetX, targetY); // allow-raw-playwright: click exact checkbox region inside visible Turnstile widget
      await page.waitForTimeout(3000).catch(() => {});
      return { clicked: true, method: selector.startsWith('iframe') ? 'iframe_coordinate' : 'container_coordinate', tried };
    }
  }

  return { clicked: false, method: 'not_found', tried };
}

async function waitForPublicVerificationIfNeeded(page) {
  let state = await publicVerificationState(page);
  if (!state.turnstileFrames && !state.turnstileContainers && !state.verifyText && (!state.scanButtons?.length || state.enabledScan)) return state;
  let turnstileClick = null;
  const deadline = Date.now() + Number(
    process.env.PANGRAM_WAIT_FOR_HUMAN_VERIFICATION === '1'
      ? process.env.PANGRAM_HUMAN_VERIFICATION_TIMEOUT_MS || 180_000
      : process.env.PANGRAM_PUBLIC_READY_TIMEOUT_MS || 30_000,
  );

  while (Date.now() < deadline) {
    if (state.enabledScan) return state;
    if (process.env.PANGRAM_CLICK_PUBLIC_TURNSTILE !== '0') {
      const click = await clickPublicTurnstileIfPresent(page);
      if (click.clicked || !turnstileClick) turnstileClick = click;
    }
    await page.waitForTimeout(1000).catch(() => {});
    state = await publicVerificationState(page);
    if (turnstileClick) state.turnstileClick = turnstileClick;
    if (state.enabledScan) return state;
  }

  if (turnstileClick) state.turnstileClick = turnstileClick;
  return state;
}

async function collectResult(s, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    const apiResult = extractFromResponses(s.capturedResponses);
    if (apiResult) return apiResult;
    const recordedApiResult = extractFromRecordedResponses();
    if (recordedApiResult) return recordedApiResult;
    lastText = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const uiResult = extractFromText(lastText);
    if (uiResult) {
      await s.page.waitForTimeout(1200).catch(() => {});
      const apiResultAfterUi = extractFromResponses(s.capturedResponses);
      const recordedApiResultAfterUi = extractFromRecordedResponses();
      return apiResultAfterUi || recordedApiResultAfterUi || uiResult;
    }
    await s.page.waitForTimeout(1500).catch(() => {});
  }
  return {
    source: 'none',
    body_text_sample: String(lastText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}

async function injectCookies(s, acct, sessionOpts, preloadedCookies = null) {
  const cookies = preloadedCookies || loadFreshCookieJarOrFail(acct, {
    platform: 'pangram',
    label: LABEL,
    currentProxyUrl: sessionOpts.proxyUrl,
    currentPersona: sessionOpts.persona,
  });
  const wanted = cookies.filter((c) => String(c.domain || '').includes('pangram.com'));
  if (!wanted.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: no pangram.com cookies', { platform: 'pangram', label: LABEL, reason: 'no_domain_match', account_id: acct?.id ?? null });
  await s.ctx.addCookies(wanted);
  return wanted.length;
}

const text = inputText();
if (!text.trim()) {
  console.log('FAIL: text required via PANGRAM_TEXT, SVC_TEXT, TEXT, PANGRAM_TEXT_FILE, TEXT_FILE, or MESSAGE_FILE');
  process.exit(2);
}

const MIN_WORDS = Number(process.env.PANGRAM_MIN_WORDS || 30);
const MIN_CHARS = Number(process.env.PANGRAM_MIN_CHARS || 200);
const wordCount = text.trim().split(/\s+/).length;
if (text.length < MIN_CHARS || wordCount < MIN_WORDS) {
  console.log(`FAIL: text too short for Pangram scanner (${wordCount} words, ${text.length} chars). Minimum ${MIN_WORDS} words / ${MIN_CHARS} chars. Set PANGRAM_MIN_WORDS/PANGRAM_MIN_CHARS to override.`);
  process.exit(2);
}

process.env.WELES_CAPTURE_RESPONSE_BODIES = process.env.WELES_CAPTURE_RESPONSE_BODIES || '1';

const stats = textStats(text);
const url = dashboardUrl();
let acct = null;
let s = null;
let banSignal = null;
let accountSelection = null;
let accountUsage = null;

const noAccount = process.env.PANGRAM_NO_ACCOUNT === '1';
const maxRunAttempts = noAccount ? 1 : maxAccountAttempts();
let completed = false;

for (let runAttempt = 1; runAttempt <= maxRunAttempts; runAttempt += 1) {
  acct = null;
  s = null;
  banSignal = null;
  accountSelection = null;
  accountUsage = null;
  let shouldRetryAccount = false;

try {
  accountSelection = noAccount ? { account: null, reason: 'no_account_disabled', pool: null } : await selectPangramAccountForRun();
  acct = accountSelection.account;

  if (!acct && process.env.PANGRAM_AUTO_REGISTER === '1' && !noAccount) {
    const autoReason = accountSelection?.reason || 'no_account';
    console.log(`[pangram:analyze_text] auto_register triggered reason=${autoReason}`);
    const registerResult = await autoRegisterPangramAccount(autoReason);
    console.log(`[pangram:analyze_text] auto_register success=${registerResult.success} reason=${registerResult.reason}`);
    if (registerResult.success) {
      accountSelection = await selectPangramAccountForRun();
      acct = accountSelection.account;
    }
  }

  if (!acct && process.env.PANGRAM_REQUIRE_ACCOUNT === '1') {
    const reason = accountSelection?.reason || 'no active pangram account';
    banSignal = {
      signal: reason === 'quota_exhausted' ? 'quota_exhausted' : 'no_account',
      healthy: false,
      details: {
        stage: 'pre-WSession',
        reason,
        account_pool: accountSelection?.pool ?? null,
        auto_register: process.env.PANGRAM_AUTO_REGISTER === '1' ? {
          today_count: autoRegisterCountToday(readAutoRegisterLedger()),
          daily_limit: maxAutoRegisters(),
        } : null,
      },
    };
    throw new Error(reason);
  }

  const sessionOpts = acct ? accountSelection.sessionOpts : {};
  s = await WSession.start({ label: LABEL, proxy: sessionOpts.proxyUrl, persona: sessionOpts.persona, targetHost: new URL(url).hostname, browser: 'chromium', os: process.env.WELES_FORCE_OS || undefined });
  let injectedCookies = 0;
  if (acct) {
    try {
      injectedCookies = await injectCookies(s, acct, sessionOpts, accountSelection.cookies);
      accountUsage = recordAccountUse(acct, stats, accountSelection.pool);
      console.log(`[pangram:analyze_text] account=${acct.username ?? acct.id ?? '?'} usage=${accountUsage?.scan_attempts ?? '?'} limit=${accountUsage?.daily_limit ?? '?'} injected=${injectedCookies}`);
    } catch (jarErr) {
      if (jarErr instanceof CookieJarStaleError) {
        banSignal = { signal: 'checkpoint', healthy: false, details: { reason: jarErr.message.slice(0, 200), ...(jarErr.details ?? {}) } };
        if (acct.id) await markCookiesStale(acct.id).catch(() => {});
        throw jarErr;
      }
      throw jarErr;
    }
  }

  console.log(`[pangram:analyze_text] chars=${stats.chars} words=${stats.words} url=${url}`);
  await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); // allow-raw-playwright: bounded public page navigation; WSession.goto can stall on screenshots
  console.log('[pangram:analyze_text] after_goto');
  await dismissCookieBanner(s.page);
  console.log('[pangram:analyze_text] after_cookie_1');
  const inputSelector = await fillInput(s.page, text);
  console.log(`[pangram:analyze_text] input=${inputSelector}`);
  await dismissCookieBanner(s.page);
  console.log('[pangram:analyze_text] after_cookie_2');
  const creditState = await readVisibleCreditState(s.page);
  if (acct && creditState && creditState.available <= 0) {
    accountUsage = markAccountExhausted(acct, stats, accountSelection.pool, 'visible_credit_state_zero', creditState);
    banSignal = {
      signal: 'insufficient_credits',
      healthy: false,
      details: {
        final_url: s.page.url(),
        account_id: acct?.id ?? null,
        username: acct?.username ?? null,
        credit_state: creditState,
      },
    };
    throw new Error('pangram_insufficient_credits');
  }
  if (!acct) {
    const verification = await waitForPublicVerificationIfNeeded(s.page);
    console.log(`[pangram:analyze_text] public_verification=${JSON.stringify(verification)}`);
    if (!verification.turnstileFrames && !verification.turnstileContainers && !verification.verifyText && verification.enabledScan) {
      banSignal = {
        signal: 'auth_required',
        healthy: false,
        details: {
          final_url: s.page.url(),
          reason: 'public no-login Scan for AI is enabled only as signup redirect; no Turnstile widget/anonymous-scan path was exposed',
          verification,
        },
      };
      throw new Error('pangram_public_auth_required');
    }
    if ((verification.turnstileFrames || verification.turnstileContainers || verification.verifyText || verification.scanButtons?.length) && !verification.enabledScan) {
      banSignal = {
        signal: (verification.turnstileFrames || verification.turnstileContainers || verification.verifyText) ? 'captcha_required' : 'scan_disabled',
        healthy: false,
        details: {
          final_url: s.page.url(),
          reason: (verification.turnstileFrames || verification.turnstileContainers || verification.verifyText)
            ? 'public no-login checker requires Turnstile token before Scan for AI is enabled'
            : 'public no-login Scan for AI button remained disabled; no result request was sent',
          verification,
        },
      };
      throw new Error(`pangram_public_${banSignal.signal}`);
    }
  }
  const clicked = await clickAnalyze(s.page);
  console.log(`[pangram:analyze_text] clicked=${clicked}`);
  await s.page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  const result = await collectResult(s, Number(process.env.PANGRAM_ANALYZE_TIMEOUT_MS || 90_000));
  const finalUrl = s.page.url?.() ?? url;

  banSignal = await detectPangramBanSignals(s.page, s.capturedResponses).catch(() => null);
  const authReason = result.source === 'none' ? authRequiredState(finalUrl, result) : null;
  if (authReason) {
    banSignal = { signal: 'auth_required', healthy: false, details: { final_url: finalUrl, reason: authReason, body_text_sample: result.body_text_sample } };
  }
  if (banSignal?.signal === 'healthy' && result.source === 'none') {
    banSignal = { signal: 'unknown_error', healthy: false, details: { final_url: finalUrl, reason: 'pangram_result_not_found', body_text_sample: result.body_text_sample } };
  }
  if (banSignal?.signal === 'healthy') {
    const out = mergeResult({
      action: LABEL,
      final_url: finalUrl,
      input: stats,
      input_selector: inputSelector,
      clicked,
      injected_cookies: injectedCookies,
      captured_response_count: s.capturedResponses.length,
      account_pool: accountSelection?.pool ?? null,
      account_usage: accountUsage,
      ts: new Date().toISOString(),
    }, result);
    writeJson(RESULT_FILE, out);
    console.log(`[pangram-result] ${JSON.stringify({ verdict: out.verdict, ai_percent: out.ai_percent, human_percent: out.human_percent, confidence_percent: out.confidence_percent, source: out.source })}`);
    console.log(`[ban-signal] ${banSignal.signal}`);
    console.log(`PASS: pangram_analyze_text ${out.verdict ?? 'result'} source=${out.source}`);
    completed = true;
  } else {
    console.log(`[ban-signal] ${banSignal?.signal ?? 'unknown_error'}`);
    throw new Error(`pangram_unhealthy:${banSignal?.signal ?? 'unknown_error'}`);
  }
} catch (e) {
  if (s && !banSignal) banSignal = await detectPangramBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (!banSignal) banSignal = { signal: 'unknown_error', healthy: false, details: { reason: e.message?.slice(0, 200) ?? 'unknown' } };
  if (banSignal.signal === 'healthy') {
    banSignal = { signal: 'unknown_error', healthy: false, details: { final_url: s?.page?.url?.() ?? '', reason: e.message?.slice(0, 200) ?? 'unknown', prev_signal: 'healthy' } };
  }
  if (banSignal.signal === 'insufficient_credits' && acct) {
    accountUsage = markAccountExhausted(acct, stats, accountSelection?.pool, 'insufficient_credits', banSignal.details?.credit_state ?? null);
  }
  console.log(`[ban-signal] ${banSignal.signal}`);
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  if (!noAccount && banSignal.signal === 'insufficient_credits' && runAttempt < maxRunAttempts) {
    const creditFailureThreshold = registerAfterCreditFailures();
    if (process.env.PANGRAM_AUTO_REGISTER === '1' && runAttempt % creditFailureThreshold === 0) {
      console.log(`[pangram:analyze_text] auto_register triggered reason=insufficient_credits attempts=${runAttempt}/${maxRunAttempts}`);
      const registerResult = await autoRegisterPangramAccount('insufficient_credits');
      console.log(`[pangram:analyze_text] auto_register success=${registerResult.success} reason=${registerResult.reason}`);
    }
    shouldRetryAccount = true;
    console.log(`[pangram:analyze_text] retrying with another account after insufficient_credits attempt=${runAttempt}/${maxRunAttempts}`);
  } else {
    process.exitCode = process.exitCode || 1;
  }
} finally {
  if (banSignal) {
    writeJson('ban_signal.json', {
      account_id: acct?.id ?? null,
      username: acct?.username ?? null,
      account_pool: accountSelection?.pool ?? null,
      account_usage: accountUsage,
      action: LABEL,
      ...banSignal,
      ts: new Date().toISOString(),
    });
  }
  if (banSignal?.signal === 'checkpoint' && acct?.id) {
    await markCookiesStale(acct.id).catch((e) => console.log(`[mark-stale] err: ${e.message?.slice(0, 80)}`));
  }
  if (s) await s.close().catch(() => {});
}

  if (completed) break;
  if (shouldRetryAccount) continue;
  break;
}
