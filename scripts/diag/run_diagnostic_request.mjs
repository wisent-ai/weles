#!/usr/bin/env node
// Executes one console-created diagnostic ladder request.
//
// Scope: capture infrastructure only. For human_home_chrome this opens stock
// Chrome and records the operator-driven session; it does not fill or submit
// registration forms. The resulting artifacts/results are written back to the
// same account_action_logs row that console created.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

loadDotEnv();

const { runRecordingsDir } = await import('../../dist/session/run-recordings.js');
const { captureVersions } = await import('../../dist/diagnostics/versions.js');
const { uploadArtifacts } = await import('../../dist/worker/upload-artifacts.js');
const { writeNetworkCapture } = await import('../../dist/diagnostics/run-import.js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CLAIM_ID = `diagnostic-executor-${hostname() || 'host'}-${process.pid}`;
const TARGET_BY_ACTION = {
  linkedin_register: 'https://www.linkedin.com/signup',
};

function headers() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function diagnosticStage(row) {
  const params = objectOrNull(row?.params) || {};
  const diagnostic = objectOrNull(params.diagnostic) || {};
  return String(params.diagnostic_stage || diagnostic.stage || '');
}

function stripSecrets(value) {
  return String(value ?? '')
    .replace(/\/\/[^@/\s]+@/g, '//[redacted]@')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
}

function safeHeaders(raw = {}) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = /cookie|authorization|proxy-authorization/i.test(k) ? '[redacted]' : stripSecrets(v);
  }
  return out;
}

function bodyMarkers(text) {
  const body = String(text ?? '');
  return {
    challenge: /challenge-dialog|checkpoint\/challenge|challengeIframe|Security verification|quick security check/i.test(body),
    captcha: /captcha|recaptcha|g-recaptcha|google\.com\/recaptcha|arkose|funcaptcha/i.test(body),
    signup_form: /name="email-address"|id="email-address"|join-form-submit/i.test(body),
    logged_in_or_onboarding: /\/feed\/|\/in\/|onboarding|checkpoint\/challenge\/verify/i.test(body),
    bot_flag_true: /data-is-bot="true"/i.test(body),
    bot_flag_false: /data-is-bot="false"/i.test(body),
  };
}

function sanitizeJsonb(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\u0000/g, '\uFFFD')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonb(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeJsonb(v);
    return out;
  }
  return value;
}

function classify(records) {
  const markerRows = [
    ...records.requests.map((r) => r.body_markers).filter(Boolean),
    records.page?.markers,
  ].filter(Boolean);
  const challenged = markerRows.some((m) => m.challenge || m.captcha || m.bot_flag_true);
  const passed = markerRows.some((m) => m.logged_in_or_onboarding) && !challenged;
  if (passed) return { healthy: true, signal: 'human_home_chrome_passed' };
  if (challenged) return { healthy: false, signal: 'human_home_chrome_challenge' };
  return { healthy: null, signal: 'human_home_chrome_captured' };
}

async function patchRow(id, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch row ${id} HTTP ${res.status}: ${await res.text()}`);
}

async function insertCaptureSummary(rowId, capture, bytes) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_log_capture?on_conflict=log_id`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ log_id: rowId, capture, bytes }),
  });
  if (!res.ok) throw new Error(`capture upsert HTTP ${res.status}: ${await res.text()}`);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function fetchRequestRow() {
  const rowId = argValue('--row-id', process.env.ACTION_LOG_ID || '');
  if (rowId) {
    const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/account_action_logs?select=id,action,platform,status,params,result&id=eq.${encodeURIComponent(rowId)}&limit=1`);
    if (!rows[0]) throw new Error(`diagnostic row not found: ${rowId}`);
    return rows[0];
  }
  const action = argValue('--action', process.env.ACTION || 'linkedin_register');
  const stage = argValue('--stage', process.env.DIAGNOSTIC_STAGE || 'human_home_chrome');
  const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/account_action_logs?select=id,action,platform,status,params,result&action=eq.${encodeURIComponent(action)}&status=eq.pending_review&order=started_at.desc&limit=100`);
  const row = rows.find((r) => diagnosticStage(r) === stage);
  if (!row) throw new Error(`no pending diagnostic request for action=${action} stage=${stage}`);
  return row;
}

async function waitForOperator(page, records) {
  const holdMs = Number(process.env.DIAGNOSTIC_HOLD_MS || 0);
  const doneUrl = process.env.DIAGNOSTIC_DONE_URL_RE || '';
  const started = Date.now();
  process.stdin.setEncoding('utf8');
  let stdinDone = false;
  process.stdin.on('data', (chunk) => {
    const c = String(chunk).trim().toLowerCase();
    if (c === 'q' || c === 'done') stdinDone = true;
  });
  while (!stdinDone) {
    if (page.isClosed()) break;
    const url = page.url();
    if (doneUrl && new RegExp(doneUrl).test(url)) break;
    if (holdMs > 0 && Date.now() - started > holdMs) break;
    await page.waitForTimeout(1000).catch(() => {});
  }
  records.operator_finished_at = new Date().toISOString();
}

async function runHumanHomeChrome(row) {
  const chromeBin = process.env.DIAGNOSTIC_CHROME_BIN || process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(chromeBin)) throw new Error(`Chrome binary missing: ${chromeBin}`);
  if (/Chrome for Testing/i.test(chromeBin)) throw new Error(`Refusing Chrome for Testing human baseline: ${chromeBin}`);

  process.env.ACTION_LOG_ID = row.id;
  process.env.WELES_RUN_ID = row.id;
  process.env.ACTION = row.action;

  const outDir = runRecordingsDir('diagnostic', 'human_home_chrome');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'human_home_chrome_capture.json');
  const instPath = join(outDir, 'human_home_chrome.inst.json');
  const networkPath = join(outDir, 'network.ndjson');
  const targetUrl = process.env.DIAGNOSTIC_TARGET_URL || TARGET_BY_ACTION[row.action] || 'about:blank';
  const chromeVersion = execFileSync(chromeBin, ['--version'], { encoding: 'utf8' }).trim();
  const userDataDir = process.env.DIAGNOSTIC_CHROME_PROFILE_DIR || mkdtempSync(join(tmpdir(), 'weles-human-home-chrome-'));

  const records = {
    started_at: new Date().toISOString(),
    diagnostic_stage: 'human_home_chrome',
    action: row.action,
    row_id: row.id,
    browser: 'stock_google_chrome_operator_driven',
    browser_binary: chromeBin,
    browser_version: chromeVersion,
    target_url: targetUrl,
    user_data_dir: userDataDir,
    requests: [],
    console: [],
    pageerrors: [],
    page: null,
  };

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeBin,
    headless: false,
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 2,
    locale: process.env.DIAGNOSTIC_LOCALE || 'en-US',
    timezoneId: process.env.DIAGNOSTIC_TIMEZONE || 'America/New_York',
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
    args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);

    page.on('console', (msg) => records.console.push({ t: Date.now(), type: msg.type(), text: stripSecrets(msg.text()).slice(0, 1000), location: msg.location() }));
    page.on('pageerror', (err) => records.pageerrors.push({ t: Date.now(), name: err.name, message: stripSecrets(err.message).slice(0, 1000) }));
    page.on('request', (req) => {
      const url = req.url();
      if (!/linkedin|protechts|google|doubleclick|recaptcha|arkose/i.test(url)) return;
      records.requests.push({ t: Date.now(), phase: 'request', method: req.method(), url: stripSecrets(url), resource_type: req.resourceType(), headers: safeHeaders(req.headers()) });
    });
    page.on('response', async (res) => {
      const url = res.url();
      if (!/linkedin|protechts|google|doubleclick|recaptcha|arkose/i.test(url)) return;
      let body = '';
      if (/linkedin\.com|protechts|recaptcha|arkose/i.test(url)) {
        try { body = await res.text(); } catch {}
      }
      records.requests.push({
        t: Date.now(),
        phase: 'response',
        status: res.status(),
        url: stripSecrets(url),
        headers: safeHeaders(res.headers()),
        body_bytes: body.length,
        body_markers: body ? bodyMarkers(body) : undefined,
        body_prefix: stripSecrets(body).slice(0, 1500),
      });
    });

    try {
      const ipRes = await context.request.get('https://api.ipify.org', { timeout: 10_000 });
      if (ipRes.ok()) records.exit_ip = (await ipRes.text()).trim();
    } catch {}

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e) => {
      records.goto_error = String(e?.message || e).slice(0, 500);
    });
    console.log(`[diagnostic] row=${row.id.slice(0, 8)} stage=human_home_chrome opened ${targetUrl}`);
    console.log('[diagnostic] drive the stock Chrome window; type q<enter> or done<enter> here when finished');
    await waitForOperator(page, records);

    records.page = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text_sample: (document.body?.innerText || '').slice(0, 1000),
      markers: {
        challenge: /challenge-dialog|checkpoint\/challenge|challengeIframe|Security verification|quick security check/i.test(document.body?.innerText || ''),
        captcha: /captcha|recaptcha|g-recaptcha|arkose|funcaptcha/i.test(document.body?.innerText || document.documentElement.innerHTML || ''),
        signup_form: !!document.querySelector('input[name="email-address"], #join-form-submit'),
        logged_in_or_onboarding: /\/feed\/|\/in\/|onboarding|checkpoint\/challenge\/verify/i.test(location.href + ' ' + (document.body?.innerText || '')),
        bot_flag_true: /data-is-bot="true"/i.test(document.documentElement.innerHTML || ''),
        bot_flag_false: /data-is-bot="false"/i.test(document.documentElement.innerHTML || ''),
      },
    })).catch((e) => ({ error: String(e?.message || e).slice(0, 500) }));
  } finally {
    records.completed_at = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(records, null, 2));
    writeFileSync(instPath, JSON.stringify({ diagnostic: records }, null, 2));
    writeFileSync(networkPath, records.requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await context.close().catch(() => {});
  }

  const signal = classify(records);
  const capture = {
    'diagnostic/human_home_chrome/human_home_chrome.inst.json': sanitizeJsonb({ diagnostic: records }),
    'diagnostic/human_home_chrome/network.ndjson': sanitizeJsonb(records.requests),
  };
  await insertCaptureSummary(row.id, capture, Buffer.byteLength(JSON.stringify(capture)));
  const artifacts = await uploadArtifacts(row.action, row.id, new Date(records.started_at), { force: true }).catch(() => null);
  await writeNetworkCapture(row.id).catch(() => {});
  const status = signal.healthy === true ? 'completed' : signal.healthy === false ? 'failed' : 'pending_review';
  return {
    status,
    result: {
      versions: captureVersions('scripts/diag/run_diagnostic_request.mjs'),
      session: {
        provider: 'home_chrome',
        browser: records.browser,
        browser_binary: records.browser_binary,
        browser_version: records.browser_version,
        exit_ip: records.exit_ip || null,
        target_url: records.target_url,
        user_data_dir: records.user_data_dir,
      },
      ban_signal: {
        ...signal,
        details: {
          diagnostic_stage: 'human_home_chrome',
          final_url: records.page?.url || null,
          page_title: records.page?.title || null,
          output_json: outPath,
          request_events: records.requests.length,
        },
      },
      artifacts,
    },
  };
}

function existingCapturePath(row) {
  const result = objectOrNull(row?.result) || {};
  const signal = objectOrNull(result.ban_signal) || {};
  const details = objectOrNull(signal.details) || {};
  if (typeof details.output_json === 'string' && existsSync(details.output_json)) return details.output_json;
  return join(process.cwd(), 'recordings', row.id, 'diagnostic', 'human_home_chrome', 'human_home_chrome_capture.json');
}

async function backfillHumanHomeChrome(row) {
  const outPath = existingCapturePath(row);
  if (!existsSync(outPath)) throw new Error(`capture json missing: ${outPath}`);
  const records = JSON.parse(readFileSync(outPath, 'utf8'));
  const outDir = join(process.cwd(), 'recordings', row.id, 'diagnostic', 'human_home_chrome');
  mkdirSync(outDir, { recursive: true });
  const instPath = join(outDir, 'human_home_chrome.inst.json');
  const networkPath = join(outDir, 'network.ndjson');
  writeFileSync(instPath, JSON.stringify({ diagnostic: records }, null, 2));
  writeFileSync(networkPath, (Array.isArray(records.requests) ? records.requests : []).map((r) => JSON.stringify(r)).join('\n') + '\n');
  const capture = {
    'diagnostic/human_home_chrome/human_home_chrome.inst.json': sanitizeJsonb({ diagnostic: records }),
    'diagnostic/human_home_chrome/network.ndjson': sanitizeJsonb(Array.isArray(records.requests) ? records.requests : []),
  };
  await insertCaptureSummary(row.id, capture, Buffer.byteLength(JSON.stringify(capture)));
  const artifacts = await uploadArtifacts(row.action, row.id, new Date(records.started_at || Date.now()), { force: true }).catch(() => null);
  const result = objectOrNull(row.result) || {};
  await patchRow(row.id, { result: { ...result, artifacts: artifacts || result.artifacts || null } });
  return {
    ok: true,
    row_id: row.id,
    backfilled: true,
    network_events: Array.isArray(records.requests) ? records.requests.length : 0,
    artifacts,
  };
}

if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing');

const row = await fetchRequestRow();
const stage = diagnosticStage(row);
if (stage !== 'human_home_chrome') {
  throw new Error(`stage ${stage} is not supported by this executor yet`);
}

if (flag('--dry-run')) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    row_id: row.id,
    action: row.action,
    stage,
    status: row.status,
    would_claim_as: CLAIM_ID,
  }, null, 2));
  process.exit(0);
}

if (flag('--backfill-row')) {
  const result = await backfillHumanHomeChrome(row);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

await patchRow(row.id, {
  status: 'running',
  claimed_by: CLAIM_ID,
  claimed_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
});

try {
  const { status, result } = await runHumanHomeChrome(row);
  await patchRow(row.id, { status, completed_at: new Date().toISOString(), result, error: null });
  console.log(JSON.stringify({ ok: true, row_id: row.id, stage, status, signal: result.ban_signal.signal }, null, 2));
} catch (e) {
  await patchRow(row.id, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error: e instanceof Error ? e.message : String(e),
    result: {
      ban_signal: {
        healthy: false,
        signal: 'diagnostic_executor_failed',
        details: { stage, error: e instanceof Error ? e.message : String(e) },
      },
    },
  }).catch(() => {});
  throw e;
}
