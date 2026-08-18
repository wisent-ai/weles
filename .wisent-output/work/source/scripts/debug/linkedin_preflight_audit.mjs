#!/usr/bin/env node
// Preflight audit before spending a LinkedIn register attempt.
// Runs local/non-LinkedIn checks and writes one summary report.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const OUT_DIR = 'recordings/audits';
const TIMEOUT_MS = Number(process.env.WELES_PREFLIGHT_TIMEOUT_MS ?? 180_000);
const SKIP_BROWSER = process.env.WELES_PREFLIGHT_SKIP_BROWSER === '1';
const SKIP_GITHUB = process.env.WELES_PREFLIGHT_SKIP_GITHUB === '1';
const DEFER_NATIVE_SOURCE = process.env.WELES_AUDIT_DEFER_NATIVE_SOURCE === '1';
const proxySpec = process.argv[2]
  ?? process.env.LINKEDIN_REGISTER_PROXY
  ?? process.env.WELES_LINKEDIN_PROXY
  ?? process.env.PROXY_URL
  ?? '';

function redactValue(value) {
  if (value == null) return value;
  const text = String(value);
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      u.username = u.username ? '<redacted>' : '';
      u.password = u.password ? '<redacted>' : '';
      return u.toString();
    } catch {
      return text.replace(/\/\/[^@/]+@/, '//<redacted>@');
    }
  }
  return text;
}

function redactText(value) {
  if (value == null) return value;
  let text = String(value);
  for (const secret of [
    proxySpec,
    process.env.LINKEDIN_REGISTER_PROXY,
    process.env.WELES_LINKEDIN_PROXY,
    process.env.PROXY_URL,
  ]) {
    if (secret) text = text.split(secret).join(redactValue(secret));
  }
  text = text.replace(/https?:\/\/[^@\s]+@/gi, (match) => {
    try {
      const u = new URL(`${match}example.invalid`);
      u.username = u.username ? '<redacted>' : '';
      u.password = u.password ? '<redacted>' : '';
      return `${u.protocol}//${u.username}${u.password ? `:${u.password}` : ''}@`;
    } catch {
      return 'http://<redacted>@';
    }
  });
  return text;
}

function runNode(script, args = [], opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      timeout: opts.timeout ?? TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        script,
        args: args.map((arg) => /^https?:\/\//i.test(String(arg)) ? redactValue(arg) : arg),
        ok: !error,
        exit_code: error?.code ?? 0,
        duration_ms: Date.now() - started,
        stdout: redactText(stdout?.slice(-8000) ?? ''),
        stderr: redactText(stderr?.slice(-4000) ?? ''),
        error: error ? redactText(String(error.message ?? error)).slice(0, 500) : null,
      });
    });
    child.on('error', (error) => {
      resolve({
        script,
        args: args.map((arg) => /^https?:\/\//i.test(String(arg)) ? redactValue(arg) : arg),
        ok: false,
        exit_code: -1,
        duration_ms: Date.now() - started,
        stdout: '',
        stderr: '',
        error: redactText(String(error.message ?? error)).slice(0, 500),
      });
    });
  });
}

function parseLastJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const start = trimmed.lastIndexOf('\n{');
  const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try { return JSON.parse(candidate); } catch { return null; }
}

function commandSummary(result) {
  const json = parseLastJson(result.stdout);
  return {
    script: result.script,
    ok: result.ok,
    duration_ms: result.duration_ms,
    outPath: json?.outPath ?? null,
    parsed: json,
    error: result.error,
  };
}

function deriveRisks(summaries) {
  const risks = [];
  const byScript = Object.fromEntries(summaries.map((s) => [s.script, s]));
  const source = byScript['scripts/debug/chromium_source_provenance_audit.mjs']?.parsed;
  if (source?.can_call_shipped_binary_source_reviewed === false) risks.push('native_source_not_proven');
  if (source?.blockers?.length) risks.push(...source.blockers.map((b) => `native_${b}`));
  const runtime = byScript['scripts/debug/chromium_runtime_provenance.mjs']?.parsed;
  if (runtime?.clean === false) risks.push('native_runtime_bundle_not_clean');
  const patch = byScript['scripts/debug/audit_chromium_patch_semantics.mjs']?.parsed;
  if (patch?.source_completeness === 'incomplete_or_mixed_generation') risks.push('native_patch_material_mixed_generation');
  const action = byScript['scripts/debug/audit_linkedin_action_surface.mjs']?.parsed;
  const actionFindings = Array.isArray(action?.active_high_findings)
    ? action.active_high_findings
    : action?.high_findings;
  if (actionFindings?.length) risks.push(...actionFindings.map((id) => `action_${id}`));
  const proxy = byScript['scripts/debug/proxy_quality_audit.mjs']?.parsed;
  if (proxy?.risks?.length) risks.push(...proxy.risks.map((id) => `proxy_${id}`));
  const dedicated = byScript['scripts/debug/linkedin_dedicated_proxy_readiness_audit.mjs']?.parsed;
  if (dedicated?.blockers?.length) risks.push(...dedicated.blockers.map((id) => `dedicated_${id}`));
  const leak = byScript['scripts/debug/browser_proxy_leak_audit.mjs']?.parsed;
  if (leak?.risk_labels?.length) risks.push(...leak.risk_labels.map((id) => `browser_${id}`));
  const launch = byScript['scripts/debug/launch_runtime_audit.mjs']?.parsed;
  if (launch?.risk_labels?.length) risks.push(...launch.risk_labels.map((id) => `launch_${id}`));
  return [...new Set(risks)].sort();
}

const commands = [
  ['scripts/debug/chromium_source_provenance_audit.mjs', [], SKIP_GITHUB ? { env: { WELES_SOURCE_PROVENANCE_SKIP_GITHUB: '1', GH_TOKEN: '', GITHUB_TOKEN: '' } } : {}],
  ['scripts/debug/chromium_runtime_provenance.mjs'],
  ['scripts/debug/audit_weles_chromium_patch.mjs'],
  ['scripts/debug/audit_chromium_patch_semantics.mjs'],
  ['scripts/debug/diagnostics_pipeline_audit.mjs'],
  ['scripts/debug/audit_linkedin_action_surface.mjs'],
  ['scripts/debug/linkedin_dedicated_proxy_readiness_audit.mjs', proxySpec ? [proxySpec] : []],
];

if (proxySpec) commands.push(['scripts/debug/proxy_quality_audit.mjs', [proxySpec]]);
if (!SKIP_BROWSER) {
  commands.push(['scripts/debug/launch_runtime_audit.mjs', ['4000']]);
  if (proxySpec) commands.push(['scripts/debug/browser_proxy_leak_audit.mjs', [proxySpec]]);
}

const results = [];
for (const [script, args = [], opts = {}] of commands) {
  console.log(`[preflight] ${script}`);
  results.push(await runNode(script, args, opts));
}

const summaries = results.map(commandSummary);
const failed = summaries.filter((s) => !s.ok).map((s) => s.script);
const risk_labels = deriveRisks(summaries);
const operationalBlockers = risk_labels.filter((r) => /^dedicated_|^proxy_|^browser_browser_uses_direct_ip|^browser_webrtc_direct_ip_leak|^browser_browser_exit_differs_from_node_proxy_exit/.test(r));
const nativeAttributionRisks = risk_labels.filter((r) => /^native_/.test(r));
const actionAttributionRisks = risk_labels.filter((r) => /^action_/.test(r));
const attributionBlockers = [
  ...(DEFER_NATIVE_SOURCE ? [] : nativeAttributionRisks),
  ...actionAttributionRisks,
];
const report = {
  generated_at: new Date().toISOString(),
  scope: 'LinkedIn register preflight; does not navigate to LinkedIn',
  proxy_configured: !!proxySpec,
  skipped: {
    browser_checks: SKIP_BROWSER,
    github_checks_requested_skip: SKIP_GITHUB,
  },
  deferred: {
    native_source_review: DEFER_NATIVE_SOURCE,
  },
  failed_commands: failed,
  risk_labels,
  operational_blockers: operationalBlockers,
  deferred_attribution_risks: DEFER_NATIVE_SOURCE ? nativeAttributionRisks : [],
  attribution_blockers: attributionBlockers,
  checks_completed: failed.length === 0,
  operationally_ready_for_linkedin_attempt: failed.length === 0 && operationalBlockers.length === 0,
  clean_enough_for_root_cause_attribution: failed.length === 0 && operationalBlockers.length === 0 && attributionBlockers.length === 0,
  summaries,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `linkedin_preflight_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  checks_completed: report.checks_completed,
  operationally_ready_for_linkedin_attempt: report.operationally_ready_for_linkedin_attempt,
  clean_enough_for_root_cause_attribution: report.clean_enough_for_root_cause_attribution,
  failed_commands: report.failed_commands,
  operational_blockers: report.operational_blockers,
  deferred_attribution_risks: report.deferred_attribution_risks,
  attribution_blockers: report.attribution_blockers,
  risk_labels: report.risk_labels,
  checks: summaries.map((s) => ({ script: s.script, ok: s.ok, outPath: s.outPath })),
}, null, 2));
