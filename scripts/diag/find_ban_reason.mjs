#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_LOCAL = join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json');

function usage() {
  console.log(`Usage:
  node scripts/diag/find_ban_reason.mjs [ban_signal.json | artifact-url | console-run-url | recordings-dir]

Examples:
  node scripts/diag/find_ban_reason.mjs
  node scripts/diag/find_ban_reason.mjs recordings/linkedin_register/ban_signal.json
  node scripts/diag/find_ban_reason.mjs https://console.wisent.com/weles/<run-id>
  node scripts/diag/find_ban_reason.mjs https://.../ban_signal.json`);
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function jsonFromText(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse JSON from ${label}: ${e.message}`);
  }
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractBalancedObject(text, start) {
  if (start < 0 || text[start] !== '{') return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

function inlineBanSignalFromHtml(html, label) {
  const decoded = decodeHtml(html);
  const key = '"ban_signal"';
  const keyIndex = decoded.lastIndexOf(key);
  if (keyIndex < 0) return null;
  const brace = decoded.indexOf('{', keyIndex + key.length);
  const objectText = extractBalancedObject(decoded, brace);
  if (!objectText) return null;
  return jsonFromText(objectText, `${label} inline ban_signal`);
}

async function readInput(input) {
  if (!input) input = DEFAULT_LOCAL;

  if (isUrl(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText}: ${input}`);
    const text = await res.text();
    if (/\/ban_signal\.json(?:\?|$)/.test(input)) {
      return { source: input, data: jsonFromText(text, input) };
    }
    const artifactUrl = text.match(/https:\/\/[^"'<>\s]+\/ban_signal\.json/g)?.[0];
    if (!artifactUrl) {
      if (/^\s*\{/.test(text)) return { source: input, data: jsonFromText(text, input) };
      const inline = inlineBanSignalFromHtml(text, input);
      if (inline) return { source: `${input}#inline-ban-signal`, data: inline };
      throw new Error(`no ban_signal.json URL found in ${input}`);
    }
    try {
      return await readInput(artifactUrl);
    } catch (e) {
      const inline = inlineBanSignalFromHtml(text, input);
      if (inline) return { source: `${input}#inline-ban-signal`, data: inline };
      throw e;
    }
  }

  let path = input;
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'ban_signal.json');
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  return { source: path, data: jsonFromText(readFileSync(path, 'utf8'), path) };
}

function signalObject(data) {
  if (data?.ban_signal && typeof data.ban_signal === 'object') return data.ban_signal;
  return data;
}

function detailsObject(sig) {
  return sig?.details && typeof sig.details === 'object' ? sig.details : {};
}

function stageEvents(details) {
  return Array.isArray(details.stage_events) ? details.stage_events.filter((x) => x && typeof x === 'object') : [];
}

function rawReasons(details) {
  return Array.isArray(details.failure_reasons) ? details.failure_reasons.filter((x) => x && typeof x === 'object') : [];
}

function addReason(out, code, message = '') {
  if (out.some((r) => r.code === code)) return;
  out.push({ code, message: String(message ?? '').slice(0, 300) });
}

function deriveReasons(sig, details) {
  const out = rawReasons(details).map((r) => ({
    code: typeof r.code === 'string' && r.code ? r.code : 'unclassified',
    message: typeof r.message === 'string' ? r.message : '',
  }));
  if (out.length) return out;

  const signal = String(sig?.signal ?? '');
  const error = String(details.error ?? '');
  const finalUrl = String(details.final_url ?? '');
  const haystack = `${signal}\n${error}\n${finalUrl}`;

  if (/Executable doesn't exist|browserType\.launch|playwright install|missing.*browser|Nightly\.app/i.test(haystack)) {
    addReason(out, 'browser_launch_failed', error || signal);
  }
  if (/PROXY_NOT_DEDICATED_ISP/i.test(haystack)) addReason(out, 'proxy_not_dedicated_isp', error || signal);
  if (/PROXY_DRIFT_CHECK_FAILED/i.test(haystack)) addReason(out, 'proxy_drift_probe_failed', error || signal);
  if (/PROXY_DRIFT:/i.test(haystack)) addReason(out, 'proxy_exit_ip_drift', error || signal);
  if (/captcha|challenge|checkpoint|DETECTION_TRIGGERED/i.test(haystack)) addReason(out, 'linkedin_challenge_or_checkpoint', error || signal || finalUrl);
  if (/signup_form_unavailable/i.test(haystack)) addReason(out, 'signup_form_unavailable', error || signal);
  if (/signup_did_not_complete/i.test(haystack) || /^https?:\/\/www\.linkedin\.com\/signup\/?$/i.test(finalUrl)) addReason(out, 'signup_did_not_complete', error || finalUrl);
  if (/signup_verification_incomplete/i.test(haystack)) addReason(out, 'signup_verification_incomplete', error || signal);
  if (/signup_did_not_authenticate/i.test(haystack)) addReason(out, 'missing_authenticated_session', error || signal);
  if (/ACCOUNT_PERSIST_FAILED/i.test(haystack)) addReason(out, 'account_persist_failed', error || signal);

  if (!out.length && signal && signal !== 'healthy') addReason(out, signal, error || finalUrl);
  if (!out.length) addReason(out, 'no_failure_reason', '');
  return out;
}

function summarize(data, source) {
  const sig = signalObject(data);
  const details = detailsObject(sig);
  const stages = stageEvents(details);
  const lastStage = stages.length ? stages[stages.length - 1] : null;
  const diagnostics = details.diagnostics && typeof details.diagnostics === 'object' ? details.diagnostics : {};
  const proxy = diagnostics.proxy && typeof diagnostics.proxy === 'object' ? diagnostics.proxy : {};
  const reasons = deriveReasons(sig, details);

  return {
    source,
    action: sig.action ?? '',
    signal: sig.signal ?? '',
    healthy: Boolean(sig.healthy),
    primary_reason: reasons[0]?.code ?? '',
    reasons,
    last_stage: lastStage?.stage ?? '',
    final_url: details.final_url ?? '',
    error: details.error ?? '',
    proxy: {
      requested: proxy.requested ?? '',
      provider: proxy.provider ?? '',
      proxy_type: proxy.proxy_type ?? '',
      expected_exit_ip: proxy.expected_exit_ip ?? details.expected_exit_ip ?? '',
      actual_exit_ip: proxy.actual_exit_ip ?? '',
    },
    stage_count: stages.length,
  };
}

const arg = process.argv.find((x, i) => i > 1 && x !== '--json' && x !== '-h' && x !== '--help');
const json = process.argv.includes('--json');
if (process.argv.includes('-h') || process.argv.includes('--help')) {
  usage();
  process.exit(0);
}

try {
  const { source, data } = await readInput(arg);
  const summary = summarize(data, source);
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`source: ${summary.source}`);
    console.log(`action: ${summary.action || '—'}`);
    console.log(`signal: ${summary.signal || '—'} healthy=${summary.healthy}`);
    console.log(`primary_reason: ${summary.primary_reason || '—'}`);
    for (const reason of summary.reasons) {
      console.log(`- ${reason.code}${reason.message ? `: ${reason.message}` : ''}`);
    }
    console.log(`last_stage: ${summary.last_stage || '—'} (${summary.stage_count} recorded stages)`);
    console.log(`final_url: ${summary.final_url || '—'}`);
    console.log(`proxy: requested=${summary.proxy.requested || '—'} provider=${summary.proxy.provider || '—'} type=${summary.proxy.proxy_type || '—'} expected_ip=${summary.proxy.expected_exit_ip || '—'} actual_ip=${summary.proxy.actual_exit_ip || '—'}`);
    if (summary.error) console.log(`error: ${summary.error.slice(0, 500)}`);
  }
} catch (e) {
  console.error(`find_ban_reason: ${e.message}`);
  process.exit(1);
}
