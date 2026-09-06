// Weles HTTP API — synchronous trajectory runner.
//
// Purpose: run a Weles trajectory synchronously and return its result without
// an external queue roundtrip. It reuses the worker's own resolveTrajectory and
// paramsToEnv implementation so the action is identical to the queued path.
//
// It spawns the same trajectory child the worker spawns. On macOS, when the
// API is a system LaunchDaemon and a GUI login exists, that child enters the
// user's GUI bootstrap before it starts. Trajectory logic stays unchanged.
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
//   WELES_API_TOKEN  (or WELES_CONSOLE_API_TOKEN) required for the general API
//   BRAMA_WELES_REAUTH_TOKEN required for Brama's POST /reauth admission
//   WELES_API_HOST   default 127.0.0.1  (set 0.0.0.0 to expose on the LAN/Tailscale)
//   WELES_API_PORT   default 8788       (keyword-planner-api already owns 8787)
//   WELES_API_TIMEOUT_MS  default 900000
//   WELES_API_BODY_LIMIT_BYTES default 262144
//   WELES_API_ALLOW_RAW_CREDS  default "1"
//   WELES_API_BASE, WELES_TOKEN, WISENT_ORGANIZATION_ID for destination imports
//   plus the worker browser, proxy, Stado, and Skarbiec configuration
//
// Routes:
//   GET  /healthz                         -> liveness + config summary
//   POST /run                             -> synchronous trajectory execution
//   POST /imports                         -> validate and persist host-bound draft trajectories
//   GET  /diagnostics/:run_id             -> authenticated artifact manifest
//   GET  /diagnostics/:run_id/file?path=  -> authenticated artifact download
//   GET  /worker/status                   -> authenticated launchd worker state
//   POST /worker/start                    -> authenticated idempotent start
//   POST /worker/restart                  -> authenticated forced restart

import http from 'node:http';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReadStream,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
// Where a detached run records what happened, outside the repository so a
// rebuild cannot delete the answer.
const RUN_RESULTS_DIR = join(homedir(), '.stado', 'weles-detached-runs');
const RECORDINGS_ROOT = process.env.WELES_RECORDINGS_ROOT || join(homedir(), '.stado', 'var', 'weles', 'recordings');

function persistRunResult(path, document) {
  mkdirSync(RUN_RESULTS_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(document), { mode: 0o600 });
  renameSync(temporary, path);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const SOURCE_IDENTITY = JSON.parse(readFileSync(join(REPO, 'release', 'source-identity.json'), 'utf8'));
if (SOURCE_IDENTITY.schema !== 'weles.source-identity.v1'
    || SOURCE_IDENTITY.product !== 'weles-worker'
    || SOURCE_IDENTITY.version !== process.env.WELES_WORKER_RELEASE_VERSION
    || typeof SOURCE_IDENTITY.source_revision !== 'string'
    || !/^[0-9a-f]{40}$/.test(SOURCE_IDENTITY.source_revision)) {
  throw new Error('embedded Weles source identity does not match the deployed release');
}
const RUN_RELEASE_IDENTITY = Object.freeze({
  release_version: process.env.WELES_WORKER_RELEASE_VERSION || null,
  release_sha256: process.env.WELES_WORKER_RELEASE_SHA256 || null,
  source_revision: SOURCE_IDENTITY.source_revision,
});

const { resolveTrajectory, paramsToEnv } = await import(`${REPO}/dist/worker/dispatch.js`);
const { buildDeploymentVersionValue } = await import(`${REPO}/dist/worker/deployment_version.js`);
// Account selection is one table shared with the queued path and the
// trajectories, so /reauth, /run and a hand-run trajectory all resolve the same
// vault login item id to the same account.
const { LOGIN_ACCOUNTS, selectLoginAccount } = await import(`${REPO}/dist/utils/login-accounts.js`);
const { readPrivateStadoObjectIdentity, uploadArtifacts } = await import(`${REPO}/dist/worker/upload-artifacts.js`);
const { resolveBrowserEvidenceTarget, SPIS_BROWSER_EVIDENCE_POLICY } = await import(`${REPO}/dist/agent/browser-evidence-policy.js`);
const { createPublicTaskService, publicTaskErrorResponse } = await import('./public-task-service.mjs');
const { importWelesTrajectoryDocument } = await import(`${REPO}/dist/import.js`);

function boundedIntegerEnvironment(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] ?? fallback);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive base-10 integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
const HOST = process.env.WELES_API_HOST || '127.0.0.1';
const PORT = Number(process.env.WELES_API_PORT || 8788);
const TOKEN = process.env.WELES_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || '';
const BRAMA_REAUTH_TOKEN = process.env.BRAMA_WELES_REAUTH_TOKEN || '';
const ALLOW_UNAUTH = process.env.WELES_API_ALLOW_UNAUTH === '1';
const ALLOW_RAW_CREDS = (process.env.WELES_API_ALLOW_RAW_CREDS ?? '1') === '1';
const TIMEOUT_MS = Number(process.env.WELES_API_TIMEOUT_MS || 15 * 60 * 1000);
const PUBLIC_TASK_TIMEOUT_MS = boundedIntegerEnvironment(
  'WELES_PUBLIC_TASK_TIMEOUT_MS',
  2 * 60 * 60 * 1_000,
  15 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
);
const PUBLIC_TASK_CONCURRENCY = boundedIntegerEnvironment(
  'WELES_PUBLIC_TASK_CONCURRENCY',
  1,
  1,
  1,
);
const BODY_LIMIT = Number(process.env.WELES_API_BODY_LIMIT_BYTES || 256 * 1024);
const RUN_DEDUPLICATION_TTL_MS = Number(process.env.WELES_API_RUN_DEDUPLICATION_TTL_MS || 60_000);
const coalescedRuns = new Map();

function runAdmissionKey(kind, identity) {
  return `${kind}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function coalesceRun(key, start, metadata = {}) {
  const now = Date.now();
  const existing = coalescedRuns.get(key);
  if (existing && (existing.completedAt === null || now - existing.completedAt <= RUN_DEDUPLICATION_TTL_MS)) {
    return { entry: existing, joined: true };
  }
  const entry = { promise: null, completedAt: null, metadata };
  entry.promise = Promise.resolve()
    .then(start)
    .finally(() => {
      entry.completedAt = Date.now();
      const timer = setTimeout(() => {
        if (coalescedRuns.get(key) === entry) coalescedRuns.delete(key);
      }, RUN_DEDUPLICATION_TTL_MS);
      timer.unref();
    });
  coalescedRuns.set(key, entry);
  return { entry, joined: false };
}

function isCredentialTrajectory(action) {
  return /(?:^|_)(?:login|reauth|register)$/.test(action);
}

function signalRunProcess(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone while the direct child still exits.
    }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}
const IMPORT_BODY_LIMIT = 2 * 1024 * 1024 + 4 * 1024;
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

function tokenAuthorized(req) {
  if (!TOKEN) return false;
  if (String(req.headers.authorization || '') === `Bearer ${TOKEN}`) return true;
  return String(req.headers['x-api-key'] || '') === TOKEN;
}

function reauthAuthorized(req) {
  return Boolean(
    BRAMA_REAUTH_TOKEN
      && String(req.headers.authorization || '') === `Bearer ${BRAMA_REAUTH_TOKEN}`,
  );
}

function authorized(req) {
  return ALLOW_UNAUTH || tokenAuthorized(req);
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

function skarbiecAcquisitionFailureReason(stderr) {
  if (/acquisition field does not exist on item|canonical item has no field:/.test(stderr)) {
    return 'field_not_present';
  }
  if (/undeclared Skarbiec acquisition scope/.test(stderr)) return 'scope_not_declared';
  if (/Skarbiec .* is unreachable|endpoint .* is not listening/.test(stderr)) {
    return 'authority_unreachable';
  }
  if (/\bHTTP 401\b/.test(stderr)) return 'workload_not_authorized';
  return undefined;
}

function credentialFailure(out) {
  const stderr = String(out.stderr_tail || '');
  const stages = [...stderr.matchAll(/^STEP ([a-z][a-z0-9_-]{0,63})$/gm)];
  const stage = stages.length ? stages[stages.length - 1][1] : undefined;
  const withStage = (failure) => (stage ? { ...failure, stage } : failure);

  if (out.timed_out) return withStage({ code: 'trajectory_timeout' });

  let match = stderr.match(
    /workload-bound Skarbiec acquisition failed for ([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+) as consumer ([A-Za-z0-9._-]+)/,
  );
  if (match) {
    const reason = skarbiecAcquisitionFailureReason(stderr);
    return withStage({
      code: 'skarbiec_acquisition_failed',
      item: match[1],
      field: match[2],
      consumer: match[3],
      ...(reason ? { reason } : {}),
    });
  }

  if (/no login material for '/.test(stderr)) {
    return withStage({ code: 'login_material_unavailable' });
  }
  if (/claude binary not at /.test(stderr)) {
    return withStage({ code: 'claude_binary_missing' });
  }

  match = stderr.match(/needs capability '([A-Za-z0-9._-]+)'/);
  if (match) {
    return withStage({ code: 'capability_unavailable', capability: match[1] });
  }
  if (/loginMethod=.*expected google_sso/.test(stderr)) {
    return withStage({ code: 'login_method_mismatch' });
  }
  if (/authorization code never displayed/.test(stderr)) {
    return withStage({ code: 'authorization_code_unavailable' });
  }
  if (/auth login: .* not seen in /.test(stderr)) {
    return withStage({ code: 'claude_auth_prompt_unavailable' });
  }

  match = stderr.match(/auth login exited early \(code (-?\d+)\)/);
  if (match) {
    return withStage({ code: 'claude_auth_exited_early', exit_code: Number(match[1]) });
  }
  return withStage({ code: 'trajectory_failed' });
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function diagnosticsContentType(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webm': return 'video/webm';
    case '.mp4': return 'video/mp4';
    case '.html': return 'text/html; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.ndjson': return 'application/x-ndjson; charset=utf-8';
    case '.har': return 'application/json; charset=utf-8';
    case '.log':
    case '.txt':
    case '.patch': return 'text/plain; charset=utf-8';
    case '.pcap': return 'application/vnd.tcpdump.pcap';
    default: return 'application/octet-stream';
  }
}

function decodeRunId(raw) {
  try {
    const runId = decodeURIComponent(raw);
    return SAFE_RUN_ID.test(runId) ? runId : null;
  } catch {
    return null;
  }
}

function diagnosticsCandidates() {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  // New releases write outside their immutable runtime so an activation cannot
  // strand the previous release's evidence.
  add(process.env.WELES_RECORDINGS_ROOT);
  add(join(REPO, 'recordings'));

  // Managed releases before the stable recordings root wrote beside their
  // unpacked runtime. Keep those runs diagnosable after `current` advances.
  const managed = join(homedir(), '.stado', 'services', 'weles-admission');
  try {
    for (const release of readdirSync(managed, { withFileTypes: true })) {
      if (!release.isDirectory()) continue;
      const releaseRoot = join(managed, release.name);
      for (const platform of readdirSync(releaseRoot, { withFileTypes: true })) {
        if (!platform.isDirectory()) continue;
        add(join(releaseRoot, platform.name, 'runtime', 'recordings'));
      }
    }
  } catch {}

  // The retired per-version installer is still where runs made by 0.5.44 and
  // earlier live. Stado's activity reader already counts these exact roots; the
  // authenticated diagnostics route must be able to open the run it reports.
  const legacy = join(homedir(), '.local', 'share', 'weles-worker');
  try {
    for (const release of readdirSync(legacy, { withFileTypes: true })) {
      if (!release.isDirectory()) continue;
      const releaseRoot = join(legacy, release.name);
      for (const platform of readdirSync(releaseRoot, { withFileTypes: true })) {
        if (!platform.isDirectory()) continue;
        add(join(releaseRoot, platform.name, 'recordings'));
      }
    }
  } catch {}
  return candidates;
}

function diagnosticsRoot(runId) {
  for (const candidate of diagnosticsCandidates()) {
    let recordingsRoot;
    let runRoot;
    try {
      recordingsRoot = realpathSync(candidate);
      runRoot = realpathSync(join(recordingsRoot, runId));
    } catch {
      continue;
    }
    if (runRoot.startsWith(`${recordingsRoot}${sep}`)) return runRoot;
  }
  return null;
}

function runResultFile(runId) {
  const candidate = join(RUN_RESULTS_DIR, `${runId}.json`);
  try {
    const resultsRoot = realpathSync(RUN_RESULTS_DIR);
    const lstat = lstatSync(candidate);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
    const path = realpathSync(candidate);
    if (!path.startsWith(`${resultsRoot}${sep}`)) return null;
    return { path, stat: statSync(path) };
  } catch {
    return null;
  }
}

function diagnosticsManifest(runId) {
  const root = diagnosticsRoot(runId);
  const result = runResultFile(runId);
  if (!root && !result) return null;
  const files = [];
  if (result) {
    files.push({
      path: 'run-result.json',
      bytes: result.stat.size,
      modified_at: result.stat.mtime.toISOString(),
      content_type: 'application/json',
      download_url: `/diagnostics/${encodeURIComponent(runId)}/file?path=run-result.json`,
    });
  }
  const stack = root ? [{ dir: root, rel: '' }] : [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current.dir, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push({ dir: full, rel });
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      files.push({
        path: rel,
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        content_type: diagnosticsContentType(rel),
        download_url: `/diagnostics/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(rel)}`,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    run_id: runId,
    recordings_root: root,
    total_files: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

function diagnosticFile(runId, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.includes('\0')) return null;
  if (requestedPath === 'run-result.json') return runResultFile(runId);
  const root = diagnosticsRoot(runId);
  if (!root) return null;
  const candidate = resolve(root, requestedPath);
  if (!candidate.startsWith(`${root}${sep}`)) return null;
  try {
    const lstat = lstatSync(candidate);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
    const real = realpathSync(candidate);
    if (!real.startsWith(`${root}${sep}`)) return null;
    const stat = statSync(real);
    return { path: real, stat };
  } catch {
    return null;
  }
}

function requireTokenAuthorization(req, res) {
  if (tokenAuthorized(req)) return true;
  json(res, TOKEN ? 401 : 500, { ok: false, error: TOKEN ? 'unauthorized' : 'missing_WELES_API_TOKEN' });
  return false;
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
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

function findResultDoc(runId) {
  const runRoot = join(RECORDINGS_ROOT, runId);
  const actionRoot = join(runRoot, 'generic_browser_task');
  const resultPath = join(actionRoot, 'generic_task_result.json');
  try {
    const runMetadata = lstatSync(runRoot);
    const actionMetadata = lstatSync(actionRoot);
    const resultMetadata = lstatSync(resultPath);
    if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()
        || !actionMetadata.isDirectory() || actionMetadata.isSymbolicLink()
        || !resultMetadata.isFile() || resultMetadata.isSymbolicLink()
        || resultMetadata.size < 1 || resultMetadata.size > 1024 * 1024) {
      return null;
    }
    const realRunRoot = realpathSync(runRoot);
    const realResult = realpathSync(resultPath);
    if (!realResult.startsWith(`${realRunRoot}${sep}`)) return null;
    return JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch {
    return null;
  }
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
  const { upsertCredential } = await import(`${REPO}/src/lib/service_credentials.mjs`);
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

function trajectoryProcess(trajPath) {
  const direct = { command: process.execPath, args: [trajPath] };
  if (process.platform !== 'darwin') return direct;
  let session = 'unknown';
  try {
    session = execFileSync('/bin/launchctl', ['managername'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* use direct */ }
  if (session === 'Aqua') return direct;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) return direct;
  try { execFileSync('/bin/launchctl', ['print', `gui/${uid}`], { stdio: 'ignore' }); } catch { return direct; }
  const username = userInfo().username;
  if (!username) return direct;
  return {
    command: '/usr/bin/sudo',
    args: ['-n', '-E', '/bin/launchctl', 'asuser', String(uid), '/usr/bin/sudo', '-n', '-E', '-u', username, process.execPath, trajPath],
  };
}

const PUBLIC_TASK_ENV_ALLOWLIST = Object.freeze([
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH',
  'SSL_CERT_DIR', 'SSL_CERT_FILE', 'STADO_BIN', 'STADO_MODEL_ROUTER_URL',
  'TMPDIR', 'WELES_CHROMIUM_DIR', 'WELES_CHROMIUM_RELEASE_SHA256',
  'WELES_CHROMIUM_RELEASE_VERSION', 'WELES_JEDEN_BIN', 'WELES_RECORDINGS_ROOT',
  'WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET', 'WELES_STADO_MODEL_ROUTER_AGENT_ID',
  'WELES_STADO_MODEL_ROUTER_TOKEN', 'XDG_CONFIG_HOME',
]);

function publicTaskChildEnvironment(policy, networkTarget) {
  const environment = {};
  for (const name of PUBLIC_TASK_ENV_ALLOWLIST) {
    if (typeof process.env[name] === 'string' && process.env[name].length > 0) environment[name] = process.env[name];
  }
  return {
    ...environment,
    WELES_AGENT_MODEL: 'weles',
    WELES_BROWSER_EVIDENCE_POLICY: policy.version,
    WELES_BROWSER_EVIDENCE_POLICY_JSON: JSON.stringify(policy),
    WELES_BROWSER_EVIDENCE_TARGET_ORIGIN: networkTarget.origin,
    WELES_BROWSER_EVIDENCE_TARGET_HOST: networkTarget.hostname,
    WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON: JSON.stringify(networkTarget.addresses),
    WELES_DISABLE_RECORDING: '1',
    WELES_NO_INSTRUMENT: '1',
    GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY: '1',
  };
}

function boundedOutputTail(current, chunk, maximumCharacters) {
  const next = `${current}${chunk.toString()}`;
  return next.length <= maximumCharacters ? next : next.slice(-maximumCharacters);
}

function runTrajectory(action, params, accountId, freshProfile, timeoutMs, runOptions = {}) {
  return new Promise((resolveRun) => {
    const trajPath = resolveTrajectory(action);
    if (!trajPath) { resolveRun({ ok: false, error: 'no_trajectory', action }); return; }
    const runId = runOptions.runId || randomUUID();
    if (!SAFE_RUN_ID.test(runId)) { resolveRun({ ok: false, error: 'invalid_run_id', action }); return; }
    const startedAt = new Date().toISOString();
    const runResultPath = join(RUN_RESULTS_DIR, `${runId}.json`);
    try {
      persistRunResult(runResultPath, { ok: null, ...RUN_RELEASE_IDENTITY, action, run_id: runId, status: 'running', started_at: startedAt });
    } catch (error) {
      resolveRun({ ok: false, error: 'run_metadata_unavailable', action, run_id: runId, stderr_tail: String(error?.message || error).slice(0, 300) });
      return;
    }
    const env = {
      ...(runOptions.childEnvironment ?? process.env),
      ...(runOptions.childEnvironment ? {} : { WELES_FULL_DIAGNOSTICS: process.env.WELES_FULL_DIAGNOSTICS ?? '1' }),
      ...paramsToEnv(params || {}, action, trajPath),
      ...(accountId ? { ACCOUNT_ID: String(accountId) } : {}),
      ...(freshProfile ? { WELES_FRESH_PROFILE: '1' } : {}),
      ...(runOptions.extraEnv || {}),
      ACTION_LOG_ID: runId,
      ACTION: action,
    };
    const processSpec = trajectoryProcess(trajPath);
    const child = spawn(processSpec.command, processSpec.args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const abortRun = () => {
      cancelled = true;
      signalRunProcess(child, 'SIGTERM');
      const hardKill = setTimeout(() => signalRunProcess(child, 'SIGKILL'), 8000);
      hardKill.unref();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runOptions.signal?.removeEventListener('abort', abortRun);
      try {
        persistRunResult(runResultPath, { ...result, ...RUN_RELEASE_IDENTITY, action, run_id: runId, status: 'finished', started_at: startedAt, completed_at: new Date().toISOString() });
      } catch (error) {
        result = { ...result, metadata_error: `run metadata could not be completed: ${String(error?.message || error).slice(0, 240)}` };
      }
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalRunProcess(child, 'SIGTERM');
      const hardKill = setTimeout(() => signalRunProcess(child, 'SIGKILL'), 8000);
      hardKill.unref();
    }, timeoutMs);
    timer.unref();
    if (runOptions.signal?.aborted) abortRun();
    else runOptions.signal?.addEventListener('abort', abortRun, { once: true });
    child.stdout.on('data', (chunk) => { stdout = boundedOutputTail(stdout, chunk, 2 * 1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = boundedOutputTail(stderr, chunk, 512 * 1024); });
    child.once('error', (error) => {
      finish({ ok: false, exitCode: -1, action, run_id: runId, result: null, stdout_tail: stdout.slice(-4000), stderr_tail: `${stderr}\n${String(error?.message || error)}`.slice(-2000), timed_out: false, cancelled });
    });
    child.on('close', (code) => {
      const exitCode = timedOut || cancelled ? 137 : (code ?? -1);
      const result = lastJsonLine(stdout) ?? findResultDoc(runId);
      finish({ ok: exitCode === 0, exitCode, action, run_id: runId, result, stdout_tail: stdout.slice(-4000), stderr_tail: stderr.slice(-2000), timed_out: timedOut, cancelled });
    });
  });
}

// Providers whose reauth trajectory can run on the host on demand. This is the
// "call Weles on the host to authenticate" step: the broker decides WHICH
// provider + method, weles-api runs that provider's reauth trajectory locally,
// and only the run status leaves the process.
const REAUTH_PROVIDERS = new Set(['codex', 'claude', 'kimi']);

// `account` is the row this run must sign in, already resolved from the caller's
// login_item. It reaches the trajectory as <PROVIDER>_DISPLAY_NAME, which is the
// selector every reauth/login trajectory already honours, plus WELES_LOGIN_ITEM
// so the run and its report agree on which account was asked for.
function runReauth(provider, timeoutMs, account) {
  return new Promise((resolveRun) => {
    const trajPath = resolve(REPO, 'scripts/trajectories', provider, 'reauth.mjs');
    if (!existsSync(trajPath)) { resolveRun({ ok: false, error: 'no_reauth_trajectory', provider }); return; }
    const runId = randomUUID();
    const action = `${provider}_reauth`;
    const startedAt = new Date().toISOString();
    const runResultPath = join(RUN_RESULTS_DIR, `${runId}.json`);
    try {
      persistRunResult(runResultPath, {
        ...RUN_RELEASE_IDENTITY,
        action,
        run_id: runId,
        status: 'running',
        started_at: startedAt,
        completed_at: null,
      });
    } catch (error) {
      resolveRun({
        ok: false,
        error: 'run_metadata_unavailable',
        detail: String(error?.message || error).slice(0, 240),
        provider,
      });
      return;
    }
    const processSpec = trajectoryProcess(trajPath);
    const child = spawn(processSpec.command, processSpec.args, {
      cwd: REPO,
      env: {
        ...process.env,
        WELES_FULL_DIAGNOSTICS: process.env.WELES_FULL_DIAGNOSTICS ?? '1',
        ACTION_LOG_ID: runId,
        ACTION: action,
        ...(account
          ? {
            WELES_LOGIN_ITEM: account.loginItem,
            [`${provider.toUpperCase()}_DISPLAY_NAME`]: account.displayName,
            ...(account.subscriptionId ? { BRAMA_SUBSCRIPTION_ID: account.subscriptionId } : {}),
          }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = ''; let stderr = ''; let killed = false; let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        persistRunResult(runResultPath, {
          ...result,
          ...RUN_RELEASE_IDENTITY,
          action,
          run_id: runId,
          status: 'finished',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        });
      } catch (error) {
        result = {
          ...result,
          metadata_error: `run metadata could not be completed: ${String(error?.message || error).slice(0, 240)}`,
        };
      }
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      killed = true;
      signalRunProcess(child, 'SIGTERM');
      const hardKill = setTimeout(() => signalRunProcess(child, 'SIGKILL'), 8000);
      hardKill.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.once('error', (error) => {
      finish({
        ok: false,
        exitCode: -1,
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: account ? (account.subscriptionId || null) : null,
        run_id: runId,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: `${stderr}\n${String(error?.message || error)}`.slice(-2000),
        timed_out: false,
      });
    });
    child.on('close', (code) => {
      const exitCode = killed ? 137 : (code ?? -1);
      finish({
        ok: exitCode === 0,
        exitCode,
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: account ? (account.subscriptionId || null) : null,
        run_id: runId,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-2000),
        timed_out: killed,
      });
    });
  });
}

const WORKER_LABEL = process.env.WELES_WORKER_LAUNCHD_LABEL || 'com.wisent.weles-worker';
const WORKER_TARGET = `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}/${WORKER_LABEL}`;
const WORKER_DOMAIN = WORKER_TARGET.slice(0, WORKER_TARGET.lastIndexOf('/'));
const WORKER_PLIST = process.env.WELES_WORKER_LAUNCHD_PLIST
  || join(process.env.HOME || homedir(), 'Library', 'LaunchAgents', `${WORKER_LABEL}.plist`);
let workerControlBusy = false;

function runLaunchctl(args) {
  return new Promise((resolveCommand) => {
    execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolveCommand({
        ok: !error,
        code: error ? (error.code ?? -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '').trim().slice(0, 1000),
      });
    });
  });
}

function parseWorkerStatus(command) {
  if (!command.ok) {
    return {
      supported: true,
      label: WORKER_LABEL,
      loaded: false,
      running: false,
      pid: null,
      state: 'unloaded',
      last_exit_status: null,
    };
  }
  const state = /^\s*state = (.+)$/m.exec(command.stdout)?.[1]?.trim() || 'unknown';
  const pidMatch = /^\s*pid = (\d+)$/m.exec(command.stdout);
  const exitMatch = /^\s*last exit code = (-?\d+)$/m.exec(command.stdout);
  return {
    supported: true,
    label: WORKER_LABEL,
    loaded: true,
    running: state === 'running',
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state,
    last_exit_status: exitMatch ? Number(exitMatch[1]) : null,
  };
}

async function workerStatus() {
  if (process.platform !== 'darwin') {
    return {
      supported: false,
      label: WORKER_LABEL,
      loaded: false,
      running: false,
      pid: null,
      state: 'unsupported_platform',
      last_exit_status: null,
    };
  }
  return parseWorkerStatus(await runLaunchctl(['print', WORKER_TARGET]));
}

async function waitForWorkerRunning(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let status = await workerStatus();
  while (!status.running && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    status = await workerStatus();
  }
  return status;
}

async function controlWorker(action) {
  const before = await workerStatus();
  if (!before.supported) {
    return { ok: false, error: 'worker_control_requires_macos', action, before };
  }
  if (action === 'start' && before.running) {
    return { ok: true, action, changed: false, before, after: before };
  }

  let command;
  if (!before.loaded) {
    if (!existsSync(WORKER_PLIST)) {
      return { ok: false, error: 'worker_launchagent_plist_missing', action, plist: WORKER_PLIST, before };
    }
    command = await runLaunchctl(['bootstrap', WORKER_DOMAIN, WORKER_PLIST]);
  } else {
    command = await runLaunchctl(action === 'restart'
      ? ['kickstart', '-k', WORKER_TARGET]
      : ['kickstart', WORKER_TARGET]);
  }
  if (!command.ok) {
    return {
      ok: false,
      error: 'launchctl_failed',
      action,
      launchctl_code: command.code,
      launchctl_stderr: command.stderr,
      before,
      after: await workerStatus(),
    };
  }

  const after = await waitForWorkerRunning();
  return {
    ok: after.running,
    ...(after.running ? {} : { error: 'worker_not_running_after_control_action' }),
    action,
    changed: true,
    before,
    after,
  };
}
const PUBLIC_PLACEMENT_POLICY_FILE = process.env.WELES_PLACEMENT_POLICY_FILE
  || join(homedir(), '.config', 'weles', 'placement-policy.json');
const PUBLIC_SERVICE_DIRECTORY_FILE = process.env.WELES_PUBLIC_SERVICE_DIRECTORY_FILE
  || join(homedir(), '.stado', 'forwards', 'weles-admission.directory.json');
const PUBLIC_ADMISSION_ENDPOINT_FILE = process.env.WELES_ADMISSION_ENDPOINT_FILE
  || join(homedir(), '.stado', 'forwards', 'weles-admission.local');

function readBoundedRegularText(path, maximumBytes) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`Stado-published local document is unsafe: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

function readPublicServiceIdentity() {
  const placement = JSON.parse(readBoundedRegularText(PUBLIC_PLACEMENT_POLICY_FILE, 64 * 1024));
  const placementGeneration = placement?._source?.registry_generation;
  if (placement?.schema_version !== 1
      || (typeof placementGeneration !== 'string'
        && !Number.isSafeInteger(placementGeneration))
      || String(placementGeneration).length === 0
      || placement?._source?.by !== 'stado host publish-placement-policy'
      || !Array.isArray(placement.hosts)) {
    throw new Error('Stado-published Weles placement policy has an unsupported identity');
  }
  const admittedHosts = placement.hosts.filter((host) => (
    host && typeof host === 'object'
      && host.enabled === true
      && typeof host.hostname === 'string'
      && Array.isArray(host.actions)
      && host.actions.includes('generic_browser_task')
  ));
  if (admittedHosts.length !== 1) {
    throw new Error('Stado-published Weles placement policy does not authorize one exact public host');
  }

  const published = JSON.parse(readBoundedRegularText(PUBLIC_SERVICE_DIRECTORY_FILE, 64 * 1024));
  const service = published?.service;
  if (published?.schema !== 'weles.public-service-directory.v1'
      || Object.keys(published).length !== 3
      || !Number.isSafeInteger(published?.directory_generation)
      || !service || typeof service !== 'object' || Array.isArray(service)
      || Object.keys(service).length !== 6
      || service.name !== 'weles-admission'
      || service.active_host !== admittedHosts[0].hostname
      || service.action !== 'generic_browser_task'
      || service.release_id !== `weles-worker@${RUN_RELEASE_IDENTITY.release_version}`
      || service.source_revision !== RUN_RELEASE_IDENTITY.source_revision
      || typeof service.endpoint !== 'string') {
    throw new Error('published Weles service-directory snapshot has an unsupported identity');
  }
  const publishedEndpoint = new URL(service.endpoint);
  if (!['http:', 'https:'].includes(publishedEndpoint.protocol)
      || publishedEndpoint.username || publishedEndpoint.password
      || publishedEndpoint.search || publishedEndpoint.hash
      || publishedEndpoint.pathname !== '/api/v1'
      || publishedEndpoint.toString() !== service.endpoint) {
    throw new Error('published Weles service-directory endpoint is invalid');
  }
  const transportText = readBoundedRegularText(PUBLIC_ADMISSION_ENDPOINT_FILE, 2 * 1024).trim();
  const transportEndpoint = new URL(transportText);
  if (transportEndpoint.toString() !== service.endpoint) {
    throw new Error('local Weles admission transport differs from the published service directory');
  }
  return {
    name: service.name,
    generation: published.directory_generation,
    consumer: 'spis',
    capability: 'browser-evidence',
    active_host: service.active_host,
    endpoint: service.endpoint,
    action: service.action,
    release_id: service.release_id,
    source_revision: service.source_revision,
  };
}

const publicTaskService = createPublicTaskService({
  environment: process.env,
  policy: SPIS_BROWSER_EVIDENCE_POLICY,
  runResultsRoot: RUN_RESULTS_DIR,
  recordingsRoot: RECORDINGS_ROOT,
  releaseIdentity: RUN_RELEASE_IDENTITY,
  uploadArtifacts,
  readArtifactIdentity: readPrivateStadoObjectIdentity,
  redact: redactSecrets,
  concurrency: PUBLIC_TASK_CONCURRENCY,
  taskTimeoutMs: PUBLIC_TASK_TIMEOUT_MS,
  trajectoryReady: Boolean(resolveTrajectory('generic_browser_task')),
  artifactRetentionReady: Boolean(
    process.env.STADO_API_URL
      && process.env.WELES_STADO_OBJECT_API_TOKEN
      && Buffer.byteLength(process.env.WELES_STADO_OBJECT_API_TOKEN) >= 32
  ),
  readServiceIdentity: readPublicServiceIdentity,
  resolveTarget: resolveBrowserEvidenceTarget,
  runTrajectory: ({ action, params, runId, signal, policy, networkTarget }) => runTrajectory(
    action,
    params,
    null,
    true,
    PUBLIC_TASK_TIMEOUT_MS,
    {
      runId,
      signal,
      childEnvironment: publicTaskChildEnvironment(policy, networkTarget),
    },
  ),
});
await publicTaskService.recover();


const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        source: 'weles_api',
        authConfigured: Boolean(TOKEN || ALLOW_UNAUTH),
        rawCredsAllowed: ALLOW_RAW_CREDS,
        releaseVersion: process.env.WELES_WORKER_RELEASE_VERSION || null,
        releaseSha256: process.env.WELES_WORKER_RELEASE_SHA256 || null,
        routes: ['GET /healthz', 'GET /api/v1/version', 'POST /api/v1/tasks', 'GET /api/v1/tasks/:task_id', 'POST /api/v1/tasks/:task_id/cancel', 'GET /worker/version', 'GET /worker/status', 'POST /worker/start', 'POST /worker/restart', 'POST /run', 'GET /diagnostics/:run_id', 'GET /diagnostics/:run_id/file?path=', 'POST /weles-builder', 'POST /reauth'],
        publicTask: publicTaskService.health,
        // A caller that must name an account has to know, without spawning a
        // run, whether this build understands login_item at all: a build that
        // does not would ignore the field and sign in to whichever row it picked
        // itself, burning a real login on an unknown account.
        features: ['login_item', 'fresh_profile'],
        login_items: LOGIN_ACCOUNTS.map((a) => ({
          login_item: a.loginItem,
          provider: a.provider,
          display_name: a.displayName,
          primary: Boolean(a.primary),
          subscription_id: a.subscriptionId || null,
        })),
      });
      return;
    }
    try {
      const publicResponse = await publicTaskService.handle(req, url, readBody);
      if (publicResponse) {
        json(res, publicResponse.status, publicResponse.payload, { redact: false });
        return;
      }
    } catch (error) {
      const publicError = publicTaskErrorResponse(error);
      json(
        res,
        publicError?.status ?? 500,
        publicError?.payload ?? { error: 'internal-error', message: 'public task operation failed' },
        { redact: false },
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/worker/version') {
      if (!requireTokenAuthorization(req, res)) return;
      json(res, 200, { ok: true, identity: buildDeploymentVersionValue() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/worker/status') {
      if (!requireTokenAuthorization(req, res)) return;
      const status = await workerStatus();
      json(res, status.supported ? 200 : 501, { ok: status.supported, worker: status });
      return;
    }
    const workerControlMatch = /^\/worker\/(start|restart)$/.exec(url.pathname);
    if (req.method === 'POST' && workerControlMatch) {
      if (!requireTokenAuthorization(req, res)) return;
      if (workerControlBusy) {
        json(res, 409, { ok: false, error: 'worker_control_in_progress' });
        return;
      }
      workerControlBusy = true;
      try {
        const action = workerControlMatch[1];
        const out = await controlWorker(action);
        console.log(JSON.stringify({
          event: 'worker_control',
          action,
          ok: out.ok,
          changed: out.changed ?? false,
          remote: req.socket.remoteAddress || null,
          before: out.before,
          after: out.after,
        }));
        const statusCode = out.ok ? 200 : (out.error === 'worker_control_requires_macos' ? 501 : 502);
        json(res, statusCode, out);
      } finally {
        workerControlBusy = false;
      }
      return;
    }
    const diagnosticFileMatch = /^\/diagnostics\/([^/]+)\/file$/.exec(url.pathname);
    if (req.method === 'GET' && diagnosticFileMatch) {
      if (!requireTokenAuthorization(req, res)) return;
      const runId = decodeRunId(diagnosticFileMatch[1]);
      if (!runId) { json(res, 400, { ok: false, error: 'invalid_run_id' }); return; }
      const file = diagnosticFile(runId, url.searchParams.get('path'));
      if (!file) { json(res, 404, { ok: false, error: 'diagnostic_file_not_found' }); return; }
      res.writeHead(200, {
        'Content-Type': diagnosticsContentType(file.path),
        'Content-Length': String(file.stat.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
      return;
    }
    const diagnosticsMatch = /^\/diagnostics\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && diagnosticsMatch) {
      if (!requireTokenAuthorization(req, res)) return;
      const runId = decodeRunId(diagnosticsMatch[1]);
      if (!runId) { json(res, 400, { ok: false, error: 'invalid_run_id' }); return; }
      const manifest = diagnosticsManifest(runId);
      if (!manifest) { json(res, 404, { ok: false, error: 'diagnostics_not_found' }); return; }
      json(res, 200, manifest);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/imports') {
      if (!requireTokenAuthorization(req, res)) return;
      let body;
      try { body = await readBody(req, IMPORT_BODY_LIMIT); }
      catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      try {
        const report = await importWelesTrajectoryDocument(body.source, body.target_host);
        json(res, report.imported > 0 ? 201 : 200, report);
      } catch (e) {
        json(res, 400, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) });
      }
      return;
    }

    // reauth: run a provider's reauth trajectory ON THE HOST. Body:
    // { provider: "codex"|"claude"|"kimi", login_item?, subscription_id?,
    //   timeout_ms? }. `login_item` selects an exact row; when omitted, Weles
    // uses the one it explicitly declares primary. A supplied subscription id
    // must match that row before a browser login is spent on it.
    if (req.method === 'POST' && url.pathname === '/reauth') {
      if (!reauthAuthorized(req)) {
        json(res, BRAMA_REAUTH_TOKEN ? 401 : 500, {
          ok: false,
          error: BRAMA_REAUTH_TOKEN ? 'unauthorized' : 'missing_BRAMA_WELES_REAUTH_TOKEN',
        });
        return;
      }
      let body;
      try { body = await readBody(req); }
      catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
      if (!REAUTH_PROVIDERS.has(provider)) { json(res, 400, { ok: false, error: 'provider must be codex|claude|kimi' }); return; }
      const loginItem = typeof body.login_item === 'string' ? body.login_item.trim() : '';
      let account;
      try { account = selectLoginAccount(provider, loginItem || undefined); }
      catch (e) {
        json(res, 400, { ok: false, error: e.code || 'login_item_unresolved', message: e.message, ...(e.detail || {}) });
        return;
      }
      const subscriptionId = typeof body.subscription_id === 'string' ? body.subscription_id.trim() : '';
      if (subscriptionId && account.subscriptionId && subscriptionId !== account.subscriptionId) {
        json(res, 409, {
          ok: false,
          error: 'subscription_account_mismatch',
          message: `${account.loginItem} renews ${account.subscriptionId}, not ${subscriptionId}`,
          login_item: account.loginItem,
          subscription_id: account.subscriptionId,
        });
        return;
      }
      const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS;
      const admission = coalesceRun(
        runAdmissionKey('reauth', {
          provider,
          login_item: account.loginItem,
          subscription_id: subscriptionId || account.subscriptionId || null,
        }),
        () => runReauth(provider, timeoutMs, account),
      );
      const out = await admission.entry.promise;
      if (out.error === 'no_reauth_trajectory') { json(res, 404, out); return; }
      json(res, out.ok ? 200 : 502, { ...out, refreshed: out.ok, coalesced: admission.joined });
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
      const out = await runTrajectory('generic_browser_task', { url: BUILDER_BOOTSTRAP_URL, objective }, null, false, TIMEOUT_MS);
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
    const freshProfile = body.fresh_profile === true;
    if (freshProfile && !accountId) {
      json(res, 400, { ok: false, error: 'fresh_profile_requires_account_id' });
      return;
    }
    const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS;
    // A browser login runs for minutes. Every operator transport that can reach
    // this route closes long before that, and a request whose socket goes takes
    // the run with it, so the one action that renews a burnt subscription could
    // only be started by a client willing to wait -- which is to say, not by the
    // software. `detached: true` starts the run, answers with its id, and writes
    // the result where it can be read afterwards.
    if (body.detached === true) {
      const coalesced = isCredentialTrajectory(action);
      const admissionKey = coalesced
        ? runAdmissionKey('trajectory', { action, account_id: accountId, fresh_profile: freshProfile, params })
        : null;
      const detachedId = randomUUID();
      const resultPath = join(RUN_RESULTS_DIR, `${detachedId}.json`);
      const admission = admissionKey
        ? coalesceRun(
          admissionKey,
          () => runTrajectory(action, params, accountId, freshProfile, timeoutMs),
          { detachedId, resultPath },
        )
        : {
          entry: {
            promise: runTrajectory(action, params, accountId, freshProfile, timeoutMs),
            metadata: { detachedId, resultPath },
          },
          joined: false,
        };
      const admittedId = admission.entry.metadata.detachedId;
      const admittedPath = admission.entry.metadata.resultPath;
      if (!admission.joined) {
        persistRunResult(
          admittedPath,
          { ok: null, action, status: 'running', started_at: new Date().toISOString() },
        );
        admission.entry.promise
          .then((result) => {
            persistRunResult(
              admittedPath,
              { ...result, action, status: 'finished', completed_at: new Date().toISOString() },
            );
          })
          .catch((error) => {
            persistRunResult(
              admittedPath,
              {
                ok: false,
                action,
                status: 'failed',
                error: String(error && error.message ? error.message : error).slice(0, 300),
                completed_at: new Date().toISOString(),
              },
            );
          });
      }
      json(res, 202, {
        ok: true,
        action,
        detached_run: admittedId,
        result_path: admittedPath,
        coalesced: admission.joined,
      });
      return;
    }
    const admission = isCredentialTrajectory(action)
      ? coalesceRun(
        runAdmissionKey('trajectory', { action, account_id: accountId, fresh_profile: freshProfile, params }),
        () => runTrajectory(action, params, accountId, freshProfile, timeoutMs),
      )
      : { entry: { promise: runTrajectory(action, params, accountId, freshProfile, timeoutMs) }, joined: false };
    const out = await admission.entry.promise;

    if (out.error === 'no_trajectory') { json(res, 404, out); return; }

    // store mode: persist extracted creds, return only a reference (no raw run).
    if (credsMode === 'store') {
      if (!out.ok) { json(res, 502, { ok: false, exitCode: out.exitCode, action, run_id: out.run_id, error: 'run_failed', stderr_tail: out.stderr_tail }); return; }
      const creds = extractCreds(out.result);
      if (!creds) { json(res, 422, { ok: false, action, run_id: out.run_id, error: 'no_credentials_in_result' }); return; }
      let ref;
      try { ref = await storeCredential(action, params, creds, out.run_id); }
      catch (e) { json(res, 502, { ok: false, action, run_id: out.run_id, error: `store_failed: ${String(e && e.message ? e.message : e).slice(0, 200)}` }); return; }
      json(res, 200, { ok: true, action, run_id: out.run_id, credential: ref, coalesced: admission.joined });
      return;
    }
    // Credential trajectories print the minted credential to stdout so their
    // parent reauth flow can donate it to Skarbiec. Redact mode returns only
    // credential presence and allowlisted failure identifiers parsed from
    // stderr; raw output and arbitrary failure text stay inside Weles.
    if (isCredentialTrajectory(action) && credsMode !== 'raw') {
      const result = { credential_produced: out.ok && out.result !== null };
      if (!out.ok) result.failure = credentialFailure(out);
      json(res, out.ok ? 200 : 502, {
        ok: out.ok,
        exitCode: out.exitCode,
        action,
        run_id: out.run_id,
        result,
        timed_out: out.timed_out,
        coalesced: admission.joined,
      });
      return;
    }


    // raw mode: return unredacted (creds in the response); redact mode: default.
    json(res, out.ok ? 200 : 502, { ...out, coalesced: admission.joined }, { redact: credsMode !== 'raw' });
  } catch (error) {
    json(res, 500, { ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[weles-api] listening http://${HOST}:${PORT} auth=${Boolean(TOKEN || ALLOW_UNAUTH)} rawCreds=${ALLOW_RAW_CREDS}`);
});

let shutdownStarted = false;
async function shutdownApi(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[weles-api] draining public tasks after ${signal}`);
  server.close();
  const forcedExit = setTimeout(() => process.exit(1), 30_000);
  forcedExit.unref();
  await publicTaskService.shutdown();
  clearTimeout(forcedExit);
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdownApi('SIGTERM'); });
process.on('SIGINT', () => { void shutdownApi('SIGINT'); });
