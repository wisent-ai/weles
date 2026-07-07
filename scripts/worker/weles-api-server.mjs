// Weles HTTP API — synchronous trajectory runner.
//
// Purpose: "shoot at a server" to run a Weles trajectory and get the result
// back in the HTTP response, WITHOUT the Supabase account_action_logs
// enqueue->poll roundtrip. It reuses the worker's OWN resolveTrajectory +
// paramsToEnv (from dist/) so a job runs byte-identically to the queued path.
//
// This is a transport wrapper only. It spawns the same `node <trajectory>`
// child the worker spawns; it does not reimplement trajectory logic.
//
// Credential modes (POST /run field "creds", default "redact"):
//   "redact"  -> result passes through the secret-shape redactor (default;
//                a login/register trajectory cannot exfiltrate a token).
//   "raw"     -> result returned UNREDACTED (raw creds in the response). Gated
//                by WELES_API_ALLOW_RAW_CREDS (default "1"; set "0" to forbid).
//   "store"   -> Weles persists the extracted creds into service_credentials
//                (the entitlements-router source of truth) and returns ONLY a
//                reference { credential_id, provider, login_email, has_password }
//                — no raw run output leaves the process.
//
// Env:
//   WELES_API_TOKEN  (or WELES_CONSOLE_API_TOKEN)  required unless WELES_API_ALLOW_UNAUTH=1
//   WELES_API_HOST   default 127.0.0.1  (set 0.0.0.0 to expose on the LAN/Tailscale)
//   WELES_API_PORT   default 8788       (keyword-planner-api already owns 8787)
//   WELES_API_TIMEOUT_MS  default 900000
//   WELES_API_BODY_LIMIT_BYTES default 262144
//   WELES_API_ALLOW_RAW_CREDS  default "1"
//   plus the usual worker env (SUPABASE_URL/KEY, CHROMIUM_PATH, proxy creds, ...)
//
// Routes:
//   GET  /healthz  -> liveness + config summary (no secrets)
//   POST /run      -> { action, params?, account_id?, timeout_ms?, creds? }
//                     runs the trajectory, returns { ok, exitCode, action,
//                     run_id, result|credential, stdout_tail, stderr_tail }

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');

const { resolveTrajectory, paramsToEnv } = await import(`${REPO}/dist/worker/dispatch.js`);

const HOST = process.env.WELES_API_HOST || '127.0.0.1';
const PORT = Number(process.env.WELES_API_PORT || 8788);
const TOKEN = process.env.WELES_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || '';
const ALLOW_UNAUTH = process.env.WELES_API_ALLOW_UNAUTH === '1';
const ALLOW_RAW_CREDS = (process.env.WELES_API_ALLOW_RAW_CREDS ?? '1') === '1';
const TIMEOUT_MS = Number(process.env.WELES_API_TIMEOUT_MS || 15 * 60 * 1000);
const BODY_LIMIT = Number(process.env.WELES_API_BODY_LIMIT_BYTES || 256 * 1024);
const BUILDER_BOOTSTRAP_URL = process.env.WELES_BUILDER_BOOTSTRAP_URL || 'https://duckduckgo.com/';
// Prepended to the caller's instructions so the agent self-navigates: the
// caller supplies NO url, only the goal. The agent lands on a neutral
// bootstrap page and drives itself to whatever site the task implies.
const BUILDER_PREAMBLE = [
  'You are given a task in natural language. You start on a neutral bootstrap page.',
  'FIRST decide which website accomplishes the task and go there yourself with the navigate tool; if you do not know the exact URL, search from the current page.',
  'If the task needs an account, call generate_identity(platform) and use the $PLATFORM_NEW_* placeholders in fill/type_text; do not type literal placeholder text.',
  'If the site emails a confirmation code, call check_email. Solve CAPTCHAs with solve_captcha.',
  'Do not make purchases, submit payments, delete data, or perform irreversible/destructive actions.',
  'When finished, call done(value) with a concise JSON-serializable summary plus any data or credentials the task asked for.',
].join(' ');

function authorized(req) {
  if (ALLOW_UNAUTH) return true;
  if (!TOKEN) return false;
  if (String(req.headers.authorization || '') === `Bearer ${TOKEN}`) return true;
  return String(req.headers['x-api-key'] || '') === TOKEN;
}

function json(res, code, obj, { redact = true } = {}) {
  const body = JSON.stringify(redact ? redactSecrets(obj) : obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Secret-shape redactor (same shapes as the secret-boundary hook): never let a
// token leave over HTTP. Operates on the serialized form so nested fields count.
function redactSecrets(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { return obj; }
  if (!s) return obj;
  s = s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-pem]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, '[redacted-slack]')
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted-aws]')
    .replace(/\b[a-z]{1,12}_(secret|key|token|pat|api|db)_[A-Za-z0-9]{12,}/gi, '[redacted-secret]');
  try { return JSON.parse(s); } catch { return obj; }
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(text)); } catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

// Raw body reader for /weles-builder: the body IS the instructions string
// (text/plain). No JSON envelope required.
function readText(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{') || lines[i].startsWith('[')) {
      try { return JSON.parse(lines[i]); } catch { /* keep scanning up */ }
    }
  }
  return null;
}

// Many trajectories (generic browser_task, register flows) write their result
// to recordings/<run_id>/<...>/generic_task_result.json (or result.json) rather
// than stdout. Walk the run's recordings tree and return the first result doc.
function findResultDoc(runId) {
  const root = join(REPO, 'recordings', runId);
  const wanted = new Set(['generic_task_result.json', 'result.json']);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (wanted.has(e.name)) {
        try { return JSON.parse(readFileSync(full, 'utf8')); } catch { /* keep scanning */ }
      }
    }
  }
  return null;
}

// Pull a credential tuple out of a trajectory result value. Tolerant of nesting
// (result.value, result.value.credentials, top-level) and common field names.
function extractCreds(doc) {
  const candidates = [];
  const push = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) candidates.push(o); };
  push(doc);
  if (doc && typeof doc === 'object') {
    push(doc.value);
    push(doc.credentials);
    push(doc.value && doc.value.credentials);
    push(doc.account);
    push(doc.value && doc.value.account);
  }
  const pick = (o, keys) => { for (const k of keys) { for (const kk of Object.keys(o)) { if (kk.toLowerCase() === k && typeof o[kk] === 'string' && o[kk].trim()) return o[kk].trim(); } } return ''; };
  for (const o of candidates) {
    const email = pick(o, ['email', 'login_email', 'e_mail']);
    const username = pick(o, ['username', 'user', 'handle', 'login']);
    const password = pick(o, ['password', 'login_password', 'pass', 'pwd']);
    if (email || username || password) {
      return { email, username, password, phone: pick(o, ['phone', 'phone_number']) };
    }
  }
  return null;
}

async function storeCredential(action, params, creds, runId) {
  const { upsertCredential } = await import(`${REPO}/scripts/lib/service_credentials.mjs`);
  const provider = (typeof params.platform === 'string' && params.platform)
    || action.split('_')[0]
    || 'generic';
  const loginEmail = creds.email || creds.username || '';
  const id = `weles-api-${provider}-${runId.slice(0, 8)}`;
  const row = {
    id,
    category: 'auth',
    display_name: `${provider} account (weles-api ${runId.slice(0, 8)})`,
    login_method: 'email_password',
    login_email: loginEmail,
    login_password: creds.password || '',
    metadata: {
      provider,
      username: creds.username || null,
      phone: creds.phone || null,
      source: 'weles-api',
      source_run_id: runId,
      action,
      created_by: 'weles-api',
      updated_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  const rows = await upsertCredential(row);
  const saved = Array.isArray(rows) ? rows[0] : rows;
  return {
    credential_id: (saved && saved.id) || id,
    provider,
    login_email: loginEmail,
    has_password: Boolean(creds.password),
  };
}

function runTrajectory(action, params, accountId, timeoutMs) {
  return new Promise((resolveRun) => {
    const trajPath = resolveTrajectory(action);
    if (!trajPath) { resolveRun({ ok: false, error: 'no_trajectory', action }); return; }
    const runId = randomUUID();
    const env = {
      ...process.env,
      WELES_FULL_DIAGNOSTICS: process.env.WELES_FULL_DIAGNOSTICS ?? '1',
      ...paramsToEnv(params || {}, action, trajPath),
      ...(accountId ? { ACCOUNT_ID: String(accountId) } : {}),
      ACTION_LOG_ID: runId,
      ACTION: action,
    };
    const child = spawn('node', [trajPath], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 8000);
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = killed ? 137 : (code ?? -1);
      // Prefer stdout JSON; fall back to the run's result file on disk.
      const result = lastJsonLine(stdout) ?? findResultDoc(runId);
      resolveRun({
        ok: exitCode === 0,
        exitCode,
        action,
        run_id: runId,
        result,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-2000),
        timed_out: killed,
      });
    });
  });
}

// Providers whose reauth trajectory can run on the host on demand. This is the
// "call Weles on the host to authenticate" step: the broker decides WHICH
// provider + method, weles-api runs that provider's reauth trajectory locally,
// and only the run status leaves the process.
const REAUTH_PROVIDERS = new Set(['codex', 'claude', 'kimi']);

function runReauth(provider, timeoutMs) {
  return new Promise((resolveRun) => {
    const trajPath = resolve(REPO, 'scripts/trajectories', provider, 'reauth.mjs');
    if (!existsSync(trajPath)) { resolveRun({ ok: false, error: 'no_reauth_trajectory', provider }); return; }
    const runId = randomUUID();
    const child = spawn('node', [trajPath], {
      cwd: REPO,
      env: { ...process.env, ACTION_LOG_ID: runId, ACTION: `${provider}_reauth` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 8000);
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = killed ? 137 : (code ?? -1);
      resolveRun({
        ok: exitCode === 0,
        exitCode,
        provider,
        run_id: runId,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-2000),
        timed_out: killed,
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        source: 'weles_api',
        authConfigured: Boolean(TOKEN || ALLOW_UNAUTH),
        rawCredsAllowed: ALLOW_RAW_CREDS,
        routes: ['GET /healthz', 'POST /run', 'POST /weles-builder', 'POST /reauth'],
      });
      return;
    }
    // reauth: run a provider's reauth trajectory ON THE HOST. Body:
    // { provider: "codex"|"claude"|"kimi", timeout_ms? }. Returns run status
    // only.
    if (req.method === 'POST' && url.pathname === '/reauth') {
      if (!authorized(req)) {
        json(res, TOKEN || ALLOW_UNAUTH ? 401 : 500, { ok: false, error: TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_API_TOKEN' });
        return;
      }
      let body;
      try { body = await readBody(req); }
      catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
      if (!REAUTH_PROVIDERS.has(provider)) { json(res, 400, { ok: false, error: 'provider must be codex|claude|kimi' }); return; }
      const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS;
      const out = await runReauth(provider, timeoutMs);
      if (out.error === 'no_reauth_trajectory') { json(res, 404, out); return; }
      json(res, out.ok ? 200 : 502, { ...out, refreshed: out.ok });
      return;
    }
    // weles-builder: instructions-only. Body = the goal string (text/plain;
    // {"instructions": "..."} JSON also accepted). No url, no params. The agent
    // self-navigates and, on success, its executed steps are saved as a new
    // reusable trajectory (generic browser_task draft-first behavior).
    if (req.method === 'POST' && url.pathname === '/weles-builder') {
      if (!authorized(req)) {
        json(res, TOKEN || ALLOW_UNAUTH ? 401 : 500, { ok: false, error: TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_API_TOKEN' });
        return;
      }
      let raw;
      try { raw = await readText(req); }
      catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      let instructions = (raw || '').trim();
      if (instructions.startsWith('{')) {
        try { const j = JSON.parse(instructions); if (typeof j.instructions === 'string') instructions = j.instructions.trim(); } catch { /* treat as raw text */ }
      }
      if (!instructions) { json(res, 400, { ok: false, error: 'missing_instructions' }); return; }
      const objective = `${BUILDER_PREAMBLE}\n\nTASK:\n${instructions}`;
      const out = await runTrajectory('generic_browser_task', { url: BUILDER_BOOTSTRAP_URL, objective }, null, TIMEOUT_MS);
      if (out.error === 'no_trajectory') { json(res, 500, { ok: false, error: 'builder_trajectory_missing' }); return; }
      const doc = out.result && typeof out.result === 'object' ? out.result : {};
      const payload = {
        ok: out.ok,
        run_id: out.run_id,
        exitCode: out.exitCode,
        final_url: doc.final_url ?? null,
        value: doc.value ?? null,
        trajectory_draft: doc.trajectory_draft ?? null,
        stdout_tail: out.stdout_tail,
        stderr_tail: out.stderr_tail,
        timed_out: out.timed_out,
      };
      // Return unredacted by default (the whole point is to get the result/creds
      // the task asked for); redact only when raw creds are globally forbidden.
      json(res, out.ok ? 200 : 502, payload, { redact: !ALLOW_RAW_CREDS });
      return;
    }
    if (!(req.method === 'POST' && url.pathname === '/run')) {
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (!authorized(req)) {
      json(res, TOKEN || ALLOW_UNAUTH ? 401 : 500, {
        ok: false,
        error: TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_API_TOKEN',
      });
      return;
    }
    let body;
    try { body = await readBody(req); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    if (!action) { json(res, 400, { ok: false, error: 'missing_action' }); return; }
    const credsMode = typeof body.creds === 'string' ? body.creds.trim() : 'redact';
    if (!['redact', 'raw', 'store'].includes(credsMode)) {
      json(res, 400, { ok: false, error: 'creds must be redact|raw|store' });
      return;
    }
    if (credsMode === 'raw' && !ALLOW_RAW_CREDS) {
      json(res, 403, { ok: false, error: 'raw_creds_forbidden' });
      return;
    }
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const accountId = typeof body.account_id === 'string' ? body.account_id : null;
    const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS;
    const out = await runTrajectory(action, params, accountId, timeoutMs);

    if (out.error === 'no_trajectory') { json(res, 404, out); return; }

    // store mode: persist extracted creds, return only a reference (no raw run).
    if (credsMode === 'store') {
      if (!out.ok) { json(res, 502, { ok: false, exitCode: out.exitCode, action, run_id: out.run_id, error: 'run_failed', stderr_tail: out.stderr_tail }); return; }
      const creds = extractCreds(out.result);
      if (!creds) { json(res, 422, { ok: false, action, run_id: out.run_id, error: 'no_credentials_in_result' }); return; }
      let ref;
      try { ref = await storeCredential(action, params, creds, out.run_id); }
      catch (e) { json(res, 502, { ok: false, action, run_id: out.run_id, error: `store_failed: ${String(e && e.message ? e.message : e).slice(0, 200)}` }); return; }
      json(res, 200, { ok: true, action, run_id: out.run_id, credential: ref });
      return;
    }

    // raw mode: return unredacted (creds in the response); redact mode: default.
    json(res, out.ok ? 200 : 502, out, { redact: credsMode !== 'raw' });
  } catch (error) {
    json(res, 500, { ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[weles-api] listening http://${HOST}:${PORT} auth=${Boolean(TOKEN || ALLOW_UNAUTH)} rawCreds=${ALLOW_RAW_CREDS}`);
});
