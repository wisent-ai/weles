#!/usr/bin/env node
// Production evidence pack for the LinkedIn register audit.
// By default this does not navigate to LinkedIn. Set WELES_EVIDENCE_RUN_LINKEDIN=1
// to request a linkedin_register attempt after a successful non-LinkedIn preflight.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const OUT_DIR = 'recordings/audits';
const TIMEOUT_MS = Number(process.env.WELES_EVIDENCE_TIMEOUT_MS ?? 240_000);
const RUN_LINKEDIN = process.env.WELES_EVIDENCE_RUN_LINKEDIN === '1';
const FORCE_LINKEDIN = process.env.WELES_EVIDENCE_FORCE_LINKEDIN === '1';
const SKIP_BROWSER = process.env.WELES_EVIDENCE_SKIP_BROWSER === '1';
const SKIP_GITHUB = process.env.WELES_EVIDENCE_SKIP_GITHUB === '1';
const SKIP_RECENT = process.env.WELES_EVIDENCE_SKIP_RECENT_RUNS === '1';
const FORCE_VALIDATE_LOCAL = process.env.WELES_EVIDENCE_VALIDATE_LOCAL === '1';

const proxySpec = process.argv[2]
  ?? process.env.LINKEDIN_REGISTER_PROXY
  ?? process.env.WELES_LINKEDIN_PROXY
  ?? process.env.PROXY_URL
  ?? '';

function redactValue(value) {
  if (value == null) return null;
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
  if (text.length > 160) return `${text.slice(0, 80)}...<${text.length} chars>`;
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

function envSnapshot() {
  const keys = [
    'LINKEDIN_REGISTER_PROXY',
    'WELES_LINKEDIN_PROXY',
    'PROXY_URL',
    'LINKEDIN_PROXY_KIND',
    'WELES_LINKEDIN_PROXY_KIND',
    'WELES_LINKEDIN_PROXY_MODE',
    'WELES_ALLOW_LINKEDIN_DIRECT',
    'WELES_ALLOW_LINKEDIN_RESIDENTIAL',
    'WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY',
    'LINKEDIN_PROXY_COUNTRY',
    'WELES_PROXY_COUNTRY',
    'WELES_EXPECTED_TIMEZONE',
    'WELES_EXPECTED_LANGUAGE',
    'WELES_CLIENT_HINTS_PLATFORM_VERSION',
    'WELES_MAC_PLATFORM_VERSION',
    'WELES_CLIENT_HINTS_ARCHITECTURE',
    'WELES_ENABLE_CHROME147_STUBS',
    'WELES_INSTRUMENT',
    'WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION',
    'WELES_PASSKEY_STUB',
    'WELES_ARKOSE_CAPTURE',
    'WELES_AUTH_FETCH_CAPTURE',
    'WELES_CODEC_SHIM',
    'WELES_DISABLE_COMPLETE_NETWORK_CAPTURE',
    'WELES_ARTIFACT_PUBLIC_URLS',
    'WELES_AUDIT_DEFER_NATIVE_SOURCE',
    'WELES_EVIDENCE_FORCE_LINKEDIN',
    'WELES_LINKEDIN_VALIDATE_GUARD_ONLY',
  ];
  return Object.fromEntries(keys.map((key) => [key, key.toLowerCase().includes('proxy') ? redactValue(process.env[key]) : process.env[key] ?? null]));
}

function runNode(script, args = [], opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      timeout: opts.timeout ?? TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        script,
        args: args.map((arg) => redactValue(arg)),
        ok: !error,
        exit_code: error?.code ?? 0,
        duration_ms: Date.now() - started,
        stdout_tail: redactText(stdout?.slice(-12_000) ?? ''),
        stderr_tail: redactText(stderr?.slice(-6_000) ?? ''),
        error: error ? redactText(String(error.message ?? error)).slice(0, 600) : null,
        parsed: parseLastJson(stdout),
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

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function commandResult(result) {
  return {
    script: result.script,
    args: result.args,
    ok: result.ok,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    outPath: result.parsed?.outPath ?? null,
    error: result.error,
    stdout_tail: result.stdout_tail,
    stderr_tail: result.stderr_tail,
    parsed: result.parsed,
  };
}

const results = [];
const preflightCommand = {
  name: 'preflight',
  script: 'scripts/debug/linkedin_preflight_audit.mjs',
  args: proxySpec ? [proxySpec] : [],
  env: {
    WELES_PREFLIGHT_SKIP_BROWSER: SKIP_BROWSER ? '1' : process.env.WELES_PREFLIGHT_SKIP_BROWSER,
    WELES_PREFLIGHT_SKIP_GITHUB: SKIP_GITHUB ? '1' : process.env.WELES_PREFLIGHT_SKIP_GITHUB,
  },
};

console.log(`[evidence-pack] ${preflightCommand.name}: ${preflightCommand.script}`);
const preflightResult = await runNode(preflightCommand.script, preflightCommand.args, {
  env: preflightCommand.env,
  timeout: preflightCommand.timeout,
});
results.push({ name: preflightCommand.name, ...commandResult(preflightResult) });

const preflight = results.find((result) => result.name === 'preflight')?.parsed;
const preflightAllowsLinkedinAttempt = preflight?.operationally_ready_for_linkedin_attempt === true;
const linkedinAttemptBlockedByPreflight = RUN_LINKEDIN && !FORCE_LINKEDIN && !preflightAllowsLinkedinAttempt;
const commands = [];

if (RUN_LINKEDIN && !linkedinAttemptBlockedByPreflight) {
  commands.push({
    name: 'linkedin_register',
    script: 'scripts/trajectories/linkedin_register.mjs',
    args: [],
    env: proxySpec && !process.env.LINKEDIN_REGISTER_PROXY ? { LINKEDIN_REGISTER_PROXY: proxySpec } : {},
    timeout: Number(process.env.WELES_EVIDENCE_LINKEDIN_TIMEOUT_MS ?? 900_000),
  });
}

if ((RUN_LINKEDIN && !linkedinAttemptBlockedByPreflight) || FORCE_VALIDATE_LOCAL) {
  commands.push({
    name: 'local_recording_audit',
    script: 'scripts/debug/linkedin_local_recording_audit.mjs',
    args: ['linkedin_register'],
  });
}

if (!SKIP_RECENT && (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  commands.push({
    name: 'recent_runs',
    script: 'scripts/debug/linkedin_recent_runs_audit.mjs',
    args: [
      process.env.WELES_EVIDENCE_RECENT_LIMIT ?? '120',
      process.env.WELES_EVIDENCE_RECENT_DAYS ?? '14',
    ],
  });
}

commands.push({
  name: 'requirements_matrix',
  script: 'scripts/debug/linkedin_audit_requirements_matrix.mjs',
  args: [],
});

for (const command of commands) {
  console.log(`[evidence-pack] ${command.name}: ${command.script}`);
  const result = await runNode(command.script, command.args, {
    env: command.env,
    timeout: command.timeout,
  });
  results.push({ name: command.name, ...commandResult(result) });
}

const recent = results.find((result) => result.name === 'recent_runs')?.parsed;
const matrix = results.find((result) => result.name === 'requirements_matrix')?.parsed;
const matrixReport = matrix?.outPath ? (readJson(matrix.outPath) ?? matrix) : matrix;
const matrixCompletion = matrixReport?.completion ?? matrix;
const matrixRequirements = Array.isArray(matrixReport?.matrix) ? matrixReport.matrix : [];
const warmSignupRequirement = matrixRequirements.find((item) => /Warm signup\/profile preconditioning/i.test(item?.requirement ?? ''));
const linkedin = results.find((result) => result.name === 'linkedin_register');
const localRecording = results.find((result) => result.name === 'local_recording_audit')?.parsed;
const dedicatedProxyDeclared = ['dedicated', 'dedicated_ip', 'static', 'static_ip'].includes(
  String(process.env.LINKEDIN_PROXY_KIND ?? process.env.WELES_LINKEDIN_PROXY_KIND ?? process.env.WELES_LINKEDIN_PROXY_MODE ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_'),
);

const report = {
  generated_at: new Date().toISOString(),
  scope: 'LinkedIn register production evidence pack',
  linkedin_navigation_requested: RUN_LINKEDIN,
  linkedin_navigation_attempted: !!linkedin,
  linkedin_attempt_blocked_by_preflight: linkedinAttemptBlockedByPreflight,
  force_linkedin_requested: FORCE_LINKEDIN,
  proxy_configured: !!proxySpec,
  dedicated_proxy_declared: dedicatedProxyDeclared,
  skipped: {
    browser_checks: SKIP_BROWSER,
    github_checks: SKIP_GITHUB,
    recent_runs: SKIP_RECENT || !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) || !process.env.SUPABASE_SERVICE_ROLE_KEY,
    linkedin_attempt: linkedinAttemptBlockedByPreflight ? 'preflight_not_operationally_ready' : null,
  },
  redaction: {
    proxy_urls: 'credentials redacted',
    env_values: 'proxy URLs redacted; secrets omitted',
    command_output: 'tail only; child scripts already redact their structured output',
  },
  env_snapshot: envSnapshot(),
  summary: {
    all_commands_ok: results.every((result) => result.ok),
    linkedin_attempt_ok: linkedin ? linkedin.ok : null,
    local_recording_complete: localRecording?.complete ?? null,
    local_recording_missing: localRecording?.missing ?? null,
    local_recording_warnings: localRecording?.warnings ?? null,
    preflight_allows_linkedin_attempt: preflightAllowsLinkedinAttempt,
    preflight_operationally_ready: preflight?.operationally_ready_for_linkedin_attempt ?? null,
    preflight_clean_for_attribution: preflight?.clean_enough_for_root_cause_attribution ?? null,
    dedicated_proxy_declared: dedicatedProxyDeclared,
    preflight_deferred_attribution_risks: preflight?.deferred_attribution_risks ?? [],
    preflight_attribution_blockers: preflight?.attribution_blockers ?? [],
    recent_ready_rows: recent?.coverage?.post_hardening_evidence_ready_rows
      ?? recent?.summary?.post_hardening_evidence_ready_rows
      ?? null,
    matrix_complete: matrixCompletion?.complete ?? null,
    matrix_status_counts: matrixCompletion?.status_counts ?? null,
    matrix_proved: matrixCompletion?.proved ?? [],
    matrix_not_proved: (matrixCompletion?.not_proved ?? []).map((item) => ({
      requirement: item.requirement,
      status: item.status,
      blockers: (item.blocking_checks ?? []).map((check) => check.summary),
    })),
    warm_signup_preconditioning: warmSignupRequirement ? {
      status: warmSignupRequirement.status,
      checks: (warmSignupRequirement.checks ?? []).map((check) => ({
        status: check.status,
        summary: check.summary,
      })),
    } : null,
  },
  required_followup: [
    !RUN_LINKEDIN ? 'Set WELES_EVIDENCE_RUN_LINKEDIN=1 for a controlled post-hardening LinkedIn attempt after preflight is acceptable.' : null,
    linkedinAttemptBlockedByPreflight ? 'LinkedIn trajectory was not run because preflight is not operationally ready; fix blockers or use WELES_EVIDENCE_FORCE_LINKEDIN=1 only for an intentional override.' : null,
    (FORCE_VALIDATE_LOCAL || !!linkedin) && localRecording?.complete === false ? 'Fix missing local linkedin_register recording evidence before interpreting or uploading the replay.' : null,
    preflight?.operationally_ready_for_linkedin_attempt === false ? 'Fix preflight operational blockers before spending another LinkedIn attempt.' : null,
    !dedicatedProxyDeclared ? 'Declare the exact proxy as dedicated/static with LINKEDIN_PROXY_KIND=dedicated or WELES_LINKEDIN_PROXY_KIND=dedicated before spending a LinkedIn attempt.' : null,
    preflight?.clean_enough_for_root_cause_attribution === false ? 'Attribution blockers or deferred native risks remain; do not blame proxy alone from a failed replay.' : null,
    !recent ? 'Run recent-runs audit with Supabase credentials after the controlled attempt finishes.' : null,
    (recent?.summary?.post_hardening_evidence_ready_rows ?? recent?.coverage?.post_hardening_evidence_ready_rows ?? 0) < 1
      ? 'Require at least one real production row with session, ban_signal, proxy_quality, startup probe, complete_network, action diagnostics, and actual process tree.'
      : null,
  ].filter(Boolean),
  results,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `linkedin_production_evidence_pack_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  linkedin_navigation_requested: RUN_LINKEDIN,
  linkedin_navigation_attempted: report.linkedin_navigation_attempted,
  linkedin_attempt_blocked_by_preflight: report.linkedin_attempt_blocked_by_preflight,
  all_commands_ok: report.summary.all_commands_ok,
  local_recording_complete: report.summary.local_recording_complete,
  local_recording_missing: report.summary.local_recording_missing,
  local_recording_warnings: report.summary.local_recording_warnings,
  preflight_allows_linkedin_attempt: report.summary.preflight_allows_linkedin_attempt,
  preflight_operationally_ready: report.summary.preflight_operationally_ready,
  preflight_clean_for_attribution: report.summary.preflight_clean_for_attribution,
  dedicated_proxy_declared: report.summary.dedicated_proxy_declared,
  preflight_deferred_attribution_risks: report.summary.preflight_deferred_attribution_risks,
  preflight_attribution_blockers: report.summary.preflight_attribution_blockers,
  recent_ready_rows: report.summary.recent_ready_rows,
  matrix_complete: report.summary.matrix_complete,
  matrix_status_counts: report.summary.matrix_status_counts,
  matrix_proved: report.summary.matrix_proved,
  warm_signup_preconditioning: report.summary.warm_signup_preconditioning,
  required_followup: report.required_followup,
}, null, 2));
