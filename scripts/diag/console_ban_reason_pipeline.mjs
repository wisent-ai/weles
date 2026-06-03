#!/usr/bin/env node
/**
 * Read-only Weles console ban-reason pipeline.
 *
 * Given a console aggregate URL, this script fetches each run page, extracts
 * inline run/session/fingerprint evidence and public artifacts where available,
 * classifies the observed failure reason, and compares failing cohorts against
 * completed cohorts. It does not launch browsers or run trajectories.
 */

const DEFAULT_URL = 'https://console.wisent.com/weles/testing/linkedin_register';
const RUN_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function usage() {
  console.log(`Usage:
  node scripts/diag/console_ban_reason_pipeline.mjs [console-aggregate-url] [options]

Options:
  --json                    Emit machine-readable JSON.
  --limit=N                 Analyze at most N run pages.
  --sample-per-bucket=N     Prefer up to N runs per aggregate failure bucket. Default: 4.
  --artifact-bytes=N        Max bytes fetched per public artifact. Default: 2000000.
  --no-artifacts            Do not fetch public DOM/network artifacts.

Examples:
  node scripts/diag/console_ban_reason_pipeline.mjs https://console.wisent.com/weles/testing/linkedin_register
  node scripts/diag/console_ban_reason_pipeline.mjs --json --sample-per-bucket=2`);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
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
  return decodeHtml(String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeText(value, max = 500) {
  return String(value ?? '')
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[redacted]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeUrl(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '[redacted]';
      u.password = '';
    }
    return u.toString().replace('%5Bredacted%5D@', '[redacted]@');
  } catch {
    return sanitizeText(raw, 220);
  }
}

function hostFromUrl(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
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

function parseJsonObject(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function objectAfter(decodedHtml, label) {
  const idx = decodedHtml.indexOf(label);
  if (idx < 0) return null;
  const brace = decodedHtml.indexOf('{', idx + label.length);
  const objectText = extractBalancedObject(decodedHtml, brace);
  return objectText ? parseJsonObject(objectText, label) : null;
}

function lastObjectAfterKey(decodedHtml, key) {
  const idx = decodedHtml.lastIndexOf(key);
  if (idx < 0) return null;
  const brace = decodedHtml.indexOf('{', idx + key.length);
  const objectText = extractBalancedObject(decodedHtml, brace);
  return objectText ? parseJsonObject(objectText, key) : null;
}

function tableRowsAfterHeading(html, heading) {
  const re = new RegExp(`<h2[^>]*>\\s*${escapeRegex(heading)}\\s*<\\/h2>`, 'i');
  const m = re.exec(html);
  if (!m) return [];
  const rest = html.slice(m.index + m[0].length);
  const nextHeading = rest.search(/<h2[^>]*>/i);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const table = section.match(/<table[\s\S]*?<\/table>/i)?.[0] ?? '';
  return table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
}

function cellsFromRow(row) {
  return (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(stripTags);
}

function statFromHtml(html, label) {
  const m = html.match(new RegExp(`${escapeRegex(label)}:\\s*<b[^>]*>(\\d+)`, 'i'));
  return m ? Number(m[1]) : null;
}

function aggregateFromHtml(html, source) {
  const action = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const runIds = unique([...html.matchAll(/\/weles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((m) => m[1]));
  const failureReasons = tableRowsAfterHeading(html, 'Failure reasons')
    .map(cellsFromRow)
    .filter((cells) => cells.length >= 2 && cells[0] !== 'reason' && !/^exit ip/i.test(cells[0]))
    .map((cells) => ({
      reason: cells[0],
      runs: safeNumber(cells[1]),
      signals: cells[2] === '—' ? '' : cells[2],
      last_stages: cells[3] === '—' ? '' : cells[3],
      examples: unique([...String(cells[4] ?? '').matchAll(/[0-9a-f]{8}/gi)].map((m) => m[0])),
      message: cells[5] === '—' ? '' : sanitizeText(cells[5] ?? '', 300),
    }));
  const proxyOutcomes = tableRowsAfterHeading(html, 'Exit-IP / proxy outcome analysis')
    .map(cellsFromRow)
    .filter((cells) => cells.length >= 8 && !/^exit ip/i.test(cells[0]))
    .map((cells) => ({
      exit_ip_or_proxy: sanitizeUrl(cells[0]),
      runs: safeNumber(cells[1]),
      clean: safeNumber(cells[2]),
      challenge: safeNumber(cells[3]),
      proxy_fail: safeNumber(cells[4]),
      other: safeNumber(cells[5]),
      signals: cells[6] === '—' ? '' : cells[6],
      reasons: cells[7] === '—' ? '' : cells[7],
    }));
  return {
    source,
    action,
    stats: {
      runs: statFromHtml(html, 'runs'),
      completed: statFromHtml(html, 'completed'),
      failed: statFromHtml(html, 'failed'),
    },
    failure_reasons: failureReasons,
    proxy_outcomes: proxyOutcomes,
    run_ids: runIds,
  };
}

function chooseRunIds(aggregate, samplePerBucket, limit) {
  const byShort = new Map();
  for (const id of aggregate.run_ids) byShort.set(id.slice(0, 8), id);
  const out = [];
  for (const bucket of aggregate.failure_reasons) {
    let added = 0;
    for (const short of bucket.examples) {
      const id = byShort.get(short);
      if (id && !out.includes(id)) {
        out.push(id);
        added += 1;
        if (added >= samplePerBucket) break;
      }
    }
  }
  for (const id of aggregate.run_ids) {
    if (!out.includes(id)) out.push(id);
    if (limit && out.length >= limit) break;
  }
  return limit ? out.slice(0, limit) : out;
}

function extractUrls(html) {
  const decoded = decodeHtml(html);
  return unique([
    ...decoded.matchAll(/https:\/\/[^"'<>\s\\]+/g),
    ...decoded.matchAll(/recordings:\/\/[^"'<>\s\\]+/g),
  ].map((m) => m[0]).map((u) => u.replace(/[),.;]+$/g, '')));
}

function classifyArtifactUrl(url) {
  if (/ban_signal\.json(?:\?|$)/i.test(url)) return 'ban_signal';
  if (/complete_network|network\.ndjson/i.test(url)) return 'network';
  if (/\.html(?:\?|$)|_dom/i.test(url)) return 'dom';
  if (/\.png(?:\?|$)|screenshot/i.test(url)) return 'screenshot';
  if (/\.webm(?:\?|$)|video/i.test(url)) return 'video';
  if (/console.*\.log|session_console/i.test(url)) return 'console_log';
  return 'other';
}

function artifactInventory(urls) {
  const artifactUrls = urls.filter((url) => {
    if (url.startsWith('recordings://')) return true;
    try {
      const u = new URL(url);
      if (/\/weles\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(u.pathname)) return false;
      return /recordings|artifact|network|complete_network|session_|_dom|\.webm|\.png|ban_signal|console.*\.log/i.test(u.pathname);
    } catch {
      return false;
    }
  });
  const items = artifactUrls.map((url) => ({
    url: sanitizeUrl(url),
    raw_url: url,
    scheme: url.startsWith('recordings://') ? 'recordings' : 'https',
    kind: classifyArtifactUrl(url),
    public: /^https?:\/\//i.test(url),
  }));
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return { items, counts };
}

function signalObject(runPage) {
  const result = runPage.result;
  const candidates = [
    runPage.inline_ban_signal,
    result?.ban_signal,
    result?.run?.ban_signal,
    result?.result?.ban_signal,
    result?.details?.ban_signal,
  ];
  return candidates.find((x) => x && typeof x === 'object') ?? null;
}

function resultArtifacts(result) {
  const artifacts = result?.artifacts ?? result?.run?.artifacts ?? result?.result?.artifacts ?? {};
  if (!artifacts || typeof artifacts !== 'object') return {};
  return artifacts;
}

function flattenArtifactUrls(artifacts) {
  const out = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      if (/^(https?:|recordings:)\/\//i.test(value)) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(artifacts);
  return unique(out);
}

async function fetchText(url, maxBytes) {
  const res = await fetch(url);
  const status = res.status;
  if (!res.ok) return { ok: false, status, text: '', bytes: 0, error: `${status} ${res.statusText}` };
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return { ok: true, status, text: text.slice(0, maxBytes), bytes: text.length, truncated: text.length > maxBytes };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (Buffer.concat(chunks).length < maxBytes) chunks.push(Buffer.from(value));
    if (total >= maxBytes) {
      truncated = true;
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  const buf = Buffer.concat(chunks).subarray(0, maxBytes);
  return { ok: true, status, text: buf.toString('utf8'), bytes: total, truncated };
}

function summarizeDom(text) {
  const bodyText = stripTags(text);
  const iframes = [...text.matchAll(/<iframe\b[^>]*>/gi)].map((m) => {
    const tag = m[0];
    const attr = (name) => decodeHtml(tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'))?.[1] ?? '');
    return {
      id: sanitizeText(attr('id'), 80),
      name: sanitizeText(attr('name'), 80),
      title: sanitizeText(attr('title'), 120),
      src_host: hostFromUrl(attr('src')),
      src_path: sanitizeText(attr('src').replace(/^https?:\/\/[^/]+/i, ''), 160),
    };
  }).slice(0, 30);
  const inputs = [...text.matchAll(/<input\b[^>]*>/gi)].map((m) => {
    const tag = m[0];
    const attr = (name) => decodeHtml(tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'))?.[1] ?? '');
    return {
      name: sanitizeText(attr('name'), 80),
      id: sanitizeText(attr('id'), 80),
      type: sanitizeText(attr('type'), 40),
      autocomplete: sanitizeText(attr('autocomplete'), 60),
    };
  }).slice(0, 40);
  return {
    bytes: text.length,
    title: sanitizeText(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '', 160),
    body_text_sample: sanitizeText(bodyText, 500),
    flags: {
      has_signup_text: /join linkedin|agree\s*&\s*join|sign up|signup/i.test(bodyText),
      has_security_text: /security verification|verify you are human|captcha|challenge/i.test(bodyText),
      has_checkpoint_ref: /checkpoint|challengeIframe|arkose/i.test(text),
      has_recaptcha_ref: /recaptcha|grecaptcha/i.test(text),
    },
    input_count: inputs.length,
    iframe_count: iframes.length,
    inputs,
    iframes,
  };
}

function summarizeNetwork(text) {
  const interesting = [];
  const counters = {
    signup_api: 0,
    create_account: 0,
    checkpoint: 0,
    challenge: 0,
    captcha: 0,
    http_429: 0,
  };
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    const haystack = line.toLowerCase();
    if (haystack.includes('/signup/api')) counters.signup_api += 1;
    if (haystack.includes('createaccount')) counters.create_account += 1;
    if (haystack.includes('checkpoint')) counters.checkpoint += 1;
    if (haystack.includes('challenge')) counters.challenge += 1;
    if (haystack.includes('captcha') || haystack.includes('recaptcha') || haystack.includes('grecaptcha')) counters.captcha += 1;
    if (/"status"\s*:\s*429|\b429\b/.test(line)) counters.http_429 += 1;
    if (/signup\/api|createAccount|checkpoint|challenge|captcha|recaptcha|grecaptcha|"status"\s*:\s*429/i.test(line)) {
      interesting.push(sanitizeText(line, 1200));
    }
  }
  return {
    bytes: text.length,
    counters,
    interesting_count: interesting.length,
    samples: interesting.slice(0, 12),
  };
}

function summarizeConsoleLog(text) {
  const samples = text.split(/\n/)
    .filter((line) => /error|fail|captcha|challenge|checkpoint|signup|proxy|drift|429/i.test(line))
    .map((line) => sanitizeText(line, 600))
    .slice(0, 20);
  return { bytes: text.length, samples };
}

async function fetchArtifactSummaries(inventory, maxBytes, fetchArtifacts) {
  const summaries = [];
  if (!fetchArtifacts) return summaries;
  for (const item of inventory.items) {
    if (!item.public) {
      summaries.push({ kind: item.kind, url: item.url, accessible: false, reason: 'recordings_scheme_not_public' });
      continue;
    }
    if (!['dom', 'network', 'console_log', 'ban_signal'].includes(item.kind)) continue;
    const fetched = await fetchText(item.raw_url, maxBytes).catch((e) => ({ ok: false, status: 0, text: '', bytes: 0, error: e.message }));
    const base = { kind: item.kind, url: item.url, accessible: fetched.ok, status: fetched.status, bytes: fetched.bytes, truncated: Boolean(fetched.truncated) };
    if (!fetched.ok) {
      summaries.push({ ...base, error: sanitizeText(fetched.error, 200) });
      continue;
    }
    if (item.kind === 'dom') summaries.push({ ...base, summary: summarizeDom(fetched.text) });
    else if (item.kind === 'network') summaries.push({ ...base, summary: summarizeNetwork(fetched.text) });
    else if (item.kind === 'console_log') summaries.push({ ...base, summary: summarizeConsoleLog(fetched.text) });
    else if (item.kind === 'ban_signal') summaries.push({ ...base, summary: parseJsonObject(fetched.text, item.url) ?? sanitizeText(fetched.text, 500) });
  }
  return summaries;
}

function compactSession(session) {
  const proxy = session?.proxy && typeof session.proxy === 'object' ? session.proxy : {};
  const persona = session?.persona && typeof session.persona === 'object' ? session.persona : {};
  return {
    label: sanitizeText(session?.label, 80),
    mode: sanitizeText(session?.mode, 50),
    cdp: typeof session?.cdp === 'boolean' ? session.cdp : null,
    provider: sanitizeText(session?.provider ?? session?.proxy_provider ?? proxy.provider, 80),
    proxy_url: sanitizeUrl(session?.proxy_url ?? session?.proxyUrl ?? ''),
    proxy_server: sanitizeUrl(proxy.server ?? ''),
    proxy_host: sanitizeText(proxy.host ?? hostFromUrl(proxy.server ?? ''), 120),
    proxy_port: sanitizeText(proxy.port ?? '', 20),
    exit_ip: sanitizeText(session?.exit_ip ?? proxy.exit_ip ?? '', 80),
    proxy_type: sanitizeText(session?.proxy_type ?? proxy.proxy_type ?? '', 80),
    persona: {
      browser: sanitizeText(persona.browser, 80),
      os: sanitizeText(persona.os, 80),
      platform: sanitizeText(persona.platform, 80),
      language: sanitizeText(persona.language, 80),
      timezone: sanitizeText(persona.timezone, 120),
      screen: persona.screen && typeof persona.screen === 'object' ? {
        width: persona.screen.width ?? null,
        height: persona.screen.height ?? null,
        dpr: persona.screen.dpr ?? null,
      } : null,
      gpu_vendor: sanitizeText(persona.gpu?.vendor, 160),
      gpu_renderer: sanitizeText(persona.gpu?.renderer, 240),
    },
  };
}

function looseSessionFromConsoleHtml(decodedHtml) {
  const pick = (key) => decodedHtml.match(new RegExp(`"${escapeRegex(key)}"\\s*:\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const proxyServer = pick('server');
  const proxyHost = pick('host');
  const proxyPort = pick('port');
  const exitIp = pick('exit_ip');
  const browser = pick('browser');
  const os = pick('os');
  const platform = pick('platform');
  const language = pick('language');
  const timezone = pick('timezone');
  const gpuVendor = pick('vendor');
  const gpuRenderer = pick('renderer');
  if (!proxyServer && !proxyHost && !exitIp && !browser && !os && !platform && !timezone) return null;
  return {
    proxy: {
      server: proxyServer,
      host: proxyHost,
      port: proxyPort,
    },
    exit_ip: exitIp,
    persona: {
      browser,
      os,
      platform,
      language,
      timezone,
      gpu: {
        vendor: gpuVendor,
        renderer: gpuRenderer,
      },
    },
  };
}

function compactVersions(versions) {
  return {
    trajectory_path: sanitizeText(versions?.trajectory_path, 200),
    weles_commit: sanitizeText(versions?.weles_git_commit ?? versions?.weles_commit, 80),
    trajectory_sha256: sanitizeText(versions?.trajectory_sha256, 80),
    dirty: Boolean(versions?.weles_git_dirty ?? versions?.weles_dirty),
    package_version: sanitizeText(versions?.weles_package_version ?? versions?.weles_pkg_version, 40),
  };
}

function compactParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (/password|secret|token|key/i.test(key)) {
      out[key] = '[redacted]';
    } else if (/proxy/i.test(key) && typeof value === 'string') {
      out[key] = sanitizeUrl(value);
    } else if (typeof value === 'string') {
      out[key] = sanitizeText(value, 240);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (typeof value === 'object') {
      out[key] = sanitizeText(JSON.stringify(value), 400);
    }
  }
  return out;
}

function failureText(run) {
  const sig = run.ban_signal;
  const details = sig?.details && typeof sig.details === 'object' ? sig.details : {};
  const result = run.result ?? {};
  return [
    run.aggregate_reason,
    sig?.signal,
    details.reason,
    details.error,
    details.final_url,
    details.last_url,
    result?.reason,
    result?.error,
    result?.run?.error,
    result?.run?.stderr,
    run.page_text_sample,
  ].map((x) => String(x ?? '')).join('\n');
}

function artifactFlags(run) {
  const flags = {
    dom_security: false,
    dom_checkpoint: false,
    dom_recaptcha: false,
    network_create_account: false,
    network_checkpoint: false,
    network_http_429: false,
  };
  for (const artifact of run.artifact_summaries ?? []) {
    const summary = artifact.summary ?? {};
    if (artifact.kind === 'dom') {
      flags.dom_security ||= Boolean(summary.flags?.has_security_text);
      flags.dom_checkpoint ||= Boolean(summary.flags?.has_checkpoint_ref);
      flags.dom_recaptcha ||= Boolean(summary.flags?.has_recaptcha_ref);
    }
    if (artifact.kind === 'network') {
      flags.network_create_account ||= (summary.counters?.create_account ?? 0) > 0;
      flags.network_checkpoint ||= (summary.counters?.checkpoint ?? 0) > 0 || (summary.counters?.challenge ?? 0) > 0;
      flags.network_http_429 ||= (summary.counters?.http_429 ?? 0) > 0;
    }
  }
  return flags;
}

function classifyRun(run) {
  const text = failureText(run);
  const sig = run.ban_signal?.signal ?? '';
  const flags = artifactFlags(run);
  const finalUrl = run.ban_signal?.details?.final_url ?? run.ban_signal?.details?.last_url ?? '';
  const reasons = [];
  const add = (code, confidence, evidence) => {
    if (!reasons.some((r) => r.code === code)) reasons.push({ code, confidence, evidence: sanitizeText(evidence, 500) });
  };

  if (run.ban_signal?.healthy === true || /keeper_completed|completed|healthy/i.test(sig)) {
    add('completed', 'high', sig || 'healthy ban_signal');
  }
  if (/Executable doesn't exist|browserType\.launch|playwright install|missing.*browser|Nightly\.app/i.test(text)) {
    add('browser_launch_failed', 'high', text);
  }
  if (/user_interrupt|keeper_abandoned|abandoned|interrupted/i.test(text)) {
    add('interrupted_or_abandoned', 'medium', text);
  }
  if (/proxy_failed|tunnel_failed|proxy_unavailable|PROXY_DRIFT|ERR_TUNNEL|407|proxy auth/i.test(text)) {
    add('proxy_or_tunnel_failed', 'high', text);
  }
  if (/http_429/i.test(sig) || flags.network_http_429 || /\b429\b|too many requests/i.test(text)) {
    add('http_429_rate_limited', 'high', text);
  }
  if (/email_rejected/i.test(sig) || /email.*reject|invalid email|email address is not accepted/i.test(text)) {
    add('email_rejected', 'high', text);
  }
  if (/phone_gate_burned|phone.*required|phone verification/i.test(text)) {
    add('phone_gate', 'high', text);
  }
  if (/captcha_loop_score_too_low/i.test(text) || /escalating challenges|Please try again after VERIFY|session scored bot/i.test(text)) {
    add('captcha_loop_score_too_low', 'high', text);
  }
  if (/captcha_challenge|cold_identity_challenge|DETECTION_TRIGGERED|checkpoint|challengeIframe|security verification|captcha/i.test(text) || flags.dom_security || flags.dom_checkpoint || flags.dom_recaptcha || flags.network_checkpoint) {
    add('challenge_or_checkpoint', /captcha_challenge|cold_identity_challenge|DETECTION_TRIGGERED|challengeIframe/.test(text) ? 'high' : 'medium', text);
  }
  if (/signup_did_not_complete/i.test(text) || /^https?:\/\/www\.linkedin\.com\/signup\/?$/i.test(finalUrl)) {
    add('signup_stuck_or_silent_rejection', 'medium', text);
  }
  if (/failed_without_reason/i.test(run.aggregate_reason) && !run.ban_signal && !run.artifact_inventory.counts.dom && !run.artifact_inventory.counts.network) {
    add('missing_failure_evidence', 'high', 'run has no ban_signal and no DOM/network artifacts');
  }
  if (!reasons.length && sig) add(sig, 'medium', text);
  if (!reasons.length) add('unclassified', 'low', 'no usable ban_signal or artifact evidence');
  return reasons;
}

function fingerprintVector(run) {
  const s = run.session ?? {};
  const p = s.persona ?? {};
  const params = run.params ?? {};
  return {
    signal: run.ban_signal?.signal ?? '',
    aggregate_reason: run.aggregate_reason ?? '',
    provider: s.provider,
    proxy_host: s.proxy_host || hostFromUrl(s.proxy_url),
    proxy_port: s.proxy_port || params.proxy_port,
    exit_ip: s.exit_ip,
    proxy_type: s.proxy_type || params.proxy_kind,
    browser: p.browser,
    os: p.os,
    platform: p.platform,
    language: p.language || params.language,
    timezone: p.timezone || params.timezone,
    screen: p.screen ? `${p.screen.width}x${p.screen.height}@${p.screen.dpr}` : '',
    gpu_vendor: p.gpu_vendor,
    gpu_renderer: p.gpu_renderer,
    trajectory_path: run.versions?.trajectory_path,
    weles_commit: run.versions?.weles_commit,
    dirty: String(Boolean(run.versions?.dirty)),
    artifact_dom: String(Boolean(run.artifact_inventory.counts.dom)),
    artifact_network: String(Boolean(run.artifact_inventory.counts.network)),
    public_artifacts: String(run.artifact_inventory.items.some((x) => x.public)),
  };
}

function reasonSummary(runs) {
  const counts = new Map();
  for (const run of runs) {
    for (const reason of run.classification) {
      const row = counts.get(reason.code) ?? { code: reason.code, runs: 0, examples: [], confidence: {} };
      row.runs += 1;
      if (row.examples.length < 5) row.examples.push(run.id);
      row.confidence[reason.confidence] = (row.confidence[reason.confidence] ?? 0) + 1;
      counts.set(reason.code, row);
    }
  }
  return [...counts.values()].sort((a, b) => b.runs - a.runs || a.code.localeCompare(b.code));
}

function cohortName(run) {
  if (run.classification.some((r) => r.code === 'completed')) return 'completed';
  if (run.classification.some((r) => /challenge|captcha/.test(r.code))) return 'challenge';
  if (run.classification.some((r) => /proxy|tunnel/.test(r.code))) return 'proxy';
  if (run.classification.some((r) => /missing_failure_evidence|interrupted/.test(r.code))) return 'evidence_gap';
  return 'failed_other';
}

function discriminatorSummary(runs) {
  const fields = ['provider', 'proxy_host', 'proxy_port', 'exit_ip', 'proxy_type', 'browser', 'os', 'platform', 'language', 'timezone', 'screen', 'gpu_vendor', 'trajectory_path', 'dirty', 'artifact_dom', 'artifact_network', 'public_artifacts'];
  const rows = [];
  const completed = runs.filter((r) => cohortName(r) === 'completed');
  const challenge = runs.filter((r) => cohortName(r) === 'challenge');
  const failed = runs.filter((r) => cohortName(r) !== 'completed');
  const cohorts = { completed, challenge, failed };
  for (const field of fields) {
    const values = unique(runs.map((run) => run.fingerprint[field]).filter((x) => x !== undefined && x !== null && String(x) !== ''));
    for (const value of values) {
      const row = { field, value: sanitizeText(value, 240) };
      for (const [name, cohort] of Object.entries(cohorts)) {
        row[name] = cohort.filter((run) => String(run.fingerprint[field] ?? '') === String(value)).length;
      }
      row.total = runs.filter((run) => String(run.fingerprint[field] ?? '') === String(value)).length;
      if (row.total >= 2 || row.challenge || row.completed) rows.push(row);
    }
  }
  return rows
    .filter((row) => row.failed || row.challenge || row.completed)
    .sort((a, b) => (b.challenge - a.challenge) || (b.failed - a.failed) || (b.completed - a.completed) || b.total - a.total)
    .slice(0, 40);
}

function evidenceGaps(runs) {
  const gaps = [];
  const noBan = runs.filter((r) => !r.ban_signal).length;
  const noArtifacts = runs.filter((r) => !r.artifact_inventory.items.length).length;
  const noPublicArtifacts = runs.filter((r) => r.artifact_inventory.items.length && !r.artifact_inventory.items.some((x) => x.public)).length;
  const noStageEvents = runs.filter((r) => !Array.isArray(r.stage_events) || !r.stage_events.length).length;
  const inaccessiblePublic = runs.filter((r) => (r.artifact_summaries ?? []).some((a) => a.public !== false && a.accessible === false)).length;
  if (noBan) gaps.push({ code: 'missing_ban_signal', runs: noBan, impact: 'cannot classify beyond console table/result text' });
  if (noArtifacts) gaps.push({ code: 'missing_artifacts', runs: noArtifacts, impact: 'no DOM/network/video evidence to locate first divergence' });
  if (noPublicArtifacts) gaps.push({ code: 'recordings_scheme_only', runs: noPublicArtifacts, impact: 'console lists recordings:// artifacts that this script cannot fetch remotely' });
  if (inaccessiblePublic) gaps.push({ code: 'public_artifacts_unreadable', runs: inaccessiblePublic, impact: 'artifact URL exists but fetch failed, often stale/misconfigured storage' });
  if (noStageEvents) gaps.push({ code: 'missing_stage_events', runs: noStageEvents, impact: 'cannot automatically identify first failing trajectory stage' });
  return gaps;
}

async function fetchRun(runId, aggregateReasonById, options) {
  const url = `${options.consoleBase}/weles/${runId}`;
  const res = await fetch(url);
  const html = await res.text();
  const decoded = decodeHtml(html);
  const pageText = stripTags(html);
  const inlineBan = lastObjectAfterKey(decoded, '"ban_signal"');
  const result = objectAfter(decoded, 'full result');
  const session = compactSession(objectAfter(decoded, 'session (proxy / persona / browser / exit_ip)') ?? result?.session ?? result?.run?.session ?? looseSessionFromConsoleHtml(decoded) ?? {});
  const versions = compactVersions(objectAfter(decoded, 'versions (weles commit / trajectory sha / dist)') ?? result?.versions ?? result?.run?.versions ?? {});
  const params = compactParams(objectAfter(decoded, 'params') ?? result?.params ?? result?.run?.params ?? {});
  const artifactsFromResult = flattenArtifactUrls(resultArtifacts(result));
  const inventory = artifactInventory(unique([...extractUrls(html), ...artifactsFromResult]));
  const run = {
    id: runId,
    url,
    http_status: res.status,
    aggregate_reason: aggregateReasonById.get(runId) ?? '',
    page_title: sanitizeText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '', 120),
    page_text_sample: sanitizeText(pageText, 1200),
    ban_signal: inlineBan ?? signalObject({ inline_ban_signal: null, result }),
    session,
    versions,
    params,
    artifact_inventory: inventory,
    artifact_summaries: await fetchArtifactSummaries(inventory, options.artifactBytes, options.fetchArtifacts),
    stage_events: result?.stage_events ?? result?.run?.stage_events ?? result?.result?.stage_events ?? inlineBan?.details?.stage_events ?? [],
    result: result ? {
      exit_code: result.run?.exit_code ?? result.exit_code ?? null,
      action: sanitizeText(result.run?.action ?? result.action, 100),
      error: sanitizeText(result.run?.error ?? result.error ?? result.reason, 500),
    } : null,
  };
  run.classification = classifyRun(run);
  run.fingerprint = fingerprintVector(run);
  return run;
}

function runReasonIndex(aggregate) {
  const byShort = new Map();
  for (const id of aggregate.run_ids) byShort.set(id.slice(0, 8), id);
  const out = new Map();
  for (const bucket of aggregate.failure_reasons) {
    for (const short of bucket.examples) {
      const id = byShort.get(short);
      if (id) out.set(id, bucket.reason);
    }
  }
  return out;
}

function printHuman(report) {
  console.log(`source: ${report.source}`);
  console.log(`action: ${report.aggregate.action || '—'}`);
  console.log(`runs: aggregate_total=${report.aggregate.stats.runs ?? '—'} analyzed=${report.analyzed_runs} completed=${report.aggregate.stats.completed ?? '—'} failed=${report.aggregate.stats.failed ?? '—'}`);
  console.log('reason_summary:');
  for (const row of report.reason_summary) {
    console.log(`- ${row.code}: runs=${row.runs} confidence=${Object.entries(row.confidence).map(([k, v]) => `${k}:${v}`).join(',')} examples=${row.examples.map((x) => x.slice(0, 8)).join(',')}`);
  }
  if (report.evidence_gaps.length) {
    console.log('evidence_gaps:');
    for (const gap of report.evidence_gaps) console.log(`- ${gap.code}: runs=${gap.runs} impact=${gap.impact}`);
  }
  if (report.discriminators.length) {
    console.log('fingerprint_discriminators:');
    for (const row of report.discriminators.slice(0, 20)) {
      console.log(`- ${row.field}=${row.value || '—'} total=${row.total} failed=${row.failed} challenge=${row.challenge} completed=${row.completed}`);
    }
  }
  console.log('runs:');
  for (const run of report.runs.slice(0, 30)) {
    const reasons = run.classification.map((r) => `${r.code}/${r.confidence}`).join(',');
    console.log(`- ${run.id.slice(0, 8)} reason=${reasons} signal=${run.ban_signal?.signal || '—'} proxy=${run.session.provider || '—'}:${run.session.exit_ip || run.session.proxy_host || '—'} browser=${run.session.persona.browser || '—'} os=${run.session.persona.os || '—'} artifacts=${JSON.stringify(run.artifacts.counts)}`);
  }
}

if (flag('-h') || flag('--help')) {
  usage();
  process.exit(0);
}

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const source = positional[0] ?? DEFAULT_URL;
const json = flag('--json');
const samplePerBucket = safeNumber(argValue('--sample-per-bucket', '4'), 4);
const limit = safeNumber(argValue('--limit', '0'), 0);
const artifactBytes = safeNumber(argValue('--artifact-bytes', '2000000'), 2_000_000);
const fetchArtifacts = !flag('--no-artifacts');

try {
  const aggregateRes = await fetch(source);
  if (!aggregateRes.ok) throw new Error(`fetch failed ${aggregateRes.status} ${aggregateRes.statusText}: ${source}`);
  const aggregateHtml = await aggregateRes.text();
  const aggregate = aggregateFromHtml(aggregateHtml, source);
  if (!aggregate.run_ids.length) throw new Error(`no /weles/<run-id> links found in ${source}`);
  const sourceUrl = new URL(source);
  const consoleBase = `${sourceUrl.protocol}//${sourceUrl.host}`;
  const selectedIds = chooseRunIds(aggregate, samplePerBucket, limit);
  const reasonById = runReasonIndex(aggregate);
  const runs = [];
  for (const id of selectedIds) {
    runs.push(await fetchRun(id, reasonById, { consoleBase, artifactBytes, fetchArtifacts }));
  }
  const report = {
    source,
    generated_at: new Date().toISOString(),
    aggregate,
    analyzed_runs: runs.length,
    reason_summary: reasonSummary(runs),
    evidence_gaps: evidenceGaps(runs),
    discriminators: discriminatorSummary(runs),
    runs: runs.map((run) => ({
      id: run.id,
      url: run.url,
      aggregate_reason: run.aggregate_reason,
      ban_signal: run.ban_signal ? {
        signal: run.ban_signal.signal ?? '',
        healthy: Boolean(run.ban_signal.healthy),
        details: run.ban_signal.details ? JSON.parse(JSON.stringify(run.ban_signal.details, (_, value) => typeof value === 'string' ? sanitizeText(value, 1000) : value)) : {},
      } : null,
      classification: run.classification,
      fingerprint: run.fingerprint,
      session: run.session,
      versions: run.versions,
      params: run.params,
      artifacts: {
        counts: run.artifact_inventory.counts,
        items: run.artifact_inventory.items.map(({ raw_url, ...item }) => item),
        summaries: run.artifact_summaries,
      },
      stage_count: Array.isArray(run.stage_events) ? run.stage_events.length : 0,
      result: run.result,
    })),
  };

  if (json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
} catch (e) {
  console.error(`console_ban_reason_pipeline: ${e.message}`);
  process.exit(1);
}
