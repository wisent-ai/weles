// Google Ads Keyword Planner API facade for a Mac mini running Weles.
// This HTTP server is only a transport wrapper around ads_keyword_planner_keeper.mjs.
// It must not call Google Ads REST/developer-token APIs; metrics remain UI-observed
// through the persistent Weles keeper and its logged-in browser profile.
//
// Env:
//   WELES_KEYWORD_PLANNER_API_TOKEN required unless WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH=1
//   WELES_KEYWORD_PLANNER_API_HOST  optional, default 127.0.0.1
//   WELES_KEYWORD_PLANNER_API_PORT  optional, default 8787
//   SESSION                         optional, default google_ads
//
// Example on Mac mini:
//   cd ~/Documents/CodingProjects/Wisent/weles
//   WELES_KEYWORD_PLANNER_API_HOST=0.0.0.0 \
//   WELES_KEYWORD_PLANNER_API_TOKEN="$WELES_CONSOLE_API_TOKEN" \
//   node scripts/trajectories/google/ads/ads_keyword_planner_api_server.mjs

import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../..');
const RUNNER = join(__dirname, 'ads_keyword_planner_keeper.mjs');
let HOST = process.env.WELES_KEYWORD_PLANNER_API_HOST || '127.0.0.1';
let PORT = Number(process.env.WELES_KEYWORD_PLANNER_API_PORT || 8787);
let SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || 'google_ads';
let API_TOKEN = process.env.WELES_KEYWORD_PLANNER_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || '';
let ALLOW_UNAUTH = process.env.WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH === '1';
let TIMEOUT_MS = Number(process.env.WELES_KEYWORD_PLANNER_API_TIMEOUT_MS || 15 * 60 * 1000);
let BODY_LIMIT_BYTES = Number(process.env.WELES_KEYWORD_PLANNER_API_BODY_LIMIT_BYTES || 128 * 1024);
let DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || join(REPO, '.work/google-ads-keyword-planner/api');
const KEEPER = join(REPO, 'scripts/_shared/keeper/keeper.mjs');
let KEEPER_START = process.env.GOOGLE_ADS_KEEPER_START !== '0';
let KEEPER_READY_TIMEOUT_MS = Number(process.env.GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS || 90 * 1000);
let KEEPER_USER_DATA_DIR = process.env.GOOGLE_ADS_KEEPER_USER_DATA_DIR
  || process.env.KEEPER_USER_DATA_DIR
  || process.env.WELES_USER_DATA_DIR
  || join(process.env.HOME || '', '.weles', 'browser_profiles', 'google_ads');
const DEFAULT_MODEL_ROUTER_URL = 'https://model-router-1080673333190.us-central1.run.app';
const DEFAULT_ROUTER_CONFIG_IDS = ['codex-reauth-config', 'claude-reauth-config', 'kimi-reauth-config'];
let routerConfig = null;

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

function applyEnvDefaults(env) {
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
}

applyEnvDefaults(loadEnvFile(join(REPO, '.env')));
applyEnvDefaults(loadEnvFile(join(REPO, '.env.local')));
applyEnvDefaults(loadEnvFile(join(REPO, '.env.production')));
HOST = process.env.WELES_KEYWORD_PLANNER_API_HOST || HOST;
PORT = Number(process.env.WELES_KEYWORD_PLANNER_API_PORT || PORT);
SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || SESSION;
API_TOKEN = process.env.WELES_KEYWORD_PLANNER_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || API_TOKEN;
ALLOW_UNAUTH = process.env.WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH === '1' || ALLOW_UNAUTH;
TIMEOUT_MS = Number(process.env.WELES_KEYWORD_PLANNER_API_TIMEOUT_MS || TIMEOUT_MS);
BODY_LIMIT_BYTES = Number(process.env.WELES_KEYWORD_PLANNER_API_BODY_LIMIT_BYTES || BODY_LIMIT_BYTES);
DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || DIAG_DIR;
KEEPER_START = process.env.GOOGLE_ADS_KEEPER_START !== '0' && KEEPER_START;
KEEPER_READY_TIMEOUT_MS = Number(process.env.GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS || KEEPER_READY_TIMEOUT_MS);
KEEPER_USER_DATA_DIR = process.env.GOOGLE_ADS_KEEPER_USER_DATA_DIR
  || process.env.KEEPER_USER_DATA_DIR
  || process.env.WELES_USER_DATA_DIR
  || KEEPER_USER_DATA_DIR;

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        rejectBody(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        rejectBody(new Error(`invalid JSON body: ${error?.message || error}`));
      }
    });
    req.on('error', rejectBody);
  });
}

function authorized(req) {
  if (ALLOW_UNAUTH) return true;
  if (!API_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  if (header === `Bearer ${API_TOKEN}`) return true;
  const apiKey = String(req.headers['x-api-key'] || '');
  return apiKey === API_TOKEN;
}

function parseKeywords(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  return [...new Set(String(value || '').split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

function normalizeCustomerId(value) {
  return String(value || '').replace(/\D/g, '');
}

function safeSlug(value) {
  return String(value || 'keywords').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'keywords';
}

function redact(text) {
  return String(text || '')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '<redacted-google-access-token>')
    .replace(/GOCSPX-[A-Za-z0-9_-]+/g, '<redacted-google-client-secret>')
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/Warszawa\d*!?/g, '<redacted-password>')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"<redacted-google-refresh-token>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
}

function stripGoogleAdsApiEnv(env) {
  const next = { ...env };
  for (const key of [
    'GOOGLE_ADS_ACCESS_TOKEN',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_REFRESH_TOKEN',
  ]) {
    delete next[key];
  }
  return next;
}
function keeperSocketPath(session) {
  return join(process.env.HOME || '', '.weles', 'keeper', session, 'socket');
}

function keeperAction(session, cmd, timeoutMs = 5000) {
  return new Promise((resolveAction) => {
    const socket = keeperSocketPath(session);
    if (!existsSync(socket)) {
      resolveAction({ ok: false, error: 'keeper_socket_missing', socket });
      return;
    }
    const conn = net.createConnection(socket);
    let done = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch {}
      resolveAction({ ok: false, error: 'keeper_action_timeout', socket });
    }, timeoutMs);
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0 || done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      try {
        resolveAction(JSON.parse(buf.slice(0, nl)));
      } catch (error) {
        resolveAction({ ok: false, error: String(error?.message || error), socket });
      }
    });
    conn.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveAction({ ok: false, error: String(error?.message || error), socket });
    });
  });
}

async function waitForKeeper(session, timeoutMs = KEEPER_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, error: 'keeper_not_checked', socket: keeperSocketPath(session) };
  while (Date.now() < deadline) {
    last = await keeperAction(session, { action: 'url' }, 5000);
    if (last?.ok) return { ready: true, socket: keeperSocketPath(session) };
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return { ready: false, socket: keeperSocketPath(session), lastError: last?.error || 'keeper_not_ready' };
}

async function ensureKeeper(session) {
  const existing = await keeperAction(session, { action: 'url' }, 3000);
  if (existing?.ok) return { ready: true, started: false, socket: keeperSocketPath(session) };
  if (!KEEPER_START) {
    return { ready: false, started: false, disabled: true, socket: keeperSocketPath(session), lastError: existing?.error || 'keeper_start_disabled' };
  }
  if (!existsSync(KEEPER)) {
    return { ready: false, started: false, socket: keeperSocketPath(session), lastError: 'keeper_script_missing', keeper: KEEPER };
  }

  mkdirSync(DIAG_DIR, { recursive: true });
  mkdirSync(dirname(KEEPER_USER_DATA_DIR), { recursive: true });
  const logPath = join(DIAG_DIR, `keeper-${session}.log`);
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [KEEPER], {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        WELES_REPO: REPO,
        SESSION: session,
        KEEPER_FLOW_ACTION: process.env.GOOGLE_ADS_KEEPER_FLOW_ACTION || 'google_ads_keyword_planner_keeper',
        KEEPER_USER_DATA_DIR,
        WELES_USER_DATA_DIR: KEEPER_USER_DATA_DIR,
        URL: process.env.GOOGLE_ADS_KEEPER_START_URL || 'https://ads.google.com/aw/overview',
      },
    });
    child.unref();
  } finally {
    closeSync(fd);
  }

  const waited = await waitForKeeper(session);
  return { ...waited, started: true, logPath, userDataDir: KEEPER_USER_DATA_DIR };
}


function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}


function validateReportRequest(body) {
  const customerId = normalizeCustomerId(body.customerId || body.customer_id || body.googleAdsCustomerId);
  if (!customerId) throw new Error('customerId required');
  const seedKeywords = parseKeywords(body.seedKeywords || body.seeds || body.keywords || body.keyword)
    .map(normalizeKeyword)
    .filter(Boolean);
  const subject = String(body.subject || body.product || body.niche || body.brief || body.landingPage || body.url || '').trim();
  if (!subject && !seedKeywords.length) throw new Error('subject/product/brief or seedKeywords required');


  return {
    customerId,
    subject,
    product: String(body.product || '').trim(),
    niche: String(body.niche || '').trim(),
    audience: String(body.audience || body.targetAudience || '').trim(),
    landingPage: String(body.landingPage || body.url || '').trim(),
    goal: String(body.goal || 'Find paid search opportunities with real Google Ads Keyword Planner metrics.').trim(),
    seedKeywords,
    email: String(body.email || body.googleAdsEmail || body.ssoEmail || process.env.GOOGLE_ADS_EMAIL || process.env.SSO_EMAIL || ''),
    session: String(body.session || SESSION),
  };
}

function routerConfigPreference(model) {
  if (/kimi/i.test(model || '')) return ['kimi-reauth-config', 'codex-reauth-config', 'claude-reauth-config'];
  if (/codex|openai/i.test(model || '')) return ['codex-reauth-config', 'claude-reauth-config', 'kimi-reauth-config'];
  return DEFAULT_ROUTER_CONFIG_IDS;
}

async function loadModelRouterConfig() {
  if (routerConfig) return routerConfig;
  const envRouterUrl = String(process.env.MODEL_ROUTER_URL || '').trim();
  const envAgentId = String(process.env.WISENT_APP_AGENT_ID || '').trim();
  const envHmacSecret = String(process.env.WISENT_APP_AGENT_AUTH_SECRET || '').trim();
  const model = String(process.env.WELES_AGENT_MODEL || process.env.MODEL_ROUTER_MODEL || 'codex-subscription').trim();
  if (envHmacSecret) {
    routerConfig = {
      routerUrl: (envRouterUrl || DEFAULT_MODEL_ROUTER_URL).replace(/\/+$/, ''),
      agentId: envAgentId || 'wisent-app',
      hmacSecret: envHmacSecret,
      model,
      configId: 'env',
    };
    return routerConfig;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !supabaseKey) throw new Error('missing model-router env and Supabase config env');
  const ids = DEFAULT_ROUTER_CONFIG_IDS.join(',');
  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/service_credentials?id=in.(${ids})&select=id,metadata`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!res.ok) throw new Error(`model-router config lookup failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const byId = new Map(rows.map((row) => [row.id, row.metadata || {}]));
  const preferredId = routerConfigPreference(model).find((id) => byId.get(id)?.WISENT_APP_AGENT_AUTH_SECRET);
  if (!preferredId) throw new Error('model-router config row missing HMAC secret');
  const metadata = byId.get(preferredId);
  routerConfig = {
    routerUrl: String(metadata.MODEL_ROUTER_URL || DEFAULT_MODEL_ROUTER_URL).replace(/\/+$/, ''),
    agentId: String(metadata.WISENT_APP_AGENT_ID || 'wisent-app'),
    hmacSecret: String(metadata.WISENT_APP_AGENT_AUTH_SECRET),
    model,
    configId: preferredId,
  };
  return routerConfig;
}

function signedRouterHeaders(cfg, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', cfg.hmacSecret).update(`${cfg.agentId}:${ts}:${bodyHash}`).digest('hex');
  return {
    'x-agent-id': cfg.agentId,
    'x-agent-timestamp': ts,
    'x-agent-signature': sig,
    'content-type': 'application/json',
  };
}

function parseKeywordRouterResponse(raw) {
  const text = String(raw || '').trim();
  const candidates = [text];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(text.slice(firstBracket, lastBracket + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : parsed.keywords;
      if (Array.isArray(list)) {
        return {
          saturated: Boolean(parsed.saturated),
          keywords: [...new Set(list.map(normalizeKeyword).filter(Boolean))],
          intents: Array.isArray(parsed.intents) ? parsed.intents : Array.isArray(parsed.clusters) ? parsed.clusters : [],
          rationale: typeof parsed.rationale === 'string' ? parsed.rationale : null,
        };
      }
    } catch {}
  }
  return { saturated: false, keywords: [], intents: [], rationale: null };
}

async function generateKeywordsWithRouter(input, state = null) {
  const cfg = await loadModelRouterConfig();
  const prompt = state ? [
    'Continue Google Ads keyword research by checking intent saturation.',
    'Return ONLY valid JSON in this exact shape: {"saturated":true,"keywords":[],"rationale":"why"} or {"saturated":false,"keywords":["canonical keyword"],"rationale":"what intent is still missing"}.',
    'If all materially distinct paid-search intents are already covered, return saturated true and an empty keywords array.',
    'If coverage is incomplete, return one canonical Google Ads seed keyword for each materially uncovered intent.',
    'Do not include fixed counts, commentary, markdown, metrics, or near-duplicate variants of already checked intents.',
    `Subject: ${input.subject || '(none)'}`,
    `Product: ${input.product || '(none)'}`,
    `Niche: ${input.niche || '(none)'}`,
    `Audience: ${input.audience || '(none)'}`,
    `Landing page: ${input.landingPage || '(none)'}`,
    `Goal: ${input.goal}`,
    `Seed keywords: ${input.seedKeywords.join(', ') || '(none)'}`,
    `Already checked keywords: ${state.checkedKeywords.join(', ') || '(none)'}`,
    `Metric rows found: ${JSON.stringify(state.rows.map((row) => ({
      keyword: row.keyword,
      avgMonthlySearches: row.avgMonthlySearches,
      competition: row.competition,
      yoyChange: row.yoyChange,
    })))}`,
  ].join('\n') : [
    'Identify the materially distinct paid-search intents for this product.',
    'Return ONLY valid JSON in this exact shape: {"saturated":false,"keywords":["canonical keyword"],"rationale":"coverage plan"}.',
    'Each keyword must be a canonical Google Ads seed keyword representing a different intent.',
    'Do not include fixed counts, commentary, markdown, metrics, or near-duplicate long-tail variants.',
    `Subject: ${input.subject || '(none)'}`,
    `Product: ${input.product || '(none)'}`,
    `Niche: ${input.niche || '(none)'}`,
    `Audience: ${input.audience || '(none)'}`,
    `Landing page: ${input.landingPage || '(none)'}`,
    `Goal: ${input.goal}`,
    `Seed keywords: ${input.seedKeywords.join(', ') || '(none)'}`,
    'Prefer commercial-intent search phrases. Avoid brands not present in the prompt and policy-sensitive/adult-explicit terms.',
  ].join('\n');
  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: Number(process.env.WELES_KEYWORD_REPORT_MAX_TOKENS || 1400),
    messages: [{ role: 'user', content: prompt }],
  });
  const timeoutMs = Number(process.env.WELES_KEYWORD_REPORT_ROUTER_TIMEOUT_MS || 120_000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.routerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: signedRouterHeaders(cfg, body),
      body,
      signal: ac.signal,
    });
    const data = await res.json().catch(async () => ({ raw: await res.text().catch(() => '') }));
    if (!res.ok) throw new Error(`model-router ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
    const raw = data.choices?.[0]?.message?.content || data.raw || '';
    const parsed = parseKeywordRouterResponse(raw);
    if (!parsed.saturated && !parsed.keywords.length) throw new Error(`model-router returned no parseable keywords: ${String(raw).slice(0, 300)}`);
    return {
      ok: true,
      source: 'model-router',
      model: data.model || cfg.model,
      routerHost: new URL(cfg.routerUrl).host,
      configId: cfg.configId,
      saturated: parsed.saturated,
      keywords: parsed.keywords,
      intents: parsed.intents,
      rationale: parsed.rationale,
    };
  } finally {
    clearTimeout(timer);
  }
}

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

function rankKeywordRows(rows) {
  const competitionPenalty = new Map([['Low', 0], ['Medium', 0.2], ['High', 0.45]]);
  return [...(rows || [])].map((row) => {
    const volume = parseVolume(row);
    const yoy = parseSignedPercent(row.yoyChange);
    const lowBid = parseBid(row, 'topOfPageBidLow');
    const competition = row.competition || null;
    const score = Math.log10(volume + 1) + Math.max(-1, Math.min(2, yoy / 100)) - (competitionPenalty.get(competition) || 0) - (lowBid ? Math.min(0.4, lowBid / 25) : 0);
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


async function runKeywordReport(input, generation) {
  let keywords = uniqueKeywords([...input.seedKeywords, ...generation.keywords]);
  if (!keywords.length) throw new Error('no keyword candidates to check');

  const generations = [generation];
  const rounds = [];
  const checkedKeywords = [];
  const checkedKeys = new Set();
  let rows = [];
  let lastRun = null;
  let accountEmail = input.email || null;
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
        timedOut: Boolean(run.timedOut),
        rowCount: roundRows.length,
        blocked: run.report?.blocked || null,
        resultFile: run.resultFile,
      });

      if (run.timedOut || run.report?.blocked === 'keeper_not_ready') break;
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
    timedOut: rounds.some((round) => round.timedOut),
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

function buildKeywordReport(input, generation, run) {
  const rows = run.report?.rows || [];
  const ranked = rankKeywordRows(rows);
  return {
    ok: Boolean(run.ok),
    source: 'weles_keyword_report',
    customer: input.customerId,
    accountEmail: run.report?.accountEmail || input.email || null,
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


function validateRequest(body) {
  const customerId = normalizeCustomerId(body.customerId || body.customer_id || body.googleAdsCustomerId);
  const keywords = parseKeywords(body.keywords || body.keyword);
  if (!customerId) throw new Error('customerId required');
  if (!keywords.length) throw new Error('keywords required');
  return {
    customerId,
    keywords,
    email: String(body.email || body.googleAdsEmail || body.ssoEmail || process.env.GOOGLE_ADS_EMAIL || process.env.SSO_EMAIL || ''),
    session: String(body.session || SESSION),
  };
}

async function runKeywordPlanner(input) {
  mkdirSync(DIAG_DIR, { recursive: true });
  const resultFile = join(DIAG_DIR, `${Date.now()}-${process.pid}-${safeSlug(input.keywords[0])}.json`);
  const keeper = await ensureKeeper(input.session);
  if (!keeper.ready) {
    return {
      ok: false,
      exitCode: 3,
      timedOut: false,
      stdout: '',
      stderr: '',
      resultFile,
      keeper,
      report: {
        ok: false,
        blocked: 'keeper_not_ready',
        session: input.session,
        socket: keeper.socket,
        started: Boolean(keeper.started),
        lastError: keeper.lastError || null,
      },
    };
  }

  return await new Promise((resolveRun) => {
    const childEnv = stripGoogleAdsApiEnv({
      ...process.env,
      SESSION: input.session,
      GOOGLE_ADS_CUSTOMER_ID: input.customerId,
      GOOGLE_ADS_KEYWORDS: input.keywords.join('\n'),
      GOOGLE_ADS_RESULT_FILE: resultFile,
      GOOGLE_ADS_CLOSE_AFTER_HARVEST: process.env.GOOGLE_ADS_CLOSE_AFTER_HARVEST || '0',
      GOOGLE_ADS_KEYWORD_BROWSER_AUTOMATION: '1',
      WELES_DISABLE_RECORDING: process.env.WELES_DISABLE_RECORDING || '1',
      WELES_NO_INSTRUMENT: process.env.WELES_NO_INSTRUMENT || '1',
      GOOGLE_SSO_NO_SCREENSHOTS: process.env.GOOGLE_SSO_NO_SCREENSHOTS || '1',
    });
    if (input.email) {
      childEnv.GOOGLE_ADS_EMAIL = input.email;
      childEnv.SSO_EMAIL = input.email;
    }

    const child = spawn(process.execPath, [RUNNER], {
      cwd: REPO,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      resolveRun({ ok: false, exitCode: null, timedOut: true, stdout, stderr, resultFile, keeper, report: null });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ ok: false, exitCode: 1, stdout, stderr: `${stderr}\n${error?.message || error}`, resultFile, keeper, report: null });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let report = null;
      if (existsSync(resultFile)) {
        try {
          report = JSON.parse(readFileSync(resultFile, 'utf8'));
          writeFileSync(resultFile, JSON.stringify(JSON.parse(redact(JSON.stringify(report))), null, 2));
        } catch {
          report = null;
        }
      }
      resolveRun({ ok: code === 0 && Boolean(report?.ok), exitCode: code, stdout, stderr, resultFile, keeper, report });
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        source: 'weles_keyword_planner_api',
        authConfigured: Boolean(API_TOKEN || ALLOW_UNAUTH),
        session: SESSION,
        runner: RUNNER,
      });
      return;
    }

    const isKeywordVolume = req.method === 'POST' && url.pathname === '/google-ads/keyword-volume';
    const isKeywordReport = req.method === 'POST' && url.pathname === '/google-ads/keyword-report';
    if (!isKeywordVolume && !isKeywordReport) {
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    if (!authorized(req)) {
      json(res, API_TOKEN || ALLOW_UNAUTH ? 401 : 500, {
        ok: false,
        error: API_TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_KEYWORD_PLANNER_API_TOKEN',
      });
      return;
    }

    if (!existsSync(RUNNER)) {
      json(res, 500, { ok: false, error: 'ads_keyword_planner_keeper_missing', runner: RUNNER });
      return;
    }

    const body = await readJsonBody(req);
    const startedAt = new Date().toISOString();

    if (isKeywordVolume) {
      const input = validateRequest(body);
      const run = await runKeywordPlanner(input);
      const response = {
        ok: Boolean(run.ok),
        source: 'weles_mac_mini_keyword_planner_api',
        session: input.session,
        customer: input.customerId,
        keywordCount: input.keywords.length,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: run.exitCode,
        timedOut: Boolean(run.timedOut),
        resultFile: run.resultFile,
        stdoutTail: redact(run.stdout).slice(-4000),
        stderrTail: redact(run.stderr).slice(-2000),
        report: run.report,
        keeper: run.keeper,
      };
      json(res, response.ok ? 200 : 502, response);
      return;
    }

    const input = validateReportRequest(body);
    const generation = await generateKeywordsWithRouter(input);
    const run = await runKeywordReport(input, generation);
    const report = buildKeywordReport(input, generation, run);
    const response = {
      ok: Boolean(run.ok),
      source: 'weles_mac_mini_keyword_report_api',
      session: input.session,
      customer: input.customerId,
      keywordCount: report.metrics.checkedKeywordCount,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: run.exitCode,
      timedOut: Boolean(run.timedOut),
      resultFile: run.resultFile,
      stdoutTail: redact(run.stdout).slice(-4000),
      stderrTail: redact(run.stderr).slice(-2000),
      report,
      keeper: run.keeper,
    };
    json(res, response.ok ? 200 : 502, response);
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[weles-keyword-planner-api] listening http://${HOST}:${PORT} session=${SESSION} auth=${Boolean(API_TOKEN || ALLOW_UNAUTH)}`);
});
