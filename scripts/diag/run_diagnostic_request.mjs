#!/usr/bin/env node
// Executes one console-created diagnostic ladder request.
//
// Scope: capture infrastructure only. For human_home_chrome this opens stock
// Chrome and records the operator-driven session; it does not fill or submit
// registration forms. The resulting artifacts/results are written back to the
// same account_action_logs row that console created.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
loadDotEnv('../backends/wisent-enterprise/.env.local.production');

const { runRecordingsDir } = await import('../../dist/session/run-recordings.js');
const { WSession } = await import('../../dist/session/wsession.js');
const { captureVersions } = await import('../../dist/diagnostics/versions.js');
const { uploadArtifacts } = await import('../../dist/worker/upload-artifacts.js');
const { writeNetworkCapture } = await import('../../dist/diagnostics/run-import.js');

const CONTENT_PLATFORM_SUPABASE_URL = process.env.CONTENT_PLATFORM_SUPABASE_URL || 'https://yqizdfkfnmhddfemdxtq.supabase.co';
const SUPABASE_URL = process.env.CONTENT_PLATFORM_SUPABASE_SERVICE_ROLE_KEY
  ? CONTENT_PLATFORM_SUPABASE_URL
  : (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '');
const SUPABASE_KEY = process.env.CONTENT_PLATFORM_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
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

function banSignal(row) {
  return objectOrNull(row?.result?.ban_signal);
}

function isLaunchableDiagnosticRequest(row) {
  if (row?.status === 'queued' || row?.status === 'running') return true;
  if (row?.status !== 'pending_review') return false;
  if (String(banSignal(row)?.signal || '') === 'diagnostic_requested') return true;
  const params = objectOrNull(row?.params) || {};
  const diagnostic = objectOrNull(params.diagnostic) || {};
  return String(diagnostic.status || '') === 'requested' && !row?.completed_at;
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
    // structural phone signal: an actual <input type=tel> or LinkedIn's phone step
    phone_input: /<input[^>]+type=["']?tel|isConfirmingPhone|enter your phone number|registrationPhoneChallenge/i.test(body),
    // email-PIN confirm step (passable). LinkedIn RSC payload carries isConfirmingPin.
    email_verification: /isConfirmingPin|confirm your email|enter the code [^.]{0,40}(sent|email)|emailPinChallenge/i.test(body),
    captcha_gauntlet: /Security verification|quick security check|captcha challenge|arkose|funcaptcha/i.test(body),
    signup_form: /name="email-address"|id="email-address"|join-form-submit/i.test(body),
    logged_in_or_onboarding: /\/feed\/|\/in\/|onboarding|checkpoint\/challenge\/verify/i.test(body),
    bot_flag_true: /data-is-bot="true"/i.test(body),
    bot_flag_false: /data-is-bot="false"/i.test(body),
  };
}

function challengeEvidence(records) {
  const requests = Array.isArray(records.requests) ? records.requests : [];
  const pageMarkers = records.page?.markers || records.last_page_snapshot?.markers || {};
  const challengeRows = requests.filter((r) => {
    const url = String(r.url || '');
    const markers = r.body_markers || {};
    return /checkpoint\/challenge|challengeIframe|createAccount/i.test(url) || markers.challenge || markers.phone_input || markers.email_verification || markers.captcha_gauntlet;
  });
  const challengeText = challengeRows.map((r) => `${r.url || ''}\n${r.body_prefix || ''}`).join('\n');
  let challengeUrl = '';
  const createAccount = challengeRows.find((r) => /createAccount/i.test(String(r.url || '')) && typeof r.body_prefix === 'string');
  if (createAccount?.body_prefix) {
    try {
      const body = JSON.parse(createAccount.body_prefix);
      if (typeof body.challengeUrl === 'string') challengeUrl = body.challengeUrl;
    } catch {}
  }
  if (!challengeUrl) {
    const iframe = challengeRows.find((r) => /checkpoint\/challengeIframe/i.test(String(r.url || '')));
    challengeUrl = String(iframe?.url || '');
  }
  const titleMatch = challengeText.match(/<title>\s*([^<]+?)\s*<\/title>/i);
  const challengeTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  // Scan the FULL textual evidence the capture holds — the rendered page text AND
  // every non-asset response body (full body, or old body_prefix) — not just the
  // precomputed markers + the filtered challengeRows. The proof of an email-code
  // step ("Confirm your email", isConfirmingPin) or a phone input can live in the
  // page text or a non-"challenge" response (e.g. an RSC server-request), so
  // looking only at markers/challengeRows missed evidence that was right there.
  // Exclude script/style/image and vendor anti-bot JS (reCAPTCHA/arkose) so their
  // source text can't false-positive. Works on old captures too (no markers needed).
  const isAsset = (r) => /^(script|stylesheet|image|font|media|other)$/i.test(r.resource_type || '') || /recaptcha|arkose|gstatic|googleapis|google-analytics|doubleclick/i.test(String(r.url || ''));
  const pageText = [records.page, records.last_page_snapshot].filter(Boolean).map((p) => p?.text_sample || '').join('\n');
  const bodyText = requests.filter((r) => !isAsset(r)).map((r) => r.body || r.body_prefix || '').join('\n');
  const evidence = `${pageText}\n${challengeText}\n${bodyText}`;
  // Phone verification ONLY when LinkedIn actually rendered a phone-number input
  // somewhere in the capture — the capture is ground truth for every field shown,
  // so no phone input => it cannot be phone verification (the #1 false positive).
  const phoneInput = Boolean(pageMarkers.phone_input) || requests.some((r) => r.body_markers?.phone_input) || /isConfirmingPhone|enter your phone number|<input[^>]+type=["']?tel/i.test(evidence);
  const emailVerification = Boolean(pageMarkers.email_verification) || requests.some((r) => r.body_markers?.email_verification) || /isConfirmingPin|confirm your email|enter the code [^.]{0,40}(we'?(ve| have)? sent|sent to)/i.test(evidence);
  const captchaGauntlet = Boolean(pageMarkers.captcha_gauntlet) || /Security verification|quick security check|captcha challenge|arkose|funcaptcha|checkpoint\/captcha/i.test(challengeText);
  const challenge = challengeRows.some((r) => r.body_markers?.challenge) || /checkpoint\/challenge|challengeIframe/i.test(challengeText);
  if (phoneInput) return { kind: 'phone_verification', url: challengeUrl || null, title: challengeTitle || 'Phone Verification' };
  if (emailVerification) return { kind: 'email_verification', url: challengeUrl || null, title: challengeTitle || 'Confirm your email' };
  if (captchaGauntlet) return { kind: 'captcha_gauntlet', url: challengeUrl || null, title: challengeTitle || null };
  if (challenge) return { kind: 'challenge', url: challengeUrl || null, title: challengeTitle || null };
  return { kind: 'none', url: null, title: null };
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

function stageSignal(stage, suffix) {
  return `${stage || 'human_home_chrome'}_${suffix}`;
}

function classify(records, stage = records?.diagnostic_stage || 'human_home_chrome') {
  const inputEvents = Array.isArray(records.input_events) ? records.input_events : [];
  const challenge = challengeEvidence(records);
  if (inputEvents.length === 0 && !['captcha_gauntlet', 'phone_verification', 'email_verification'].includes(challenge.kind)) {
    return { healthy: null, signal: stageSignal(stage, 'no_operator_input') };
  }
  const finalMarkers = records.page?.markers || records.last_page_snapshot?.markers || {};
  const authenticated = records.auth?.has_li_at === true || finalMarkers.logged_in_or_onboarding === true;
  if (authenticated && challenge.kind !== 'captcha_gauntlet') {
    return { healthy: true, signal: stageSignal(stage, 'passed'), challenge };
  }
  // Email-code verification is LinkedIn's normal new-account gate, not a block — a
  // passable outcome. (phone_verification only fires when a real phone input was
  // rendered; see challengeEvidence.)
  if (challenge.kind === 'email_verification') {
    return { healthy: true, signal: stageSignal(stage, 'email_verification'), challenge };
  }
  const markerRows = [
    ...records.requests.map((r) => r.body_markers).filter(Boolean),
    records.page?.markers,
  ].filter(Boolean);
  const challenged = (challenge.kind !== 'none' && challenge.kind !== 'email_verification') || markerRows.some((m) => m.challenge || m.captcha_gauntlet || m.bot_flag_true);
  const passed = markerRows.some((m) => m.logged_in_or_onboarding) && !challenged;
  if (passed) return { healthy: true, signal: stageSignal(stage, 'passed') };
  if (challenge.kind === 'phone_verification') return { healthy: null, signal: stageSignal(stage, 'phone_verification'), challenge };
  if (challenge.kind === 'captcha_gauntlet') return { healthy: false, signal: stageSignal(stage, 'captcha_gauntlet'), challenge };
  if (challenged) return { healthy: false, signal: stageSignal(stage, 'challenge'), challenge };
  return { healthy: null, signal: stageSignal(stage, 'captured') };
}

function inputEventScript() {
  return `(() => {
    if (window.__welesDiagnosticInputInstalled) return;
    window.__welesDiagnosticInputInstalled = true;
    const emit = (type, e) => {
      try {
        const t = e.target || {};
        window.__welesDiagnosticInputEvent({
          t: Date.now(),
          type,
          trusted: e.isTrusted === true,
          x: typeof e.clientX === 'number' ? e.clientX : null,
          y: typeof e.clientY === 'number' ? e.clientY : null,
          key: typeof e.key === 'string' ? e.key : null,
          code: typeof e.code === 'string' ? e.code : null,
          target: {
            tag: typeof t.tagName === 'string' ? t.tagName.toLowerCase() : '',
            id: typeof t.id === 'string' ? t.id.slice(0, 80) : '',
            name: typeof t.name === 'string' ? t.name.slice(0, 80) : '',
            type: typeof t.type === 'string' ? t.type.slice(0, 40) : '',
          },
        });
      } catch {}
    };
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'input', 'change', 'submit']) {
      window.addEventListener(type, (e) => emit(type, e), { capture: true, passive: true });
    }
  })()`;
}

async function snapshotPage(page) {
  return await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text_sample: (document.body?.innerText || '').slice(0, 1000),
    markers: {
      challenge: /challenge-dialog|checkpoint\/challenge|challengeIframe|Security verification|quick security check/i.test(document.body?.innerText || ''),
      captcha: /captcha|recaptcha|g-recaptcha|arkose|funcaptcha/i.test(document.body?.innerText || document.documentElement.innerHTML || ''),
      // STRUCTURAL ground truth: does LinkedIn actually render a phone-number
      // input? If not, the run CANNOT be phone verification. Replaces the old
      // keyword marker that fired on the email-code step's "verification code".
      phone_input: !!document.querySelector('input[type="tel" i], input[autocomplete*="tel" i], input[name*="phone" i], input[id*="phone" i]'),
      // Email-PIN confirm step (passable normal flow): LinkedIn's real copy
      // ("Confirm your email" / "the code … we've sent to …") AND no phone input.
      email_verification: /confirm your email|enter the code [^.]{0,40}(we'?(ve| have)? sent|sent to)|we'?(ve| have)? (just )?(sent|emailed) [^.]{0,25}code/i.test(document.title + ' ' + (document.body?.innerText || '')) && !document.querySelector('input[type="tel" i], input[autocomplete*="tel" i], input[name*="phone" i]'),
      captcha_gauntlet: /Security verification|quick security check|captcha challenge|arkose|funcaptcha/i.test(document.body?.innerText || document.documentElement.innerHTML || ''),
      signup_form: !!document.querySelector('input[name="email-address"], #join-form-submit'),
      logged_in_or_onboarding: /\/feed\/|\/in\/|onboarding|checkpoint\/challenge\/verify/i.test(location.href + ' ' + (document.body?.innerText || '')),
      bot_flag_true: /data-is-bot="true"/i.test(document.documentElement.innerHTML || ''),
      bot_flag_false: /data-is-bot="false"/i.test(document.documentElement.innerHTML || ''),
    },
  }));
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

async function fetchExitIp(requestClient, label = 'browser_context') {
  const endpoints = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://ipinfo.io/ip',
  ];
  const errors = [];
  for (const url of endpoints) {
    try {
      const res = await requestClient.get(url, { timeout: 10_000 });
      if (!res.ok()) {
        errors.push(`${url}:HTTP_${res.status()}`);
        continue;
      }
      const text = (await res.text()).trim();
      if (/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,}$/i.test(text)) {
        return { ip: text, source: `${label}:${url}`, errors };
      }
      errors.push(`${url}:bad_body`);
    } catch (e) {
      errors.push(`${url}:${e instanceof Error ? e.message : String(e)}`.slice(0, 240));
    }
  }
  return { ip: null, source: null, errors };
}

async function fetchCaptureRow(logId) {
  const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/account_action_log_capture?select=log_id,created_at,bytes,capture&log_id=eq.${encodeURIComponent(logId)}&limit=1`);
  if (!rows[0]) throw new Error(`capture row missing: ${logId}`);
  return rows[0];
}

async function fetchRowsForAction(action, limit = 500) {
  return await fetchJson(`${SUPABASE_URL}/rest/v1/account_action_logs?select=id,action,platform,status,started_at,completed_at,params,result&action=eq.${encodeURIComponent(action)}&order=started_at.desc&limit=${limit}`);
}

function signalText(row) {
  return String(banSignal(row)?.signal || '').toLowerCase();
}

function isDiagnosticPass(row) {
  const sig = banSignal(row) || {};
  const signal = signalText(row);
  return row?.status === 'completed'
    || sig.healthy === true
    || /passed|email_verification|keeper_completed|healthy/.test(signal);
}

function isDiagnosticFail(row) {
  const sig = banSignal(row) || {};
  const signal = signalText(row);
  if (/diagnostic_executor_failed|host_crash_incomplete/.test(signal)) return false;
  return row?.status === 'failed'
    || sig.healthy === false
    || /captcha_gauntlet|challenge/.test(signal);
}

function captureFiles(captureRow) {
  return objectOrNull(captureRow?.capture) || {};
}

function firstObject(files, pattern) {
  for (const [key, value] of Object.entries(files)) {
    if (pattern.test(key) && objectOrNull(value)) return value;
  }
  return null;
}

function diagnosticRecord(files, stage) {
  const inst = firstObject(files, new RegExp(`${stage}\\.inst\\.json$`));
  if (objectOrNull(inst?.diagnostic)) return inst.diagnostic;
  const direct = firstObject(files, new RegExp(`${stage}_capture\\.json$`));
  if (direct) return direct;
  for (const value of Object.values(files)) {
    const obj = objectOrNull(value);
    if (obj && String(obj.diagnostic_stage || '') === stage) return obj;
    if (objectOrNull(obj?.diagnostic) && String(obj.diagnostic.diagnostic_stage || '') === stage) return obj.diagnostic;
  }
  return {};
}

function allNetwork(files) {
  const entry = Object.entries(files).find(([name]) => /network\.ndjson$/.test(name));
  return Array.isArray(entry?.[1]) ? entry[1] : [];
}

const FINGERPRINT_DIFF_KEY_RE = /linkedin\.com\/signup|createAccount|verifyPassword|checkpoint|challenge|captcha|recaptcha|li\.protechts|gsi\/button/i;

function requestKey(req) {
  let path = String(req?.url || '');
  try {
    const url = new URL(path);
    path = `${url.host}${url.pathname}`;
  } catch {}
  return `${req?.method || ''} ${path}`.trim();
}

function keyRequests(reqs) {
  return reqs
    .filter((req) => FINGERPRINT_DIFF_KEY_RE.test(String(req?.url || '')) || FINGERPRINT_DIFF_KEY_RE.test(String(req?.body_prefix || req?.body || '')))
    .map((req) => ({
      key: requestKey(req),
      status: req?.status ?? null,
      resource_type: req?.resource_type || req?.resourceType || null,
      markers: req?.body_markers || null,
    }));
}

function uniqueKeys(rows) {
  return [...new Set(rows.map((row) => `${row.key} -> ${row.status ?? '?'}`))].sort();
}

function countMarkers(reqs) {
  const counts = {};
  for (const req of reqs) {
    const markers = objectOrNull(req?.body_markers) || {};
    for (const [key, value] of Object.entries(markers)) {
      if (value === true) counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function existingJson(path) {
  if (typeof path !== 'string' || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function compactPage(page) {
  const obj = objectOrNull(page) || {};
  return {
    url: obj.url || null,
    title: obj.title || null,
    markers: objectOrNull(obj.markers) || null,
    text_sample: typeof obj.text_sample === 'string' ? obj.text_sample.slice(0, 500) : null,
  };
}

function exitIpFrom(row, diag) {
  const session = objectOrNull(row?.result?.session) || {};
  return session.exit_ip || diag?.exit_ip || diag?.proxy_config?.exit_ip || null;
}

function buildFingerprintDiffReport(homeRow, welesRow, homeCaptureRow, welesCaptureRow) {
  const homeFiles = captureFiles(homeCaptureRow);
  const welesFiles = captureFiles(welesCaptureRow);
  const homeDiag = diagnosticRecord(homeFiles, 'human_home_chrome');
  const welesDiag = diagnosticRecord(welesFiles, 'human_weles_same_ip');
  const welesInst = existingJson(welesDiag?.source_inst_json);
  const homeNet = allNetwork(homeFiles);
  const welesNet = allNetwork(welesFiles);
  const homeKeyRows = keyRequests(homeNet);
  const welesKeyRows = keyRequests(welesNet);
  const homeKeys = new Set(uniqueKeys(homeKeyRows));
  const welesKeys = new Set(uniqueKeys(welesKeyRows));
  const onlyHome = [...homeKeys].filter((key) => !welesKeys.has(key));
  const onlyWeles = [...welesKeys].filter((key) => !homeKeys.has(key));
  const homeExitIp = exitIpFrom(homeRow, homeDiag);
  const welesExitIp = exitIpFrom(welesRow, welesDiag);

  return {
    generated_at: new Date().toISOString(),
    action: homeRow.action,
    source_rows: {
      home_chrome: homeRow.id,
      weles_same_ip: welesRow.id,
    },
    axis_control: {
      fixed_by_ladder: ['trajectory', 'identity_class', 'ip'],
      variable_axis: 'browser_fingerprint_stack',
      same_exit_ip_observed: homeExitIp && welesExitIp ? homeExitIp === welesExitIp : null,
      home_exit_ip: homeExitIp,
      weles_exit_ip: welesExitIp,
    },
    home: {
      id: homeRow.id,
      status: homeRow.status,
      signal: banSignal(homeRow)?.signal || null,
      browser: homeDiag?.browser || homeRow.result?.session?.browser || null,
      browser_version: homeDiag?.browser_version || homeRow.result?.session?.browser_version || null,
      auth: homeDiag?.auth || null,
      page: compactPage(homeDiag?.page || homeDiag?.last_page_snapshot),
      request_count: homeNet.length,
      marker_counts: countMarkers(homeNet),
    },
    weles: {
      id: welesRow.id,
      status: welesRow.status,
      signal: banSignal(welesRow)?.signal || null,
      browser: welesDiag?.browser || welesRow.result?.session?.browser || null,
      source_inst_json: welesDiag?.source_inst_json || welesRow.result?.session?.source_inst_json || null,
      persona: welesInst?.persona || welesDiag?.persona || welesRow.result?.session?.persona || null,
      browser_provenance: welesInst?.browser_provenance || null,
      auth: welesDiag?.auth || null,
      page: compactPage(welesDiag?.page || welesDiag?.last_page_snapshot),
      request_count: welesNet.length,
      marker_counts: countMarkers(welesNet),
    },
    key_network_delta: {
      only_home: onlyHome,
      only_weles: onlyWeles,
      home_key_requests: homeKeyRows.slice(-80),
      weles_key_requests: welesKeyRows.slice(-80),
    },
    conclusion: {
      ladder_stage: 'human_home_chrome passed; human_weles_same_ip failed',
      nearest_axis: 'browser_fingerprint_stack',
      evidence: [
        'Diagnostic ladder fixed trajectory, identity class, and IP before this stage.',
        'The selected home Chrome source row has a passing ban_signal.',
        'The selected Weles same-IP source row has a failing ban_signal.',
        'The report preserves LinkedIn/GSI/challenge/captcha request deltas for browser-stack fixes.',
      ],
    },
  };
}

async function fetchRequestRow() {
  const rowId = argValue('--row-id', process.env.ACTION_LOG_ID || '');
  if (rowId) {
    const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/account_action_logs?select=id,action,platform,status,started_at,completed_at,params,result&id=eq.${encodeURIComponent(rowId)}&limit=1`);
    if (!rows[0]) throw new Error(`diagnostic row not found: ${rowId}`);
    if (!isLaunchableDiagnosticRequest(rows[0]) && !flag('--backfill-row')) {
      throw new Error(`diagnostic row is not a launchable request: ${rowId}`);
    }
    return rows[0];
  }
  const action = argValue('--action', process.env.ACTION || 'linkedin_register');
  const stage = argValue('--stage', process.env.DIAGNOSTIC_STAGE || 'human_home_chrome');
  const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/account_action_logs?select=id,action,platform,status,completed_at,params,result&action=eq.${encodeURIComponent(action)}&status=eq.pending_review&order=started_at.desc&limit=100`);
  const row = rows.find((r) => diagnosticStage(r) === stage && isLaunchableDiagnosticRequest(r));
  if (!row) throw new Error(`no pending launchable diagnostic request for action=${action} stage=${stage}`);
  return row;
}

async function waitForOperator(page, records) {
  const holdMs = Number(process.env.DIAGNOSTIC_HOLD_MS || 0);
  const doneUrl = process.env.DIAGNOSTIC_DONE_URL_RE || '';
  const allowStdinDone = process.env.DIAGNOSTIC_ALLOW_STDIN_DONE === '1';
  const started = Date.now();
  let stdinDone = false;
  let lastSnapshotAt = 0;
  if (allowStdinDone) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      const c = String(chunk).trim().toLowerCase();
      if (c === 'q' || c === 'done') stdinDone = true;
    });
  }
  for (;;) {
    if (stdinDone) {
      records.operator_stop_reason = 'stdin_done';
      break;
    }
    if (page.isClosed()) {
      records.operator_stop_reason = 'page_closed';
      break;
    }
    if (Date.now() - lastSnapshotAt > 2000) {
      const snap = await snapshotPage(page).catch(() => null);
      if (snap) {
        records.last_page_snapshot = snap;
        if (snap.markers?.captcha_gauntlet) {
          records.operator_stop_reason = 'captcha_gauntlet_auto_abort';
          break;
        }
      }
      lastSnapshotAt = Date.now();
    }
    const url = page.url();
    if (doneUrl && new RegExp(doneUrl).test(url)) {
      records.operator_stop_reason = 'done_url';
      break;
    }
    if (holdMs > 0 && Date.now() - started > holdMs) {
      records.operator_stop_reason = 'timeout';
      break;
    }
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
    proxy_requested: process.env.PROXY_URL || null,
    phone_tether_iface: process.env.PHONE_TETHER_IFACE || null,
    phone_tether_remote_ssh: process.env.PHONE_TETHER_REMOTE_SSH || null,
    phone_tether_remote_iface: process.env.PHONE_TETHER_REMOTE_IFACE || null,
    requests: [],
    input_events: [],
    console: [],
    pageerrors: [],
    page: null,
  };

  // Optional proxy (stock Chrome over a residential exit). Playwright handles the
  // proxy-auth challenge that bare Chrome surfaces as a blocking dialog. Parsed
  // from PROXY_URL so the same string works for keeper and stock-chrome paths.
  let proxyOpt;
  if (process.env.PROXY_URL) {
    const pu = new URL(process.env.PROXY_URL);
    proxyOpt = { server: `${pu.protocol}//${pu.host}`, username: decodeURIComponent(pu.username) || undefined, password: decodeURIComponent(pu.password) || undefined };
    console.log(`[diag] stock Chrome via proxy ${pu.protocol}//${pu.host}`);
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeBin,
    proxy: proxyOpt,
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
    await page.exposeFunction('__welesDiagnosticInputEvent', (event) => {
      records.input_events.push(event);
    }).catch(() => {});
    await page.addInitScript({ content: inputEventScript() }).catch(() => {});
    // Playwright leaks navigator.webdriver=true on stock Chrome — a flag NO real
    // human browser has, and which reCAPTCHA Enterprise harvests as an automation
    // signal (it sank the first stock run: fresh, Google-accepted tokens rejected
    // "noCAPTCHA user response code is missing or invalid"). Patch it to false so
    // "stock chrome" actually represents a human's browser. Opt out: DIAGNOSTIC_KEEP_WEBDRIVER=1.
    if (process.env.DIAGNOSTIC_KEEP_WEBDRIVER !== '1') {
      await page.addInitScript(() => {
        try { Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => false, configurable: true }); } catch { /* ignore */ }
      }).catch(() => {});
    }

    page.on('console', (msg) => records.console.push({ t: Date.now(), type: msg.type(), text: stripSecrets(msg.text()).slice(0, 1000), location: msg.location() }));
    page.on('pageerror', (err) => records.pageerrors.push({ t: Date.now(), name: err.name, message: stripSecrets(err.message).slice(0, 1000) }));
    // FULL capture (G18 parity): EVERY request/response, ALL hosts, with the
    // COMPLETE response body — utf8 for text, base64 for binary. No host filter,
    // no 1500-char truncation. Operator PII stays protected: text bodies go through
    // stripSecrets (redacts emails/proxy creds), headers through safeHeaders
    // (redacts cookie/authorization), and request POST bodies are NEVER captured —
    // that is where the operator's typed email/password live. body_markers run only
    // on document/xhr/fetch (real page/API responses), not on script/style/image,
    // so a vendor JS bundle (e.g. the reCAPTCHA source containing "phone number")
    // can't false-positive the challenge markers.
    page.on('request', (req) => {
      records.requests.push({ t: Date.now(), phase: 'request', method: req.method(), url: stripSecrets(req.url()), resource_type: req.resourceType(), headers: safeHeaders(req.headers()) });
    });
    page.on('response', async (res) => {
      let buf = null;
      try { buf = await res.body(); } catch { /* redirect / opaque / already-consumed */ }
      const resourceType = res.request().resourceType();
      const rec = {
        t: Date.now(),
        phase: 'response',
        status: res.status(),
        url: stripSecrets(res.url()),
        resource_type: resourceType,
        headers: safeHeaders(res.headers()),
        body_bytes: buf ? buf.length : 0,
      };
      if (buf && buf.length) {
        const text = buf.toString('utf8');
        const ctype = String(res.headers()['content-type'] || '').toLowerCase();
        const isText = /text|json|xml|javascript|ecmascript|html|css|urlencoded|graphql|svg/.test(ctype) || !text.includes('�');
        if (isText) {
          const redacted = stripSecrets(text);
          rec.body = redacted;                 // complete body (redacted), no truncation
          rec.body_prefix = redacted.slice(0, 1500);
          if (['document', 'xhr', 'fetch'].includes(resourceType)) rec.body_markers = bodyMarkers(text);
        } else {
          rec.body_base64 = buf.toString('base64');  // complete binary body
          rec.body_encoding = 'base64';
        }
      }
      records.requests.push(rec);
    });

    const exitIp = await fetchExitIp(context.request, 'stock_chrome_context');
    records.exit_ip = exitIp.ip;
    records.exit_ip_source = exitIp.source;
    records.exit_ip_errors = exitIp.errors;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e) => {
      records.goto_error = String(e?.message || e).slice(0, 500);
    });
    await page.evaluate(inputEventScript()).catch(() => {});
    console.log(`[diagnostic] row=${row.id.slice(0, 8)} stage=human_home_chrome opened ${targetUrl}`);
    console.log('[diagnostic] drive the stock Chrome window; close the Chrome window when finished');
    if (process.env.DIAGNOSTIC_ALLOW_STDIN_DONE === '1') {
      console.log('[diagnostic] stdin q/done is enabled for local debugging only');
    }
    await waitForOperator(page, records);

    records.page = page.isClosed()
      ? records.last_page_snapshot || { error: 'page closed before final snapshot' }
      : await snapshotPage(page).catch((e) => records.last_page_snapshot || ({ error: String(e?.message || e).slice(0, 500) }));
    const cookies = await context.cookies('https://www.linkedin.com').catch(() => []);
    const linkedinCookies = cookies.filter((c) => /linkedin\.com$/.test(String(c.domain || '')));
    records.auth = {
      linkedin_cookie_count: linkedinCookies.length,
      cookie_names: [...new Set(linkedinCookies.map((c) => c.name).filter(Boolean))].sort(),
      has_li_at: linkedinCookies.some((c) => c.name === 'li_at' && c.value),
    };
  } finally {
    records.completed_at = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(records, null, 2));
    writeFileSync(instPath, JSON.stringify({ diagnostic: records }, null, 2));
    writeFileSync(networkPath, records.requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await context.close().catch(() => {});
  }

  const signal = classify(records, 'human_home_chrome');
  const capture = {
    'diagnostic/human_home_chrome/human_home_chrome.inst.json': sanitizeJsonb({ diagnostic: records }),
    'diagnostic/human_home_chrome/network.ndjson': sanitizeJsonb(records.requests),
  };
  let captureUpsertError = null;
  await insertCaptureSummary(row.id, capture, Buffer.byteLength(JSON.stringify(capture))).catch((e) => {
    captureUpsertError = e instanceof Error ? e.message : String(e);
  });
  const artifacts = await uploadArtifacts(row.action, row.id, new Date(records.started_at), { force: true }).catch(() => null);
  const artifactLogs = Array.isArray(artifacts?.logs) ? artifacts.logs : [];
  const artifactsWithLocalDiagnostics = {
    ...(artifacts || {}),
    logs: [
      ...artifactLogs,
      `recordings://${row.id}/diagnostic/human_home_chrome/network.ndjson`,
      `recordings://${row.id}/diagnostic/human_home_chrome/human_home_chrome_capture.json`,
    ],
  };
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
        proxy_requested: records.proxy_requested,
        phone_tether_iface: records.phone_tether_iface,
        phone_tether_remote_ssh: records.phone_tether_remote_ssh,
        phone_tether_remote_iface: records.phone_tether_remote_iface,
      },
      ban_signal: {
        ...signal,
        details: {
          diagnostic_stage: 'human_home_chrome',
          final_url: records.page?.url || null,
          page_title: records.page?.title || null,
          output_json: outPath,
          proxy_requested: records.proxy_requested,
          phone_tether_iface: records.phone_tether_iface,
          phone_tether_remote_ssh: records.phone_tether_remote_ssh,
          phone_tether_remote_iface: records.phone_tether_remote_iface,
          exit_ip: records.exit_ip || null,
          exit_ip_source: records.exit_ip_source || null,
          exit_ip_errors: records.exit_ip_errors || [],
          request_events: records.requests.length,
          input_events: records.input_events.length,
          operator_stop_reason: records.operator_stop_reason || null,
          challenge_kind: signal.challenge?.kind || null,
          challenge_url: signal.challenge?.url || null,
          challenge_title: signal.challenge?.title || null,
          auth_has_li_at: records.auth?.has_li_at ?? null,
          linkedin_cookie_count: records.auth?.linkedin_cookie_count ?? null,
        },
      },
      artifacts: artifactsWithLocalDiagnostics,
    },
  };
}

function welesProxyForStage(stage) {
  const explicit = process.env.DIAGNOSTIC_PROXY || process.env.WELES_DIAGNOSTIC_PROXY || '';
  if (explicit) return explicit;
  if (stage === 'human_weles_same_ip') {
    return process.env.DIAGNOSTIC_SAME_IP_PROXY || '';
  }
  return process.env.DIAGNOSTIC_CHANGED_IP_PROXY
    || process.env.LINKEDIN_REGISTER_PROXY
    || process.env.WELES_LINKEDIN_PROXY
    || process.env.PROXY_URL
    || '';
}

async function runHumanWeles(row, stage) {
  process.env.ACTION_LOG_ID = row.id;
  process.env.WELES_RUN_ID = row.id;
  process.env.ACTION = row.action;

  const outDir = runRecordingsDir('diagnostic', stage);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${stage}_capture.json`);
  const instPath = join(outDir, `${stage}.inst.json`);
  const networkPath = join(outDir, 'network.ndjson');
  const targetUrl = process.env.DIAGNOSTIC_TARGET_URL || TARGET_BY_ACTION[row.action] || 'about:blank';
  const proxyRequest = welesProxyForStage(stage);

  const records = {
    started_at: new Date().toISOString(),
    diagnostic_stage: stage,
    action: row.action,
    row_id: row.id,
    browser: 'weles_operator_driven',
    target_url: targetUrl,
    proxy_requested: proxyRequest || null,
    phone_tether_iface: process.env.PHONE_TETHER_IFACE || null,
    phone_tether_remote_ssh: process.env.PHONE_TETHER_REMOTE_SSH || null,
    phone_tether_remote_iface: process.env.PHONE_TETHER_REMOTE_IFACE || null,
    requests: [],
    input_events: [],
    console: [],
    pageerrors: [],
    page: null,
  };

  let s = null;
  try {
    s = await WSession.start({
      label: `diagnostic_${stage}`,
      proxy: proxyRequest || undefined,
      targetHost: 'linkedin.com',
      browser: 'chromium',
      headless: false,
      record: true,
      pageDiagnostics: false,
    });
    const page = s.page;
    page.setDefaultTimeout?.(30_000);
    page.setDefaultNavigationTimeout?.(45_000);

    await page.exposeFunction('__welesDiagnosticInputEvent', (event) => {
      records.input_events.push(event);
    }).catch(() => {});
    await page.addInitScript({ content: inputEventScript() }).catch(() => {});
    page.on('console', (msg) => records.console.push({ t: Date.now(), type: msg.type(), text: stripSecrets(msg.text()).slice(0, 1000), location: msg.location() }));
    page.on('pageerror', (err) => records.pageerrors.push({ t: Date.now(), name: err.name, message: stripSecrets(err.message).slice(0, 1000) }));
    page.on('request', (req) => {
      records.requests.push({ t: Date.now(), phase: 'request', method: req.method(), url: stripSecrets(req.url()), resource_type: req.resourceType(), headers: safeHeaders(req.headers()) });
    });
    page.on('response', async (res) => {
      let buf = null;
      try { buf = await res.body(); } catch { /* redirect / opaque / already-consumed */ }
      const resourceType = res.request().resourceType();
      const rec = {
        t: Date.now(),
        phase: 'response',
        status: res.status(),
        url: stripSecrets(res.url()),
        resource_type: resourceType,
        headers: safeHeaders(res.headers()),
        body_bytes: buf ? buf.length : 0,
      };
      if (buf && buf.length) {
        const text = buf.toString('utf8');
        const ctype = String(res.headers()['content-type'] || '').toLowerCase();
        const isText = /text|json|xml|javascript|ecmascript|html|css|urlencoded|graphql|svg/.test(ctype) || !text.includes('�');
        if (isText) {
          const redacted = stripSecrets(text);
          rec.body = redacted;
          rec.body_prefix = redacted.slice(0, 1500);
          if (['document', 'xhr', 'fetch'].includes(resourceType)) rec.body_markers = bodyMarkers(text);
        } else {
          rec.body_base64 = buf.toString('base64');
          rec.body_encoding = 'base64';
        }
      }
      records.requests.push(rec);
    });

    const exitIp = await fetchExitIp(s.ctx.request, 'weles_context');
    records.exit_ip = exitIp.ip;
    records.exit_ip_source = exitIp.source;
    records.exit_ip_errors = exitIp.errors;

    records.proxy_config = s.proxyConfig || null;
    records.persona = s.personaConfig || null;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e) => {
      records.goto_error = String(e?.message || e).slice(0, 500);
    });
    await page.evaluate(inputEventScript()).catch(() => {});
    console.log(`[diagnostic] row=${row.id.slice(0, 8)} stage=${stage} opened ${targetUrl}`);
    console.log('[diagnostic] drive the Weles window; close the browser window when finished');
    if (process.env.DIAGNOSTIC_ALLOW_STDIN_DONE === '1') {
      console.log('[diagnostic] stdin q/done is enabled for local debugging only');
    }
    await waitForOperator(page, records);

    records.page = page.isClosed()
      ? records.last_page_snapshot || { error: 'page closed before final snapshot' }
      : await snapshotPage(page).catch((e) => records.last_page_snapshot || ({ error: String(e?.message || e).slice(0, 500) }));
    const cookies = await s.ctx.cookies('https://www.linkedin.com').catch(() => []);
    const linkedinCookies = cookies.filter((c) => /linkedin\.com$/.test(String(c.domain || '')));
    records.auth = {
      linkedin_cookie_count: linkedinCookies.length,
      cookie_names: [...new Set(linkedinCookies.map((c) => c.name).filter(Boolean))].sort(),
      has_li_at: linkedinCookies.some((c) => c.name === 'li_at' && c.value),
    };
  } finally {
    records.completed_at = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(records, null, 2));
    writeFileSync(instPath, JSON.stringify({ diagnostic: records }, null, 2));
    writeFileSync(networkPath, records.requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (s) await s.close().catch(() => {});
  }

  const signal = classify(records, stage);
  const capture = {
    [`diagnostic/${stage}/${stage}.inst.json`]: sanitizeJsonb({ diagnostic: records }),
    [`diagnostic/${stage}/network.ndjson`]: sanitizeJsonb(records.requests),
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
        provider: 'weles',
        browser: records.browser,
        stage,
        exit_ip: records.exit_ip || null,
        target_url: records.target_url,
        proxy_requested: records.proxy_requested,
        phone_tether_iface: records.phone_tether_iface,
        phone_tether_remote_ssh: records.phone_tether_remote_ssh,
        phone_tether_remote_iface: records.phone_tether_remote_iface,
        proxy_config: records.proxy_config,
        persona: records.persona,
      },
      ban_signal: {
        ...signal,
        details: {
          diagnostic_stage: stage,
          final_url: records.page?.url || null,
          page_title: records.page?.title || null,
          output_json: outPath,
          proxy_requested: records.proxy_requested,
          phone_tether_iface: records.phone_tether_iface,
          phone_tether_remote_ssh: records.phone_tether_remote_ssh,
          phone_tether_remote_iface: records.phone_tether_remote_iface,
          exit_ip: records.exit_ip || null,
          exit_ip_source: records.exit_ip_source || null,
          exit_ip_errors: records.exit_ip_errors || [],
          request_events: records.requests.length,
          input_events: records.input_events.length,
          operator_stop_reason: records.operator_stop_reason || null,
          challenge_kind: signal.challenge?.kind || null,
          challenge_url: signal.challenge?.url || null,
          challenge_title: signal.challenge?.title || null,
          auth_has_li_at: records.auth?.has_li_at ?? null,
          linkedin_cookie_count: records.auth?.linkedin_cookie_count ?? null,
        },
      },
      artifacts,
    },
  };
}

function stripTags(text) {
  return String(text ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findLatestWelesInstPath(row, stage) {
  const dir = join(process.cwd(), 'recordings', row.id, `diagnostic_${stage}`);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.inst.json'))
    .sort();
  const name = names.at(-1);
  return name ? join(dir, name) : null;
}

function summarizeRequestsForCapture(requests) {
  const relevant = requests.filter((r) => {
    const url = String(r.url || '');
    const marker = r.body_markers || {};
    const body = String(r.body_prefix || r.body || '');
    return /linkedin\.com|recaptcha|challenge|captcha|createAccount|verifyPassword|signup/i.test(url)
      || marker.challenge || marker.captcha_gauntlet || marker.email_verification || marker.phone_input || marker.signup_form
      || /challenge-dialog|Security verification|checkpoint\/challenge|captcha/i.test(body);
  });
  return relevant.slice(-120).map((r) => ({
    t: r.t,
    phase: r.phase,
    method: r.method,
    status: r.status,
    url: r.url,
    resource_type: r.resource_type,
    body_bytes: typeof r.body === 'string' ? Buffer.byteLength(r.body) : (r.body_bytes || 0),
    body_prefix: typeof r.body_prefix === 'string' ? r.body_prefix.slice(0, 500) : '',
    body_markers: r.body_markers,
  }));
}

async function backfillHumanWeles(row, stage) {
  const instPath = findLatestWelesInstPath(row, stage);
  if (!instPath) throw new Error(`weles inst json missing for row=${row.id} stage=${stage}`);
  const inst = JSON.parse(readFileSync(instPath, 'utf8'));
  const rawRequests = Array.isArray(inst.requests) ? inst.requests : [];
  const requests = rawRequests.map((r) => {
    const resourceType = r.resource_type || r.resourceType || '';
    const body = typeof r.body === 'string' ? r.body : '';
    const rec = {
      t: r.t,
      phase: r.phase === 'res' ? 'response' : r.phase === 'req' ? 'request' : r.phase,
      method: r.method,
      status: r.status,
      url: r.url,
      resource_type: resourceType,
      headers: r.headers || {},
      body,
      body_prefix: body.slice(0, 1500),
    };
    if (body && ['document', 'xhr', 'fetch'].includes(resourceType)) rec.body_markers = bodyMarkers(body);
    return rec;
  });
  const evidenceBody = requests
    .filter((r) => typeof r.body === 'string' && /challenge-dialog|Security verification|checkpoint\/challenge|captcha|signup/i.test(r.body))
    .map((r) => r.body)
    .join('\n')
    .slice(0, 2_000_000);
  const markerSource = evidenceBody || requests.map((r) => r.body || '').join('\n').slice(0, 2_000_000);
  const title = markerSource.match(/<title>\s*([^<]+?)\s*<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || '';
  const records = {
    started_at: inst.started_at || new Date().toISOString(),
    completed_at: new Date().toISOString(),
    diagnostic_stage: stage,
    action: row.action,
    row_id: row.id,
    browser: 'weles_operator_driven',
    target_url: TARGET_BY_ACTION[row.action] || 'about:blank',
    proxy_requested: inst.proxy || null,
    requests,
    input_events: [],
    console: Array.isArray(inst.stdout) ? inst.stdout : [],
    pageerrors: Array.isArray(inst.pageerrors) ? inst.pageerrors : [],
    operator_stop_reason: 'captcha_gauntlet_auto_abort_backfill',
    page: {
      url: requests.find((r) => /checkpoint\/challengeIframe|checkpoint\/challenge\/captchaInternal/i.test(String(r.url || '')))?.url
        || requests.find((r) => /linkedin\.com\/signup/i.test(String(r.url || '')))?.url
        || 'https://www.linkedin.com/signup',
      title: title || 'Security verification',
      text_sample: stripTags(markerSource).slice(0, 1000),
      markers: bodyMarkers(markerSource),
    },
    auth: {
      linkedin_cookie_count: 0,
      cookie_names: [],
      has_li_at: false,
    },
    source_inst_json: instPath,
  };
  const outDir = runRecordingsDir('diagnostic', stage);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${stage}_capture.json`);
  const networkPath = join(outDir, 'network.ndjson');
  writeFileSync(outPath, JSON.stringify(records, null, 2));
  writeFileSync(networkPath, requests.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const signal = classify(records, stage);
  const summaryRequests = summarizeRequestsForCapture(requests);
  const captureRecords = { ...records, requests: summaryRequests };
  const capture = {
    [`diagnostic/${stage}/${stage}_capture.json`]: sanitizeJsonb(captureRecords),
    [`diagnostic/${stage}/network.ndjson`]: sanitizeJsonb(summaryRequests),
  };
  let captureUpsertError = null;
  await insertCaptureSummary(row.id, capture, Buffer.byteLength(JSON.stringify(capture))).catch((e) => {
    captureUpsertError = e instanceof Error ? e.message : String(e);
  });
  const artifacts = await uploadArtifacts(row.action, row.id, new Date(records.started_at), { force: true }).catch(() => null);
  const artifactLogs = Array.isArray(artifacts?.logs) ? artifacts.logs : [];
  const artifactsWithLocalDiagnostics = {
    ...(artifacts || {}),
    logs: [
      ...artifactLogs,
      `recordings://${row.id}/diagnostic/${stage}/network.ndjson`,
      `recordings://${row.id}/diagnostic/${stage}/${stage}_capture.json`,
    ],
  };
  await writeNetworkCapture(row.id).catch(() => {});
  const status = signal.healthy === true ? 'completed' : signal.healthy === false ? 'failed' : 'pending_review';
  await patchRow(row.id, {
    status,
    completed_at: new Date().toISOString(),
    error: signal.healthy === false ? signal.signal : null,
    result: {
      versions: captureVersions('scripts/diag/run_diagnostic_request.mjs'),
      session: {
        provider: 'weles',
        browser: records.browser,
        stage,
        exit_ip: null,
        target_url: records.target_url,
        proxy_requested: records.proxy_requested,
        source_inst_json: instPath,
      },
      ban_signal: {
        ...signal,
        details: {
          diagnostic_stage: stage,
          final_url: records.page?.url || null,
          page_title: records.page?.title || null,
          output_json: outPath,
          request_events: requests.length,
          input_events: 0,
          operator_stop_reason: records.operator_stop_reason,
          challenge_kind: signal.challenge?.kind || null,
          challenge_url: signal.challenge?.url || null,
          challenge_title: signal.challenge?.title || null,
          auth_has_li_at: false,
          linkedin_cookie_count: 0,
          backfilled_from_inst_json: instPath,
          capture_upsert_error: captureUpsertError,
        },
      },
      artifacts: artifactsWithLocalDiagnostics,
    },
  });
  return {
    ok: true,
    row_id: row.id,
    backfilled: true,
    stage,
    status,
    signal: signal.signal,
    challenge_kind: signal.challenge?.kind || null,
    capture_upsert_error: captureUpsertError,
    artifacts: artifactsWithLocalDiagnostics,
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
  const signal = classify(records, records.diagnostic_stage || 'human_home_chrome');
  const status = signal.healthy === true ? 'completed' : signal.healthy === false ? 'failed' : 'pending_review';
  await patchRow(row.id, {
    status,
    error: signal.signal === 'human_home_chrome_no_operator_input' ? 'diagnostic capture has no operator input trace' : null,
    result: {
      ...result,
      ban_signal: {
        ...signal,
        details: {
          ...(objectOrNull(objectOrNull(result.ban_signal)?.details) || {}),
          diagnostic_stage: 'human_home_chrome',
          output_json: outPath,
          exit_ip: records.exit_ip || null,
          exit_ip_source: records.exit_ip_source || null,
          exit_ip_errors: records.exit_ip_errors || [],
          request_events: Array.isArray(records.requests) ? records.requests.length : 0,
          input_events: Array.isArray(records.input_events) ? records.input_events.length : 0,
          operator_stop_reason: records.operator_stop_reason || null,
          challenge_kind: signal.challenge?.kind || null,
          challenge_url: signal.challenge?.url || null,
          challenge_title: signal.challenge?.title || null,
          auth_has_li_at: records.auth?.has_li_at ?? null,
          linkedin_cookie_count: records.auth?.linkedin_cookie_count ?? null,
        },
      },
      artifacts: artifacts || result.artifacts || null,
    },
  });
  return {
    ok: true,
    row_id: row.id,
    backfilled: true,
    network_events: Array.isArray(records.requests) ? records.requests.length : 0,
    input_events: Array.isArray(records.input_events) ? records.input_events.length : 0,
    status,
    signal: signal.signal,
    artifacts,
  };
}

async function runFingerprintDiff(row) {
  process.env.ACTION_LOG_ID = row.id;
  process.env.WELES_RUN_ID = row.id;
  process.env.ACTION = row.action;

  const rows = await fetchRowsForAction(row.action, 500);
  const latest = (stage, predicate) => rows
    .filter((candidate) => candidate.id !== row.id && diagnosticStage(candidate) === stage && predicate(candidate))
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))[0] || null;

  const homeRow = latest('human_home_chrome', isDiagnosticPass);
  const welesRow = latest('human_weles_same_ip', isDiagnosticFail);
  if (!homeRow) throw new Error(`fingerprint_diff needs a passing human_home_chrome row for action=${row.action}`);
  if (!welesRow) throw new Error(`fingerprint_diff needs a failing human_weles_same_ip row for action=${row.action}`);

  const homeCaptureRow = await fetchCaptureRow(homeRow.id);
  const welesCaptureRow = await fetchCaptureRow(welesRow.id);
  const report = buildFingerprintDiffReport(homeRow, welesRow, homeCaptureRow, welesCaptureRow);

  const outDir = runRecordingsDir('diagnostic', 'fingerprint_diff');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'fingerprint_diff.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  const capture = {
    'diagnostic/fingerprint_diff/fingerprint_diff.json': sanitizeJsonb(report),
  };
  let captureUpsertError = null;
  await insertCaptureSummary(row.id, capture, Buffer.byteLength(JSON.stringify(capture))).catch((e) => {
    captureUpsertError = e instanceof Error ? e.message : String(e);
  });

  const artifacts = await uploadArtifacts(row.action, row.id, new Date(row.started_at || Date.now()), { force: true }).catch(() => null);
  const artifactLogs = Array.isArray(artifacts?.logs) ? artifacts.logs : [];
  const artifactsWithLocalDiagnostics = {
    ...(artifacts || {}),
    logs: [
      ...artifactLogs,
      `recordings://${row.id}/diagnostic/fingerprint_diff/fingerprint_diff.json`,
    ],
  };
  const sameIp = report.axis_control.same_exit_ip_observed;
  const signal = sameIp === true
    ? { healthy: true, signal: 'fingerprint_diff_completed' }
    : sameIp === false
      ? { healthy: null, signal: 'fingerprint_diff_ip_axis_mismatch' }
      : { healthy: null, signal: 'fingerprint_diff_missing_exit_ip_evidence' };

  return {
    status: signal.healthy === true ? 'completed' : 'pending_review',
    result: {
      versions: captureVersions('scripts/diag/run_diagnostic_request.mjs'),
      session: {
        provider: 'diagnostic_ladder',
        stage: 'fingerprint_diff',
        source_rows: report.source_rows,
        same_exit_ip_observed: report.axis_control.same_exit_ip_observed,
      },
      ban_signal: {
        ...signal,
        details: {
          diagnostic_stage: 'fingerprint_diff',
          output_json: outPath,
          home_chrome_row_id: homeRow.id,
          weles_same_ip_row_id: welesRow.id,
          home_exit_ip: report.axis_control.home_exit_ip,
          weles_exit_ip: report.axis_control.weles_exit_ip,
          same_exit_ip_observed: sameIp,
          nearest_axis: 'browser_fingerprint_stack',
          capture_upsert_error: captureUpsertError,
        },
      },
      fingerprint_diff: report,
      artifacts: artifactsWithLocalDiagnostics,
    },
  };
}

const classifyCapturePath = argValue('--classify-capture', '');
if (classifyCapturePath) {
  if (!existsSync(classifyCapturePath)) throw new Error(`capture json missing: ${classifyCapturePath}`);
  const records = JSON.parse(readFileSync(classifyCapturePath, 'utf8'));
  if (flag('--simulate-auth-li-at')) {
    records.auth = {
      ...(objectOrNull(records.auth) || {}),
      has_li_at: true,
      linkedin_cookie_count: Math.max(1, Number(records.auth?.linkedin_cookie_count || 0)),
    };
    records.page = objectOrNull(records.page) || objectOrNull(records.last_page_snapshot) || {};
    records.page.markers = {
      ...(objectOrNull(records.page.markers) || {}),
      logged_in_or_onboarding: true,
    };
  }
  const signal = classify(records, records.diagnostic_stage || 'human_home_chrome');
  console.log(JSON.stringify({
    ok: true,
    classify_capture: classifyCapturePath,
    simulated_auth_li_at: flag('--simulate-auth-li-at'),
    status: signal.healthy === true ? 'completed' : signal.healthy === false ? 'failed' : 'pending_review',
    signal: signal.signal,
    healthy: signal.healthy ?? null,
    challenge_kind: signal.challenge?.kind || null,
    input_events: Array.isArray(records.input_events) ? records.input_events.length : 0,
    auth_has_li_at: records.auth?.has_li_at ?? null,
    final_logged_in_or_onboarding: records.page?.markers?.logged_in_or_onboarding ?? null,
  }, null, 2));
  process.exit(0);
}

if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing');

const row = await fetchRequestRow();
const stage = diagnosticStage(row);
const supportedStages = new Set(['human_home_chrome', 'human_weles_same_ip', 'fingerprint_diff', 'human_weles_changed_ip']);
if (!supportedStages.has(stage)) {
  throw new Error(`stage ${stage} is not supported by this executor yet`);
}

function completionErrorForSignal(signal) {
  if (/_no_operator_input$/.test(signal)) return 'diagnostic capture has no operator input trace';
  if (/_phone_verification$/.test(signal)) return 'phone verification required';
  if (signal === 'fingerprint_diff_missing_exit_ip_evidence') return 'fixed IP axis is missing exit IP evidence';
  if (signal === 'fingerprint_diff_ip_axis_mismatch') return 'fixed IP axis mismatch between source rows';
  return null;
}


if (flag('--backfill-row')) {
  if (stage === 'fingerprint_diff') {
    const { status, result } = await runFingerprintDiff(row);
    await patchRow(row.id, { status, completed_at: new Date().toISOString(), result, error: completionErrorForSignal(result.ban_signal.signal) });
    console.log(JSON.stringify({ ok: true, row_id: row.id, backfilled: true, stage, status, signal: result.ban_signal.signal }, null, 2));
    process.exit(0);
  }
  const result = stage === 'human_home_chrome'
    ? await backfillHumanHomeChrome(row)
    : await backfillHumanWeles(row, stage);
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
  const { status, result } = stage === 'fingerprint_diff'
    ? await runFingerprintDiff(row)
    : stage === 'human_home_chrome'
    ? await runHumanHomeChrome(row)
    : await runHumanWeles(row, stage);
  await patchRow(row.id, { status, completed_at: new Date().toISOString(), result, error: completionErrorForSignal(result.ban_signal.signal) });
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
