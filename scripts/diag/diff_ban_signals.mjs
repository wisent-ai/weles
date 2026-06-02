#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

function usage() {
  console.log(`Usage:
  node scripts/diag/diff_ban_signals.mjs <ban_signal.json|recording-dir|console-run-url> <...>

Compares normalized LinkedIn/Weles ban_signal artifacts across runs.`);
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
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

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse JSON from ${label}: ${e.message}`);
  }
}

function inlineBanSignalFromHtml(html, label) {
  const decoded = decodeHtml(html);
  const key = '"ban_signal"';
  const keyIndex = decoded.lastIndexOf(key);
  if (keyIndex < 0) return null;
  const brace = decoded.indexOf('{', keyIndex + key.length);
  const objectText = extractBalancedObject(decoded, brace);
  if (!objectText) return null;
  return parseJson(objectText, `${label} inline ban_signal`);
}

async function readSignal(input) {
  if (isUrl(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText}: ${input}`);
    const text = await res.text();
    if (/\/ban_signal\.json(?:\?|$)/.test(input) || /^\s*\{/.test(text)) {
      return { label: input, data: parseJson(text, input) };
    }
    const artifactUrl = text.match(/https:\/\/[^"'<>\s]+\/ban_signal\.json/g)?.[0];
    if (artifactUrl) {
      try {
        return await readSignal(artifactUrl);
      } catch {
        const inline = inlineBanSignalFromHtml(text, input);
        if (inline) return { label: input, data: inline };
        throw new Error(`ban_signal artifact was listed but unreadable: ${artifactUrl}`);
      }
    }
    const inline = inlineBanSignalFromHtml(text, input);
    if (inline) return { label: input, data: inline };
    throw new Error(`no ban_signal found in ${input}`);
  }

  let path = input;
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'ban_signal.json');
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  return { label: path, data: parseJson(readFileSync(path, 'utf8'), path) };
}

function signalObject(data) {
  if (data?.ban_signal && typeof data.ban_signal === 'object') return data.ban_signal;
  return data;
}

function detailsObject(sig) {
  return sig?.details && typeof sig.details === 'object' ? sig.details : {};
}

function reasonCodes(details) {
  const reasons = Array.isArray(details.failure_reasons) ? details.failure_reasons : [];
  return reasons.map((r) => r?.code).filter(Boolean);
}

function stageNames(details) {
  const stages = Array.isArray(details.stage_events) ? details.stage_events : [];
  return stages.map((s) => s?.stage).filter(Boolean);
}

function normalize({ label, data }) {
  const sig = signalObject(data);
  const details = detailsObject(sig);
  const diagnostics = details.diagnostics && typeof details.diagnostics === 'object' ? details.diagnostics : {};
  const proxy = diagnostics.proxy && typeof diagnostics.proxy === 'object' ? diagnostics.proxy : {};
  const browser = diagnostics.browser && typeof diagnostics.browser === 'object' ? diagnostics.browser : {};
  const page = diagnostics.page && typeof diagnostics.page === 'object' ? diagnostics.page : {};
  const stages = stageNames(details);
  return {
    label,
    short_label: isUrl(label) ? label.split('/').filter(Boolean).at(-1) : basename(label),
    action: sig.action ?? '',
    signal: sig.signal ?? '',
    healthy: Boolean(sig.healthy),
    reasons: reasonCodes(details),
    last_stage: stages.at(-1) ?? '',
    stage_count: stages.length,
    stages,
    final_url: details.final_url ?? '',
    error: details.error ?? '',
    proxy: {
      requested: proxy.requested ?? '',
      provider: proxy.provider ?? '',
      proxy_type: proxy.proxy_type ?? '',
      expected_exit_ip: proxy.expected_exit_ip ?? details.expected_exit_ip ?? '',
      actual_exit_ip: proxy.actual_exit_ip ?? '',
      server_host: proxy.server_host ?? '',
      server_port: proxy.server_port ?? '',
    },
    browser: {
      requested_browser: browser.requested_browser ?? '',
      custom_browser_path: browser.custom_browser_path ?? '',
    },
    page: {
      url: page.url ?? details.final_url ?? '',
      title: page.title ?? '',
      pageKey: page.pageKey ?? '',
      challenge_signal: diagnostics.challenge_signal ?? '',
      input_count: Array.isArray(page.inputs) ? page.inputs.length : 0,
      iframe_count: Array.isArray(page.iframes) ? page.iframes.length : 0,
    },
  };
}

function diffList(a, b) {
  const aa = new Set(a);
  const bb = new Set(b);
  return {
    only_a: [...aa].filter((x) => !bb.has(x)),
    only_b: [...bb].filter((x) => !aa.has(x)),
  };
}

function fieldDiff(a, b, path, label) {
  const av = path.reduce((obj, key) => obj?.[key], a) ?? '';
  const bv = path.reduce((obj, key) => obj?.[key], b) ?? '';
  return av === bv ? null : `${label}: ${av || '—'} -> ${bv || '—'}`;
}

function compare(a, b) {
  const fields = [
    [['action'], 'action'],
    [['signal'], 'signal'],
    [['healthy'], 'healthy'],
    [['last_stage'], 'last_stage'],
    [['final_url'], 'final_url'],
    [['proxy', 'requested'], 'proxy.requested'],
    [['proxy', 'provider'], 'proxy.provider'],
    [['proxy', 'proxy_type'], 'proxy.type'],
    [['proxy', 'expected_exit_ip'], 'proxy.expected_ip'],
    [['proxy', 'actual_exit_ip'], 'proxy.actual_ip'],
    [['proxy', 'server_host'], 'proxy.server_host'],
    [['browser', 'requested_browser'], 'browser'],
    [['browser', 'custom_browser_path'], 'browser.path'],
    [['page', 'url'], 'page.url'],
    [['page', 'pageKey'], 'page.key'],
    [['page', 'challenge_signal'], 'page.challenge'],
    [['page', 'input_count'], 'page.input_count'],
    [['page', 'iframe_count'], 'page.iframe_count'],
  ];
  const diffs = fields.map(([path, label]) => fieldDiff(a, b, path, label)).filter(Boolean);
  const reasons = diffList(a.reasons, b.reasons);
  if (reasons.only_a.length || reasons.only_b.length) diffs.push(`reasons: -[${reasons.only_a.join(',') || '—'}] +[${reasons.only_b.join(',') || '—'}]`);
  const stages = diffList(a.stages, b.stages);
  if (stages.only_a.length || stages.only_b.length) diffs.push(`stages: -[${stages.only_a.join(',') || '—'}] +[${stages.only_b.join(',') || '—'}]`);
  return diffs;
}

const args = process.argv.slice(2).filter((arg) => arg !== '--json' && arg !== '-h' && arg !== '--help');
const json = process.argv.includes('--json');
if (process.argv.includes('-h') || process.argv.includes('--help') || args.length < 2) {
  usage();
  process.exit(args.length < 2 ? 1 : 0);
}

try {
  const runs = [];
  for (const arg of args) runs.push(normalize(await readSignal(arg)));
  const comparisons = [];
  for (let i = 1; i < runs.length; i++) {
    comparisons.push({
      from: runs[i - 1].label,
      to: runs[i].label,
      differences: compare(runs[i - 1], runs[i]),
    });
  }
  if (json) {
    console.log(JSON.stringify({ runs, comparisons }, null, 2));
  } else {
    for (const run of runs) {
      console.log(`${run.short_label}: action=${run.action || '—'} signal=${run.signal || '—'} healthy=${run.healthy} reason=${run.reasons[0] || '—'} last_stage=${run.last_stage || '—'} stages=${run.stage_count} final_url=${run.final_url || '—'}`);
      if (run.proxy.requested || run.proxy.actual_exit_ip || run.proxy.provider) {
        console.log(`  proxy requested=${run.proxy.requested || '—'} provider=${run.proxy.provider || '—'} type=${run.proxy.proxy_type || '—'} expected=${run.proxy.expected_exit_ip || '—'} actual=${run.proxy.actual_exit_ip || '—'}`);
      }
      if (run.page.challenge_signal || run.page.pageKey || run.page.input_count || run.page.iframe_count) {
        console.log(`  page key=${run.page.pageKey || '—'} challenge=${run.page.challenge_signal || '—'} inputs=${run.page.input_count} iframes=${run.page.iframe_count}`);
      }
    }
    for (const cmp of comparisons) {
      console.log(`diff ${cmp.from} -> ${cmp.to}`);
      if (!cmp.differences.length) console.log('- no normalized differences');
      for (const diff of cmp.differences) console.log(`- ${diff}`);
    }
  }
} catch (e) {
  console.error(`diff_ban_signals: ${e.message}`);
  process.exit(1);
}
