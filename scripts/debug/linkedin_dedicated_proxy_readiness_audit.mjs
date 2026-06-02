#!/usr/bin/env node
// Offline readiness gate for spending a LinkedIn register attempt through a
// dedicated/static proxy. Does not launch a browser and does not touch LinkedIn.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'recordings/audits';

const proxySpec = process.argv[2]
  ?? process.env.LINKEDIN_REGISTER_PROXY
  ?? process.env.WELES_LINKEDIN_PROXY
  ?? process.env.PROXY_URL
  ?? '';

function envFlag(name) {
  return process.env[name] === '1' || /^true$/i.test(String(process.env[name] ?? ''));
}

function redactValue(value) {
  if (value == null) return null;
  const text = String(value);
  if (/^(https?|socks[45]?):\/\//i.test(text)) {
    try {
      const u = new URL(text);
      u.username = u.username ? '<redacted>' : '';
      u.password = u.password ? '<redacted>' : '';
      return u.toString();
    } catch {
      return text.replace(/\/\/[^@/]+@/, '//<redacted>@');
    }
  }
  if (text.length > 160) return `${text.slice(0, 80)}...<${text.length} chars>`;
  return text;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function latest(prefix) {
  if (!existsSync(OUT_DIR)) return null;
  const name = readdirSync(OUT_DIR).filter((item) => item.startsWith(prefix) && item.endsWith('.json')).sort().at(-1);
  return name ? { path: join(OUT_DIR, name), json: readJson(join(OUT_DIR, name)) } : null;
}

function boolCheck(id, ok, evidence, severity = 'blocker') {
  return { id, ok, severity, evidence };
}

function normalizeKind(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

const declaration = normalizeKind(
  process.env.LINKEDIN_PROXY_KIND
  ?? process.env.WELES_LINKEDIN_PROXY_KIND
  ?? process.env.WELES_LINKEDIN_PROXY_MODE
);
const dedicatedValues = new Set(['dedicated', 'dedicated_ip', 'static', 'static_ip']);
const disallowedGenericValues = new Set(['residential', 'rotating', 'pool', 'shared', 'datacenter', 'mobile', 'unknown']);
const proxyLower = String(proxySpec).trim().toLowerCase();
const proxyPresent = !!proxyLower && proxyLower !== 'direct';
const proxyLooksExplicit = /^(https?|socks[45]?):\/\//i.test(proxySpec) || /^[^:\s]+:\d{2,5}$/.test(proxySpec);
const genericProxyToken = !/^(https?|socks[45]?):\/\//i.test(proxySpec)
  && /(residential|rotating|pool|shared|mobile|datacenter|direct)/i.test(proxySpec);
const country = process.env.LINKEDIN_PROXY_COUNTRY ?? process.env.WELES_PROXY_COUNTRY ?? '';
const timezone = process.env.WELES_EXPECTED_TIMEZONE ?? '';
const language = process.env.WELES_EXPECTED_LANGUAGE ?? '';
const platformVersion = process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION ?? process.env.WELES_MAC_PLATFORM_VERSION ?? '';
const latestProxyQuality = latest('proxy_quality_audit_');
const latestProxyRisks = latestProxyQuality?.json?.linkedin_relevance?.likely_risks
  ?? latestProxyQuality?.json?.risks
  ?? latestProxyQuality?.json?.risk_labels
  ?? [];

const checks = [
  boolCheck('proxy_configured', proxyPresent, {
    proxy_spec: proxySpec ? redactValue(proxySpec) : null,
    accepted_env: ['LINKEDIN_REGISTER_PROXY', 'WELES_LINKEDIN_PROXY', 'PROXY_URL'],
  }),
  boolCheck('proxy_not_direct', proxyPresent && proxyLower !== 'direct' && !envFlag('WELES_ALLOW_LINKEDIN_DIRECT'), {
    WELES_ALLOW_LINKEDIN_DIRECT: process.env.WELES_ALLOW_LINKEDIN_DIRECT ?? null,
  }),
  boolCheck('proxy_spec_explicit', proxyLooksExplicit, {
    proxy_spec: proxySpec ? redactValue(proxySpec) : null,
    reason: 'Use an explicit proxy URL or host:port, not a provider class token.',
  }),
  boolCheck('dedicated_proxy_declared', dedicatedValues.has(declaration), {
    declaration: declaration || null,
    accepted_env: ['LINKEDIN_PROXY_KIND', 'WELES_LINKEDIN_PROXY_KIND', 'WELES_LINKEDIN_PROXY_MODE'],
    accepted_values: [...dedicatedValues],
  }),
  boolCheck('generic_pool_not_declared', !disallowedGenericValues.has(declaration) && !genericProxyToken && !envFlag('WELES_ALLOW_LINKEDIN_RESIDENTIAL'), {
    declaration: declaration || null,
    proxy_spec: proxySpec ? redactValue(proxySpec) : null,
    WELES_ALLOW_LINKEDIN_RESIDENTIAL: process.env.WELES_ALLOW_LINKEDIN_RESIDENTIAL ?? null,
  }),
  boolCheck('proxy_country_pin_present', !!country, { LINKEDIN_PROXY_COUNTRY: process.env.LINKEDIN_PROXY_COUNTRY ?? null, WELES_PROXY_COUNTRY: process.env.WELES_PROXY_COUNTRY ?? null }),
  boolCheck('timezone_pin_present', !!timezone, { WELES_EXPECTED_TIMEZONE: timezone || null }),
  boolCheck('language_pin_present', !!language, { WELES_EXPECTED_LANGUAGE: language || null }),
  boolCheck('platform_version_pin_present', !!platformVersion, {
    WELES_CLIENT_HINTS_PLATFORM_VERSION: process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION ?? null,
    WELES_MAC_PLATFORM_VERSION: process.env.WELES_MAC_PLATFORM_VERSION ?? null,
  }),
  boolCheck('page_visible_instrumentation_off', !(envFlag('WELES_INSTRUMENT') && envFlag('WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION')), {
    WELES_INSTRUMENT: process.env.WELES_INSTRUMENT ?? null,
    WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION: process.env.WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION ?? null,
  }),
  boolCheck('page_visible_optional_stubs_off', ![
    'WELES_PASSKEY_STUB',
    'WELES_ARKOSE_CAPTURE',
    'WELES_AUTH_FETCH_CAPTURE',
    'WELES_CODEC_SHIM',
    'WELES_ENABLE_CHROME147_STUBS',
  ].some(envFlag), {
    WELES_PASSKEY_STUB: process.env.WELES_PASSKEY_STUB ?? null,
    WELES_ARKOSE_CAPTURE: process.env.WELES_ARKOSE_CAPTURE ?? null,
    WELES_AUTH_FETCH_CAPTURE: process.env.WELES_AUTH_FETCH_CAPTURE ?? null,
    WELES_CODEC_SHIM: process.env.WELES_CODEC_SHIM ?? null,
    WELES_ENABLE_CHROME147_STUBS: process.env.WELES_ENABLE_CHROME147_STUBS ?? null,
  }),
  boolCheck('complete_network_capture_enabled', !envFlag('WELES_DISABLE_COMPLETE_NETWORK_CAPTURE'), {
    WELES_DISABLE_COMPLETE_NETWORK_CAPTURE: process.env.WELES_DISABLE_COMPLETE_NETWORK_CAPTURE ?? null,
  }),
  boolCheck('artifact_refs_private', !envFlag('WELES_ARTIFACT_PUBLIC_URLS'), {
    WELES_ARTIFACT_PUBLIC_URLS: process.env.WELES_ARTIFACT_PUBLIC_URLS ?? null,
  }),
  boolCheck('register_storage_injection_disabled', !envFlag('WELES_ALLOW_REGISTER_STORAGE_INJECTION'), {
    WELES_ALLOW_REGISTER_STORAGE_INJECTION: process.env.WELES_ALLOW_REGISTER_STORAGE_INJECTION ?? null,
  }),
  boolCheck('undeclared_proxy_escape_hatch_disabled', !envFlag('WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY'), {
    WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY: process.env.WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY ?? null,
  }),
];

const warnings = [];
if (!latestProxyQuality) {
  warnings.push({
    id: 'proxy_quality_audit_not_run_yet',
    evidence: 'Run linkedin_preflight_audit with the exact proxy to collect IP class, geo, timezone, and direct-vs-exit proof before interpreting a LinkedIn result.',
  });
} else if (latestProxyRisks.length) {
  warnings.push({
    id: 'latest_proxy_quality_report_has_risks',
    path: latestProxyQuality.path,
    risks: latestProxyRisks,
  });
}

const blockers = checks.filter((check) => check.severity === 'blocker' && !check.ok).map((check) => check.id);
const report = {
  generated_at: new Date().toISOString(),
  scope: 'LinkedIn dedicated/static proxy readiness; offline; does not launch browser or touch LinkedIn',
  ready_for_dedicated_linkedin_run: blockers.length === 0,
  blockers,
  warnings,
  checks,
  proxy: {
    configured: proxyPresent,
    spec: proxySpec ? redactValue(proxySpec) : null,
    declaration: declaration || null,
    explicit: proxyLooksExplicit,
  },
  latest_proxy_quality_report: latestProxyQuality ? {
    path: latestProxyQuality.path,
    inferred_ip_class: latestProxyQuality.json?.inferred_ip_class ?? latestProxyQuality.json?.linkedin_relevance?.inferred_ip_class ?? null,
    country: latestProxyQuality.json?.ip_intel?.country_code ?? latestProxyQuality.json?.country ?? null,
    direct_equals_exit: latestProxyQuality.json?.direct_equals_exit ?? latestProxyQuality.json?.linkedin_relevance?.direct_equals_exit ?? null,
    risks: latestProxyRisks,
  } : null,
  env_snapshot: {
    LINKEDIN_REGISTER_PROXY: redactValue(process.env.LINKEDIN_REGISTER_PROXY),
    WELES_LINKEDIN_PROXY: redactValue(process.env.WELES_LINKEDIN_PROXY),
    PROXY_URL: redactValue(process.env.PROXY_URL),
    LINKEDIN_PROXY_KIND: process.env.LINKEDIN_PROXY_KIND ?? null,
    WELES_LINKEDIN_PROXY_KIND: process.env.WELES_LINKEDIN_PROXY_KIND ?? null,
    WELES_LINKEDIN_PROXY_MODE: process.env.WELES_LINKEDIN_PROXY_MODE ?? null,
    WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY: process.env.WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY ?? null,
    LINKEDIN_PROXY_COUNTRY: process.env.LINKEDIN_PROXY_COUNTRY ?? null,
    WELES_PROXY_COUNTRY: process.env.WELES_PROXY_COUNTRY ?? null,
    WELES_EXPECTED_TIMEZONE: process.env.WELES_EXPECTED_TIMEZONE ?? null,
    WELES_EXPECTED_LANGUAGE: process.env.WELES_EXPECTED_LANGUAGE ?? null,
    WELES_CLIENT_HINTS_PLATFORM_VERSION: process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION ?? null,
    WELES_MAC_PLATFORM_VERSION: process.env.WELES_MAC_PLATFORM_VERSION ?? null,
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `linkedin_dedicated_proxy_readiness_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  ready_for_dedicated_linkedin_run: report.ready_for_dedicated_linkedin_run,
  blockers: report.blockers,
  warnings: report.warnings.map((warning) => warning.id),
}, null, 2));
