#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const OUT_DIR = 'recordings/audits';

const CHALLENGE_RE = /checkpoint|challenge|captcha|recaptcha|arkose|funcaptcha|captchaInternal|security|verify|uas\/|checkpoint\/challenge/i;
const SIGNUP_RE = /signup|cold-join|createAccount|registration|register|onboarding/i;
const REPORT_RE = /\/report|csp-report|reporting|li\/track|collect|rum|beacon|telemetry|errors?/i;
const API_RE = /\/voyager\/api\/|\/checkpoint\/|\/uas\/|\/oauth\/|\/li\/track|\/graphql/i;
const TRACKING_HOST_RE = /doubleclick\.net|adservice\.google\.com|google\.com\/(ccm|gmp|rmkt)|px\.ads\.linkedin\.com|analytics|telemetry/i;
const SECRET_HEADER_RE = /cookie|authorization|token|csrf|credential|password|key|secret|set-cookie/i;
const SENSITIVE_BODY_TERM_RE = /password|passwd|emailAddress|email|csrf|JSESSIONID|li_at|bcookie|bscookie|captcha_key|g-recaptcha-response/i;

function usage() {
  console.error('Usage: node scripts/debug/linkedin_network_audit.mjs <network.ndjson path-or-url> [more...]');
  process.exit(2);
}

function labelForSource(source) {
  try {
    const u = new URL(source);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.slice(-3).join('_').replace(/[^a-z0-9_.-]/gi, '_') || 'url';
  } catch {
    return basename(source).replace(/[^a-z0-9_.-]/gi, '_') || 'file';
  }
}

async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`fetch ${source} failed: ${res.status}`);
    return await res.text();
  }
  return await readFile(source, 'utf8');
}

function parseLines(text) {
  const entries = [];
  let bad = 0;
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      bad++;
    }
  }
  return { entries, bad };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return String(v);
  }
  return undefined;
}

function headerNames(headers) {
  if (!headers || typeof headers !== 'object') return [];
  return Object.keys(headers).sort();
}

function responseHeadersFor(entry) {
  return entry.headers && typeof entry.headers === 'object' ? entry.headers
    : entry.response_headers && typeof entry.response_headers === 'object' ? entry.response_headers
      : {};
}

function requestHeadersFor(entry) {
  return entry.request_headers && typeof entry.request_headers === 'object' ? entry.request_headers
    : entry.requestHeaders && typeof entry.requestHeaders === 'object' ? entry.requestHeaders
      : entry.request?.headers && typeof entry.request.headers === 'object' ? entry.request.headers
        : {};
}

function cookieNames(setCookie) {
  if (!setCookie) return [];
  const raw = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
  return [...new Set(raw.split(/,(?=\s*[^;,=\s]+?=)|\n/g)
    .map((part) => part.trim().match(/^([^=;\s]+)/)?.[1])
    .filter(Boolean))].sort();
}

function pathKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let path = u.pathname;
    if (/doubleclick\.net|adservice\.google\.com/i.test(u.host)) {
      path = path.split(';')[0] || path;
      path = path.replace(/\/ddm\/fls\/z\/.+/i, '/ddm/fls/z/<event>');
    }
    if (/google\.com$/i.test(u.host) && path.startsWith('/gmp/conversion/')) {
      path = '/gmp/conversion/<id>';
    }
    path = path
      .replace(/\/checkpoint\/challengeIframe\/[^/?#]+/i, '/checkpoint/challengeIframe/<id>')
      .replace(/\/checkpoint\/challenge\/[^/?#]+/i, '/checkpoint/challenge/<id>')
      .replace(/\/recaptcha\/releases\/[^/]+/i, '/recaptcha/releases/<release>')
      .replace(/\/sc\/h\/[^/?#]+/i, '/sc/h/<asset>')
      .replace(/\/aero-v1\/sc\/h\/assets\/[^/?#]+/i, '/aero-v1/sc/h/assets/<asset>');
    return `${u.host}${path}`;
  } catch {
    return rawUrl || '';
  }
}

function redactedHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SECRET_HEADER_RE.test(k) ? '<redacted>' : String(v).slice(0, 300);
  }
  return out;
}

function bodySignals(body) {
  if (!body || typeof body !== 'string') return [];
  const signals = [];
  const checks = [
    ['captcha', /captcha|recaptcha|hcaptcha|arkose|funcaptcha/i],
    ['checkpoint', /checkpoint|security check|verify your identity|quick security check/i],
    ['rate_limit', /TOO_MANY_REQUESTS|too many requests|temporarily restricted|throttled/i],
    ['challenge', /challenge|CHALLENGE|SECURITY_CHECKPOINT/i],
    ['sensitive_terms_present', SENSITIVE_BODY_TERM_RE],
  ];
  for (const [name, rx] of checks) if (rx.test(body)) signals.push(name);
  return signals;
}

function classifyEntry(entry, idx) {
  const url = String(entry.url ?? '');
  const headers = responseHeadersFor(entry);
  const status = typeof entry.status === 'number' ? entry.status : null;
  const location = headerValue(headers, 'location');
  const setCookie = headerValue(headers, 'set-cookie');
  const contentSecurityPolicy = headerValue(headers, 'content-security-policy');
  const reportTo = headerValue(headers, 'report-to') || headerValue(headers, 'reporting-endpoints');
  const body = typeof entry.body === 'string' ? entry.body
    : typeof entry.response_body?.excerpt === 'string' ? entry.response_body.excerpt
      : '';
  return {
    idx,
    ts: entry.ts ?? null,
    phase: entry.phase ?? null,
    method: entry.method ?? null,
    url,
    key: pathKey(url),
    status,
    is_redirect: status !== null && status >= 300 && status < 400,
    location: location ? String(location).slice(0, 500) : null,
    cookie_names: cookieNames(setCookie),
    has_csp: !!contentSecurityPolicy,
    has_reporting: !!reportTo || REPORT_RE.test(url),
    header_names: headerNames(headers),
    request_header_names: entry.request_header_text_names ?? entry.request_header_names ?? headerNames(requestHeadersFor(entry)),
    body_signals: status === 429
      ? [...new Set([...bodySignals(body), 'rate_limit'])]
      : bodySignals(body),
    category: TRACKING_HOST_RE.test(`${url}`) || REPORT_RE.test(url) ? 'reporting'
      : CHALLENGE_RE.test(url) || bodySignals(body).some((s) => ['captcha', 'checkpoint', 'challenge'].includes(s)) ? 'challenge'
      : SIGNUP_RE.test(url) ? 'signup'
      : API_RE.test(url) ? 'api'
      : 'other',
  };
}

function topCounts(values, limit = 25) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function summarize(source, entries, badLines) {
  const classified = entries.map(classifyEntry);
  const statuses = topCounts(classified.map((e) => String(e.status ?? 'unknown')));
  const hosts = topCounts(classified.map((e) => {
    try { return new URL(e.url).host; } catch { return 'invalid-url'; }
  }));
  const categories = topCounts(classified.map((e) => e.category));
  const redirects = classified.filter((e) => e.is_redirect).map((e) => ({
    idx: e.idx,
    status: e.status,
    from: e.key,
    location: e.location,
  }));
  const challenge = classified.filter((e) => e.category === 'challenge').map((e) => ({
    idx: e.idx,
    method: e.method,
    status: e.status,
    key: e.key,
    cookie_names: e.cookie_names,
    body_signals: e.body_signals,
  }));
  const signup = classified.filter((e) => e.category === 'signup').map((e) => ({
    idx: e.idx,
    method: e.method,
    status: e.status,
    key: e.key,
    cookie_names: e.cookie_names,
    body_signals: e.body_signals,
  }));
  const reporting = classified.filter((e) => e.has_reporting || e.category === 'reporting').map((e) => ({
    idx: e.idx,
    method: e.method,
    status: e.status,
    key: e.key,
  }));
  const cookieNamesSeen = topCounts(classified.flatMap((e) => e.cookie_names), 50);
  const responseHeaderNames = topCounts(classified.flatMap((e) => e.header_names), 80);
  const riskyBodies = classified
    .filter((e) => e.body_signals.includes('sensitive_terms_present') && /linkedin\.com\/signup\/api|linkedin\.com\/checkpoint|linkedin\.com\/uas/i.test(e.url))
    .map((e) => ({ idx: e.idx, status: e.status, key: e.key, body_signals: e.body_signals }));

  return {
    source,
    artifact_format: {
      entries: entries.length,
      bad_lines: badLines,
      has_request_headers: entries.some((e) => e.requestHeaders || e.request_headers || e.request?.headers),
      has_response_headers: entries.some((e) => e.headers || e.response_headers),
      has_response_body_excerpt: entries.some((e) => (typeof e.body === 'string' && e.body.length > 0) || typeof e.response_body?.excerpt === 'string'),
      has_request_header_order_hint: entries.some((e) => Array.isArray(e.request_header_text_names) && e.request_header_text_names.length > 0),
      has_response_header_order_hint: entries.some((e) => Array.isArray(e.response_header_text_names) && e.response_header_text_names.length > 0),
      limitation: 'network.ndjson is response-only. complete_network.ndjson adds CDP request/response events and raw-header order hints when Chromium exposes headersText.',
    },
    status_counts: statuses,
    host_counts: hosts,
    category_counts: categories,
    first_url: classified[0]?.url ?? null,
    final_url_observed: classified.at(-1)?.url ?? null,
    redirects,
    signup,
    challenge,
    reporting,
    cookie_names_seen: cookieNamesSeen,
    response_header_names: responseHeaderNames,
    request_header_names: topCounts(classified.flatMap((e) => e.request_header_names), 80),
    risky_body_excerpts_present: riskyBodies,
    timeline: classified
      .filter((e) => e.category !== 'other' || e.status >= 400 || e.cookie_names.length > 0)
      .map((e) => ({
        idx: e.idx,
        phase: e.phase,
        method: e.method,
        status: e.status,
        category: e.category,
        key: e.key,
        cookies: e.cookie_names,
        body_signals: e.body_signals,
      })),
  };
}

function endpointSet(summary, categories) {
  const out = new Set();
  for (const e of summary.timeline ?? []) {
    if (categories.includes(e.category)) out.add(`${e.method ?? 'GET'} ${e.status ?? 'unknown'} ${e.key}`);
  }
  return out;
}

function compareSummaries(results) {
  const comparisons = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      const cats = ['signup', 'challenge', 'api'];
      const sa = endpointSet(a, cats);
      const sb = endpointSet(b, cats);
      comparisons.push({
        a: a.source,
        b: b.source,
        categories: cats,
        shared: [...sa].filter((k) => sb.has(k)).sort(),
        only_a: [...sa].filter((k) => !sb.has(k)).sort(),
        only_b: [...sb].filter((k) => !sa.has(k)).sort(),
      });
    }
  }
  return comparisons;
}

const sources = process.argv.slice(2);
if (sources.length === 0) usage();

mkdirSync(OUT_DIR, { recursive: true });
const results = [];
for (const source of sources) {
  const text = await readSource(source);
  const { entries, bad } = parseLines(text);
  results.push(summarize(source, entries, bad));
}

const out = {
  generated_at: new Date().toISOString(),
  sources: results,
  comparisons: compareSummaries(results),
};
const outPath = join(OUT_DIR, `linkedin_network_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));

for (const r of results) {
  console.log(`\n=== ${labelForSource(r.source)} ===`);
  console.log(`entries=${r.artifact_format.entries} bad_lines=${r.artifact_format.bad_lines}`);
  console.log(`format: request_headers=${r.artifact_format.has_request_headers} response_headers=${r.artifact_format.has_response_headers} body_excerpt=${r.artifact_format.has_response_body_excerpt}`);
  console.log(`statuses: ${r.status_counts.map((s) => `${s.value}:${s.count}`).join(', ')}`);
  console.log(`categories: ${r.category_counts.map((s) => `${s.value}:${s.count}`).join(', ')}`);
  console.log(`signup=${r.signup.length} challenge=${r.challenge.length} redirects=${r.redirects.length} reporting=${r.reporting.length}`);
  if (r.challenge.length) {
    console.log('challenge keys:');
    for (const e of r.challenge.slice(0, 20)) console.log(`  [${e.idx}] ${e.status} ${e.key} ${e.body_signals.join('|')}`);
  }
  if (r.cookie_names_seen.length) {
    console.log(`cookies set: ${r.cookie_names_seen.slice(0, 20).map((c) => `${c.value}:${c.count}`).join(', ')}`);
  }
}
if (out.comparisons.length) {
  console.log('\n=== comparisons: signup/challenge/api endpoints ===');
  for (const c of out.comparisons) {
    console.log(`\n${labelForSource(c.a)}  vs  ${labelForSource(c.b)}`);
    console.log(`shared=${c.shared.length} only_a=${c.only_a.length} only_b=${c.only_b.length}`);
    if (c.only_a.length) {
      console.log('only A:');
      for (const k of c.only_a.slice(0, 20)) console.log(`  ${k}`);
    }
    if (c.only_b.length) {
      console.log('only B:');
      for (const k of c.only_b.slice(0, 20)) console.log(`  ${k}`);
    }
  }
}
console.log(`\nwrote ${outPath}`);
