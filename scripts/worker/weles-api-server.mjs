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
// Env:
//   WELES_API_TOKEN  (or WELES_CONSOLE_API_TOKEN)  required unless WELES_API_ALLOW_UNAUTH=1
//   WELES_API_HOST   default 127.0.0.1  (set 0.0.0.0 to expose on the LAN/Tailscale)
//   WELES_API_PORT   default 8788       (keyword-planner-api already owns 8787)
//   WELES_API_TIMEOUT_MS  default 900000 (15 min)
//   WELES_API_BODY_LIMIT_BYTES default 262144
//   plus the usual worker env (SUPABASE_URL/KEY, CHROMIUM_PATH, proxy creds, ...)
//
// Routes:
//   GET  /healthz              -> liveness + config summary (no secrets)
//   POST /run                  -> { action, params?, account_id?, timeout_ms? }
//                                 runs the trajectory, returns { ok, exitCode,
//                                 action, run_id, result, stdout_tail, stderr_tail }
//
// Secret hygiene: stdout/stderr and the parsed result are passed through a
// secret-shape redactor before they leave the process, so a login/register
// trajectory cannot exfiltrate a token (xoxp/JWT/PEM/AWS/opaque) over HTTP.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');

const { resolveTrajectory, paramsToEnv } = await import(`${REPO}/dist/worker/dispatch.js`);

const HOST = process.env.WELES_API_HOST || '127.0.0.1';
const PORT = Number(process.env.WELES_API_PORT || 8788);
const TOKEN = process.env.WELES_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || '';
const ALLOW_UNAUTH = process.env.WELES_API_ALLOW_UNAUTH === '1';
const TIMEOUT_MS = Number(process.env.WELES_API_TIMEOUT_MS || 15 * 60 * 1000);
const BODY_LIMIT = Number(process.env.WELES_API_BODY_LIMIT_BYTES || 256 * 1024);

function authorized(req) {
  if (ALLOW_UNAUTH) return true;
  if (!TOKEN) return false;
  if (String(req.headers.authorization || '') === `Bearer ${TOKEN}`) return true;
  return String(req.headers['x-api-key'] || '') === TOKEN;
}

function json(res, code, obj) {
  const body = JSON.stringify(redactSecrets(obj));
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

function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{') || lines[i].startsWith('[')) {
      try { return JSON.parse(lines[i]); } catch { /* keep scanning up */ }
    }
  }
  return null;
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
      resolveRun({
        ok: exitCode === 0,
        exitCode,
        action,
        run_id: runId,
        result: lastJsonLine(stdout),
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
      json(res, 200, { ok: true, source: 'weles_api', authConfigured: Boolean(TOKEN || ALLOW_UNAUTH) });
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
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const accountId = typeof body.account_id === 'string' ? body.account_id : null;
    const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS;
    const out = await runTrajectory(action, params, accountId, timeoutMs);
    json(res, out.ok ? 200 : (out.error === 'no_trajectory' ? 404 : 502), out);
  } catch (error) {
    json(res, 500, { ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[weles-api] listening http://${HOST}:${PORT} auth=${Boolean(TOKEN || ALLOW_UNAUTH)}`);
});
