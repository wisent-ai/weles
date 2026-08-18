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

function stripTags(value) {
  return decodeHtml(String(value ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function tableRowsAfterHeading(html, heading) {
  const re = new RegExp(`<h2[^>]*>\\s*${escapeRegex(heading)}\\s*<\\/h2>`, 'i');
  const m = re.exec(html);
  if (!m) return [];
  const start = m.index + m[0].length;
  const rest = html.slice(start);
  const nextHeading = rest.search(/<h2[^>]*>/i);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const table = section.match(/<table[\s\S]*?<\/table>/i)?.[0] ?? '';
  return table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
}

function cellsFromRow(row) {
  return (row.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(stripTags);
}

function statFromHtml(html, label) {
  const re = new RegExp(`${escapeRegex(label)}:\\s*<b[^>]*>(\\d+)`, 'i');
  const m = html.match(re);
  return m ? Number(m[1]) : null;
}

function aggregateFromHtml(html, label) {
  if (!/\/weles\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(html)) return null;
  const action = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const runIds = unique([...html.matchAll(/\/weles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((m) => m[1]));
  const failureReasons = tableRowsAfterHeading(html, 'Failure reasons')
    .map(cellsFromRow)
    .filter((cells) => cells.length >= 2 && cells[0] !== 'reason')
    .map((cells) => ({
      reason: cells[0],
      runs: Number(cells[1]) || 0,
      signals: cells[2] === '—' ? '' : cells[2],
      last_stages: cells[3] === '—' ? '' : cells[3],
      examples: unique([...cells[4].matchAll(/[0-9a-f]{8}/gi)].map((m) => m[0])),
      message: cells[5] === '—' ? '' : cells[5],
    }));
  const proxyOutcomes = tableRowsAfterHeading(html, 'Exit-IP / proxy outcome analysis')
    .map(cellsFromRow)
    .filter((cells) => cells.length >= 8 && !/^exit ip/i.test(cells[0]))
    .map((cells) => ({
      exit_ip_or_proxy: cells[0],
      runs: Number(cells[1]) || 0,
      clean: Number(cells[2]) || 0,
      challenge: Number(cells[3]) || 0,
      proxy_fail: Number(cells[4]) || 0,
      other: Number(cells[5]) || 0,
      signals: cells[6] === '—' ? '' : cells[6],
      reasons: cells[7] === '—' ? '' : cells[7],
    }));
  if (!failureReasons.length && !runIds.length) return null;
  return {
    aggregate: true,
    source: label,
    action,
    stats: {
      runs: statFromHtml(html, 'runs'),
      completed: statFromHtml(html, 'completed'),
      failed: statFromHtml(html, 'failed'),
    },
    primary_reason: failureReasons[0]?.reason ?? '',
    failure_reasons: failureReasons,
    proxy_outcomes: proxyOutcomes,
    run_ids: runIds,
  };
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
      const aggregate = aggregateFromHtml(text, input);
      if (aggregate) return { source: input, data: aggregate };
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
  if (sig?.healthy === true) return [];

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
  if (data?.aggregate) return data;
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
    if (summary.aggregate) {
      console.log(`action: ${summary.action || '—'}`);
      console.log(`runs: total=${summary.stats.runs ?? '—'} completed=${summary.stats.completed ?? '—'} failed=${summary.stats.failed ?? '—'}`);
      console.log(`primary_reason: ${summary.primary_reason || '—'}`);
      for (const reason of summary.failure_reasons.slice(0, 20)) {
        const signals = reason.signals ? ` signals=${reason.signals}` : '';
        const stages = reason.last_stages ? ` stages=${reason.last_stages}` : '';
        const examples = reason.examples.length ? ` examples=${reason.examples.join(',')}` : '';
        console.log(`- ${reason.reason}: runs=${reason.runs}${signals}${stages}${examples}${reason.message ? ` message=${reason.message}` : ''}`);
      }
      if (summary.proxy_outcomes.length) {
        console.log('proxy_outcomes:');
        for (const proxy of summary.proxy_outcomes.slice(0, 12)) {
          console.log(`- ${proxy.exit_ip_or_proxy}: runs=${proxy.runs} clean=${proxy.clean} challenge=${proxy.challenge} proxy_fail=${proxy.proxy_fail} other=${proxy.other}${proxy.reasons ? ` reasons=${proxy.reasons}` : ''}`);
        }
      }
      console.log(`run_ids: ${summary.run_ids.length}`);
      process.exit(0);
    }
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
