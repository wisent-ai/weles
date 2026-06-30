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

    if (req.method !== 'POST' || url.pathname !== '/google-ads/keyword-volume') {
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
    const input = validateRequest(body);
    const startedAt = new Date().toISOString();
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
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[weles-keyword-planner-api] listening http://${HOST}:${PORT} session=${SESSION} auth=${Boolean(API_TOKEN || ALLOW_UNAUTH)}`);
});
