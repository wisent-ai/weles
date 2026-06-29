#!/usr/bin/env node
// Scan configured proxy provider filters through the production LinkedIn
// resolver path. This does not launch a browser. It runs the same preflight
// gates used by linkedin_register: CONNECT, exit IP, geo, known-burns, and
// LinkedIn /signup form-vs-challenge probe.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProxy } from '../../dist/proxy/config.js';

function loadDotEnv(path = '.env') {
  try {
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
  } catch {}
}

loadDotEnv();

const OUT_DIR = 'recordings/audits';
const filters = process.argv.slice(2).filter(Boolean);
const requested = filters.length
  ? filters
  : [
      'isp decodo us',
      'isp oxylabs us',
      'mobile oxylabs us',
      'residential brightdata us',
      'residential pingproxies us',
      'residential iproyal us',
      'residential packetstream us',
    ];

const persona = {
  os: 'macos',
  browser: 'chromium',
  chromeVersion: '148.0.7778.216',
  userAgentOs: 'Macintosh; Intel Mac OS X 10_15_7',
  acceptLanguage: 'en-US,en;q=0.9',
};

function latestPreflightPath(label) {
  return join(process.cwd(), 'recordings', process.env.WELES_RUN_ID || 'local', label, 'proxy_preflight.json');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const results = [];
for (const filter of requested) {
  const label = `linkedin_ip_candidate_${filter.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`;
  process.env.ACTION = 'linkedin_register';
  process.env.WELES_LABEL = label;
  process.env.WELES_PROXY_DIAGNOSTICS_LABEL = label;
  delete process.env.PROXY_SKIP_PREFLIGHT;
  console.log(`[scan] ${filter}`);
  const started = Date.now();
  const selected = await resolveProxy(filter, 'linkedin.com', persona).catch((e) => {
    console.log(`[scan] ${filter} error=${String(e?.message || e).slice(0, 120)}`);
    return null;
  });
  const preflight = readJson(latestPreflightPath(label));
  const attempts = Array.isArray(preflight?.attempts) ? preflight.attempts : [];
  const visibleAttempts = attempts.map((a) => ({
    display_name: a.display_name,
    provider: a.provider ?? null,
    proxy_type: a.proxy_type,
    country: a.country,
    endpoint: a.endpoint,
    connect_status: a.connect_status ?? null,
    exit_ip_present: a.exit_ip_present ?? null,
    exit_ip_hash: a.exit_ip_hash ?? null,
    geo_result: a.geo_result ?? null,
    geo_exit_cc: a.geo_exit_cc ?? null,
    linkedin_probe_result: a.linkedin_probe_result ?? null,
    linkedin_probe_bytes: a.linkedin_probe_bytes ?? null,
    linkedin_probe_body_markers: a.linkedin_probe_body_markers ?? null,
    rejected_reason: a.rejected_reason ?? null,
  }));
  const result = {
    filter,
    selected: !!selected,
    selected_provider: selected?.provider ?? null,
    selected_proxy_type: selected?.proxy_type ?? null,
    selected_endpoint: selected?.server ? selected.server.replace(/\/\/.*@/, '//<redacted>@') : null,
    selected_country: selected?.country ?? null,
    selected_exit_ip: selected?.exit_ip ?? null,
    selected_exit_reputation: selected?.exit_reputation ?? null,
    attempt_count: visibleAttempts.length,
    rejected_reasons: [...new Set(visibleAttempts.map((a) => a.rejected_reason).filter(Boolean))],
    attempts: visibleAttempts,
    duration_ms: Date.now() - started,
  };
  results.push(result);
  console.log(JSON.stringify({
    filter: result.filter,
    selected: result.selected,
    exit_ip: result.selected_exit_ip,
    reputation: result.selected_exit_reputation?.result ?? null,
    rejected_reasons: result.rejected_reasons,
    attempt_count: result.attempt_count,
  }));
}

mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generated_at: new Date().toISOString(),
  target: 'linkedin_register',
  target_host: 'linkedin.com',
  selected_candidates: results.filter((r) => r.selected).map((r) => ({
    filter: r.filter,
    exit_ip: r.selected_exit_ip,
    provider: r.selected_provider,
    proxy_type: r.selected_proxy_type,
    reputation: r.selected_exit_reputation,
  })),
  results,
};
const outPath = join(OUT_DIR, `linkedin_ip_candidate_scan_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ok: true,
  outPath,
  selected_candidates: report.selected_candidates,
  rejected_summary: results.map((r) => ({
    filter: r.filter,
    selected: r.selected,
    rejected_reasons: r.rejected_reasons,
    attempt_count: r.attempt_count,
  })),
}, null, 2));
