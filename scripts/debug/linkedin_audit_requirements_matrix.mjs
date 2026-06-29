#!/usr/bin/env node
// Requirement/evidence matrix for the full LinkedIn register flagging audit.
// Does not launch a browser and does not touch LinkedIn.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const OUT_DIR = 'recordings/audits';
const DEFER_NATIVE_SOURCE = process.env.WELES_AUDIT_DEFER_NATIVE_SOURCE === '1';

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function allReports(prefix) {
  if (!existsSync(OUT_DIR)) return null;
  return readdirSync(OUT_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(OUT_DIR, name);
      return { path, name, json: readJson(path) };
    });
}

function latest(prefix) {
  const reports = allReports(prefix) ?? [];
  const name = reports.at(-1)?.name;
  if (!name) return null;
  return reports.at(-1);
}

function isFixtureRecentReport(report) {
  const json = report?.json;
  if (!json) return false;
  if (json.source === 'fixture' || json.data_source === 'fixture' || json.fixture_path) return true;
  const firstId = json.rows?.[0]?.id;
  return typeof firstId === 'string' && /^0{8}-0{4}-4/.test(firstId);
}

function latestProductionRecentReport() {
  const reports = [
    ...(allReports('linkedin_recent_runs_audit_') ?? []),
    ...(allReports('linkedin_recent_runs_mcp_snapshot_') ?? []),
  ].sort((a, b) => a.name.localeCompare(b.name)).reverse();
  return reports.find((report) => !isFixtureRecentReport(report)) ?? null;
}

function localJsonReport(path) {
  if (!existsSync(path)) return null;
  return { path, name: basename(path), json: readJson(path) };
}

function get(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!isObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function bool(value) {
  return value === true;
}

function hasNoItems(value) {
  return Array.isArray(value) && value.length === 0;
}

function evidence(path, status, summary, details = {}) {
  return { path, status, summary, details };
}

function verdict(requirement, checks, decisiveCondition) {
  const statuses = checks.map((check) => check.status);
  let status = 'incomplete';
  if (statuses.every((s) => s === 'deferred' || s === 'proved')) status = statuses.includes('deferred') ? 'deferred' : 'proved';
  if (statuses.includes('contradicted')) status = 'contradicted';
  else if (statuses.includes('missing')) status = 'missing';
  else if (decisiveCondition(checks)) status = 'proved';
  return { requirement, status, checks };
}

const reports = {
  source: latest('chromium_source_provenance_audit_'),
  runtime: latest('chromium_runtime_provenance_'),
  patch: latest('chromium_patch_semantics_audit_'),
  baselineReadiness: latest('chrome_baseline_readiness_audit_'),
  chromeVsWeles: latest('chrome_vs_weles_'),
  network: latest('linkedin_network_audit_'),
  launch: latest('launch_runtime_audit_'),
  proxy: latest('proxy_quality_audit_'),
  dedicatedProxy: latest('linkedin_dedicated_proxy_readiness_audit_'),
  browserProxy: latest('browser_proxy_leak_audit_'),
  diagnostics: latest('diagnostics_pipeline_audit_'),
  action: latest('linkedin_action_surface_audit_'),
  eventProbe: latest('action_event_probe_'),
  recent: latestProductionRecentReport(),
  preflight: latest('linkedin_preflight_audit_'),
  warmSignup: localJsonReport(join('recordings', 'local', 'linkedin_register_warm', 'warm_signup_profile.json')),
};

function recentSummary(report) {
  const json = report?.json;
  if (!json) return {};
  if (isObject(json.summary)) return json.summary;
  const coverage = isObject(json.coverage) ? json.coverage : {};
  return {
    status_counts: json.status_counts ?? null,
    network_uploaded_rows: coverage.network_uploaded_rows ?? 0,
    complete_network_uploaded_rows: coverage.complete_network_uploaded_rows ?? 0,
    complete_network_evidence_summary_rows: coverage.complete_network_evidence_summary_rows ?? 0,
    screenshot_rows: coverage.screenshot_rows ?? 0,
    video_rows: coverage.video_rows ?? 0,
    private_only_artifact_rows: coverage.private_only_artifact_rows ?? 0,
    no_public_artifact_rows: coverage.no_public_artifact_rows ?? 0,
    session_meta_rows: coverage.result_session_rows ?? coverage.session_meta_rows ?? 0,
    proxy_quality_rows: coverage.proxy_quality_rows ?? 0,
    actual_command_line_rows: coverage.actual_command_line_rows ?? 0,
    profile_state_rows: coverage.profile_state_rows ?? 0,
    actual_process_tree_rows: coverage.actual_process_tree_rows ?? 0,
    startup_fingerprint_rows: coverage.startup_fingerprint_rows ?? 0,
    final_url_state_rows: coverage.final_url_state_rows ?? 0,
    action_diagnostics_rows: coverage.action_diagnostics_rows ?? 0,
    non_page_visible_action_diagnostics_rows: coverage.non_page_visible_action_diagnostics_rows ?? 0,
    post_hardening_evidence_ready_rows: json.post_hardening_evidence_ready_rows ?? 0,
    post_hardening_missing_counts: json.post_hardening_missing_counts ?? null,
  };
}

function actionHighFindings(report) {
  const json = report?.json;
  if (!json) return [];
  if (Array.isArray(json.active_high_findings)) {
    const active = [...json.active_high_findings];
    if (!DEFER_NATIVE_SOURCE && json.summary?.native_input_patch_source_required) active.push('native_input_patch_source_required');
    return [...new Set(active)];
  }
  if (Array.isArray(json.high_findings)) return json.high_findings;
  const summary = isObject(json.summary) ? json.summary : {};
  const findings = [];
  if (summary.has_cdp_keyboard) findings.push('cdp_keyboard');
  if (summary.has_playwright_mouse) findings.push('playwright_mouse');
  if (summary.has_js_dom_event_paths) findings.push('js_dispatched_events');
  if (summary.has_captcha_token_or_postmessage_paths) findings.push('captcha_postmessage_or_token');
  if (summary.native_input_patch_source_required) findings.push('native_input_patch_source_required');
  if (Array.isArray(json.findings)) {
    for (const finding of json.findings) {
      if (/high|critical/i.test(String(finding.severity ?? ''))) findings.push(finding.id ?? finding.title ?? 'high_action_finding');
    }
  }
  return [...new Set(findings)];
}

const matrix = [];

{
  const checks = [];
  const src = reports.source?.json;
  const sourceReviewed = bool(get(src, 'verdict.can_call_shipped_binary_source_reviewed')) || bool(src?.can_call_shipped_binary_source_reviewed);
  checks.push(reports.source
    ? evidence(reports.source.path, sourceReviewed ? 'proved' : (DEFER_NATIVE_SOURCE ? 'deferred' : 'contradicted'), sourceReviewed ? 'exact shipped source is proven' : (DEFER_NATIVE_SOURCE ? 'exact shipped source review deferred until source is available' : 'exact shipped source is not proven'), {
      blockers: get(src, 'verdict.blockers') ?? src?.blockers ?? [],
      exact_source_found: get(src, 'verdict.exact_source_found') ?? src?.exact_source_found ?? null,
    })
    : evidence(null, 'missing', 'source provenance report missing'));
  const runtimeClean = bool(reports.runtime?.json?.clean);
  checks.push(reports.runtime
    ? evidence(reports.runtime.path, runtimeClean ? 'proved' : (DEFER_NATIVE_SOURCE ? 'deferred' : 'contradicted'), runtimeClean ? 'runtime bundle scan is clean' : (DEFER_NATIVE_SOURCE ? 'runtime bundle cleanliness deferred with native source review' : 'runtime bundle scan is not clean'), {
      markers: reports.runtime.json?.markers ?? reports.runtime.json?.risky_markers ?? null,
    })
    : evidence(null, 'missing', 'runtime provenance report missing'));
  const patchClean = reports.patch?.json?.source_completeness === 'complete_current_generation'
    && hasNoItems(reports.patch?.json?.critical_risks ?? reports.patch?.json?.risks?.critical ?? []);
  checks.push(reports.patch
    ? evidence(reports.patch.path, patchClean ? 'proved' : (DEFER_NATIVE_SOURCE ? 'deferred' : 'contradicted'), patchClean ? 'patch semantics are complete and clean' : (DEFER_NATIVE_SOURCE ? 'patch semantics review deferred until source is available' : 'patch semantics are incomplete or risky'), {
      source_completeness: reports.patch.json?.source_completeness ?? null,
      risks: reports.patch.json?.risks ?? reports.patch.json?.critical_risks ?? null,
    })
    : evidence(null, 'missing', 'patch semantics report missing'));
  matrix.push(verdict(
    '1. Custom Chromium native patch',
    checks,
    (items) => items.every((item) => item.status === 'proved'),
  ));
}

{
  const cmp = reports.chromeVsWeles?.json;
  const valid = bool(get(cmp, 'comparability.valid_linkedin_baseline'));
  const readiness = reports.baselineReadiness?.json;
  const ready = bool(readiness?.ready_for_valid_linkedin_baseline);
  matrix.push(verdict('2. Real Chrome baseline comparison', [
    reports.baselineReadiness
      ? evidence(reports.baselineReadiness.path, ready ? 'proved' : 'incomplete', ready ? 'host is ready to run valid Chrome 147 baseline' : 'host is not ready to run valid Chrome 147 baseline', {
        blockers: readiness?.blockers ?? null,
        selected: readiness?.selected ?? null,
      })
      : evidence(null, 'missing', 'Chrome baseline readiness report missing'),
    reports.chromeVsWeles
      ? evidence(reports.chromeVsWeles.path, valid ? 'proved' : 'incomplete', valid ? 'valid same-version LinkedIn baseline exists' : 'latest Chrome/Weles comparison is not a valid LinkedIn baseline', {
        comparability: cmp?.comparability ?? null,
      })
      : evidence(null, 'missing', 'Chrome vs Weles baseline report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const summary = recentSummary(reports.recent);
  const recentReady = (summary.post_hardening_evidence_ready_rows ?? 0) > 0;
  const networkUploaded = (summary.network_uploaded_rows ?? 0) > 0;
  const completeUploaded = (summary.complete_network_uploaded_rows ?? 0) > 0;
  const completeSummaryRows = (summary.complete_network_evidence_summary_rows ?? 0) > 0;
  const networkAnalyzed = !!reports.network;
  matrix.push(verdict('3. LinkedIn-specific network behavior', [
    reports.recent
      ? evidence(reports.recent.path, recentReady && networkUploaded && completeUploaded && completeSummaryRows ? 'proved' : 'missing', recentReady && networkUploaded && completeUploaded && completeSummaryRows ? 'post-hardening production row has network, complete-network, and summarized network evidence' : 'no post-hardening production row with uploaded network.ndjson, complete_network.ndjson, and complete-network summary evidence', {
        ready_rows: summary.post_hardening_evidence_ready_rows ?? null,
        network_uploaded_rows: summary.network_uploaded_rows ?? null,
        complete_network_uploaded_rows: summary.complete_network_uploaded_rows ?? null,
        complete_network_evidence_summary_rows: summary.complete_network_evidence_summary_rows ?? null,
        missing_counts: summary.post_hardening_missing_counts ?? null,
      })
      : evidence(null, 'missing', 'recent-runs report missing'),
    networkAnalyzed
      ? evidence(reports.network.path, recentReady ? 'proved' : 'incomplete', recentReady ? 'LinkedIn network report can be correlated to post-hardening row' : 'latest network analysis is legacy or not correlated to post-hardening row')
      : evidence(null, 'missing', 'LinkedIn network analyzer report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const launch = reports.launch?.json;
  const summary = recentSummary(reports.recent);
  const prodTreeRows = (summary.actual_process_tree_rows ?? 0) > 0;
  const prodProfileRows = (summary.profile_state_rows ?? 0) > 0;
  const launchTree = bool(launch?.launch?.actual_process_tree_available) || bool(launch?.actual_process_tree_available);
  const launchProfile = !!(launch?.launch?.profile_state ?? launch?.profile_state);
  matrix.push(verdict('4. Playwright launch/runtime side effects', [
    reports.launch
      ? evidence(reports.launch.path, launchTree && launchProfile ? 'proved' : 'incomplete', launchTree && launchProfile ? 'launch audit captured actual process tree and profile state' : 'launch audit did not capture actual process tree and profile state', {
        risk_labels: launch?.risk_labels ?? null,
        profile_state: launch?.launch?.profile_state ?? launch?.profile_state ?? null,
      })
      : evidence(null, 'missing', 'launch runtime report missing'),
    reports.recent
      ? evidence(reports.recent.path, prodTreeRows && prodProfileRows ? 'proved' : 'missing', prodTreeRows && prodProfileRows ? 'production rows include actual process tree and profile state' : 'production rows do not include actual process tree and profile state', {
        actual_process_tree_rows: summary.actual_process_tree_rows ?? null,
        profile_state_rows: summary.profile_state_rows ?? null,
      })
      : evidence(null, 'missing', 'recent-runs report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const summary = recentSummary(reports.recent);
  const readyRows = summary.post_hardening_evidence_ready_rows ?? 0;
  const startupRows = summary.startup_fingerprint_rows ?? 0;
  const proxyRows = summary.proxy_quality_rows ?? 0;
  matrix.push(verdict('5. Runtime host coherence', [
    reports.recent
      ? evidence(reports.recent.path, readyRows > 0 && startupRows > 0 && proxyRows > 0 ? 'proved' : 'missing', readyRows > 0 ? 'production rows have host/startup/proxy coherence evidence' : 'production rows lack complete host/startup/proxy coherence evidence', {
        startup_fingerprint_rows: startupRows,
        proxy_quality_rows: proxyRows,
        ready_rows: readyRows,
      })
      : evidence(null, 'missing', 'recent-runs report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const summary = recentSummary(reports.recent);
  const proxyRisks = reports.proxy?.json?.risks ?? reports.proxy?.json?.risk_labels ?? [];
  const dedicatedReady = reports.dedicatedProxy?.json?.ready_for_dedicated_linkedin_run === true;
  const proxyReuse = isObject(summary.proxy_reuse) ? summary.proxy_reuse : {};
  const proxyReuseRows = proxyReuse.rows_with_selected_proxy_hash ?? 0;
  const browserRisks = reports.browserProxy?.json?.risk_labels ?? [];
  const browserExactProxyProved = reports.browserProxy?.json?.linkedin_relevance?.exact_linkedin_proxy_proved === true
    || bool(reports.browserProxy?.json?.proxy_configured)
    || reports.browserProxy?.json?.proxy_spec_present === true;
  matrix.push(verdict('6. Proxy and IP quality', [
    reports.proxy
      ? evidence(reports.proxy.path, hasNoItems(proxyRisks) ? 'proved' : 'contradicted', hasNoItems(proxyRisks) ? 'proxy quality report has no risks' : 'proxy quality report has risks', { risks: proxyRisks })
      : evidence(null, 'missing', 'proxy quality report missing'),
    reports.dedicatedProxy
      ? evidence(reports.dedicatedProxy.path, dedicatedReady ? 'proved' : 'incomplete', dedicatedReady ? 'dedicated/static proxy run gate is satisfied' : 'dedicated/static proxy run gate has blockers', { blockers: reports.dedicatedProxy.json?.blockers ?? null })
      : evidence(null, 'missing', 'dedicated/static proxy readiness report missing'),
    reports.browserProxy
      ? evidence(reports.browserProxy.path, browserExactProxyProved && hasNoItems(browserRisks) ? 'proved' : 'incomplete', browserExactProxyProved ? 'browser proxy/WebRTC report proved exact proxy path' : 'browser proxy/WebRTC report did not prove exact proxy path', { risk_labels: browserRisks, exact_linkedin_proxy_proved: browserExactProxyProved })
      : evidence(null, 'missing', 'browser proxy/WebRTC report missing'),
    reports.recent
      ? evidence(reports.recent.path, proxyReuseRows > 0 ? 'proved' : 'missing', proxyReuseRows > 0 ? 'production rows include selected proxy reuse hashes' : 'production rows lack selected proxy reuse/stickiness evidence', { proxy_reuse: proxyReuse })
      : evidence(null, 'missing', 'recent-runs report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const warm = reports.warmSignup?.json;
  const manifestPath = typeof warm?.manifest_path === 'string' ? warm.manifest_path : null;
  const manifest = manifestPath ? readJson(manifestPath) : null;
  const signup = warm?.signup ?? {};
  const storage = warm?.storage ?? {};
  const signupReady = signup.signup_ready === true &&
    /(^|\.)linkedin\.com\/signup/i.test(String(signup.url ?? '')) &&
    signup.page_key === 'd_registration-signup';
  const storageReady = (storage.linkedin_cookie_count ?? 0) > 0 &&
    (storage.cookie_count ?? 0) >= (storage.linkedin_cookie_count ?? 0) &&
    (storage.origin_count ?? 0) > 0;
  const manifestReady = manifest?.schema === 'linkedin_register_warm_profile.v1' &&
    manifest?.profile_dir === warm?.profile_dir &&
    !!manifest?.persona &&
    !!manifest?.proxy_replay?.server &&
    manifest?.proxy_replay?.username_present === true &&
    manifest?.proxy_replay?.password_present === true;
  matrix.push(verdict('7. Warm signup/profile preconditioning', [
    reports.warmSignup
      ? evidence(reports.warmSignup.path, signupReady ? 'proved' : 'incomplete', signupReady ? 'warm profile reaches normal LinkedIn signup form' : 'warm profile does not prove a normal signup landing', {
        created_at: warm?.created_at ?? null,
        profile_dir_present: Boolean(warm?.profile_dir),
        signup_url: signup.url ?? null,
        signup_page_key: signup.page_key ?? null,
        signup_ready: signup.signup_ready ?? null,
      })
      : evidence(null, 'missing', 'warm signup profile report missing'),
    manifestPath
      ? evidence(manifestPath, manifestReady ? 'proved' : 'incomplete', manifestReady ? 'warm manifest can replay the same profile, persona, and proxy credentials' : 'warm manifest is missing replay-critical profile/persona/proxy data', {
        schema: manifest?.schema ?? null,
        profile_dir_matches: manifest?.profile_dir === warm?.profile_dir,
        persona_present: Boolean(manifest?.persona),
        proxy_server_present: Boolean(manifest?.proxy_replay?.server),
        proxy_auth_present: manifest?.proxy_replay?.username_present === true && manifest?.proxy_replay?.password_present === true,
        proxy_metadata: manifest?.proxy_metadata ? {
          provider: manifest.proxy_metadata.provider ?? null,
          proxy_type: manifest.proxy_metadata.proxy_type ?? null,
          country: manifest.proxy_metadata.country ?? null,
          sticky_hash: manifest.proxy_metadata.sticky_hash ?? null,
        } : null,
      })
      : evidence(null, 'missing', 'warm replay manifest missing'),
    reports.warmSignup
      ? evidence(reports.warmSignup.path, storageReady ? 'proved' : 'incomplete', storageReady ? 'warm profile has LinkedIn cookies/origin storage before submit' : 'warm profile storage is still cold or incomplete', {
        cookie_count: storage.cookie_count ?? null,
        linkedin_cookie_count: storage.linkedin_cookie_count ?? null,
        origin_count: storage.origin_count ?? null,
        origins: Array.isArray(storage.origins) ? storage.origins.slice(0, 5) : null,
      })
      : evidence(null, 'missing', 'warm storage report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const diag = reports.diagnostics?.json;
  const decisive = Array.isArray(diag?.findings)
    ? diag.findings.every((f) => !/critical|high/i.test(String(f.severity ?? '')))
    : bool(diag?.overall_safe);
  matrix.push(verdict('8. Diagnostics capture pipeline', [
    reports.diagnostics
      ? evidence(reports.diagnostics.path, decisive ? 'proved' : 'incomplete', decisive ? 'diagnostics report proves no high-risk capture issues' : 'diagnostics report still has residual risks or requires production verification', {
        decisive_next_check: diag?.decisive_next_check ?? null,
        findings_count: Array.isArray(diag?.findings) ? diag.findings.length : null,
      })
      : evidence(null, 'missing', 'diagnostics pipeline report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const actionHigh = actionHighFindings(reports.action);
  const untrusted = reports.eventProbe?.json?.summary?.untrusted_count ?? reports.eventProbe?.json?.untrusted_count;
  matrix.push(verdict('9. Action layer / humanization', [
    reports.action
      ? evidence(reports.action.path, hasNoItems(actionHigh) ? 'proved' : 'incomplete', hasNoItems(actionHigh) ? 'static action audit has no high findings' : 'static action audit still has high findings', { high_findings: actionHigh })
      : evidence(null, 'missing', 'action surface report missing'),
    reports.eventProbe
      ? evidence(reports.eventProbe.path, untrusted === 0 ? 'proved' : 'contradicted', untrusted === 0 ? 'local event probe has no untrusted events' : 'local event probe observed untrusted events', { untrusted_count: untrusted, select_result: reports.eventProbe.json?.selectResult ?? reports.eventProbe.json?.select_result ?? null })
      : evidence(null, 'missing', 'action event probe report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const summary = recentSummary(reports.recent);
  const actionRows = summary.action_diagnostics_rows ?? 0;
  const nonPageRows = summary.non_page_visible_action_diagnostics_rows ?? 0;
  const actionHigh = actionHighFindings(reports.action);
  const captchaHigh = actionHigh.filter((id) => /captcha|arkose|passkey|webauthn|postmessage|token/i.test(id));
  matrix.push(verdict('10. Captcha / challenge handling', [
    reports.action
      ? evidence(reports.action.path, hasNoItems(captchaHigh) ? 'proved' : 'incomplete', hasNoItems(captchaHigh) ? 'static captcha/challenge audit has no high findings' : 'static captcha/challenge audit still has high findings', { high_findings: captchaHigh })
      : evidence(null, 'missing', 'action/captcha report missing'),
    reports.recent
      ? evidence(reports.recent.path, actionRows > 0 && nonPageRows > 0 ? 'proved' : 'missing', actionRows > 0 ? 'production rows have action diagnostics' : 'production rows lack LinkedIn action/captcha diagnostics', { action_diagnostics_rows: actionRows, non_page_visible_action_diagnostics_rows: nonPageRows })
      : evidence(null, 'missing', 'recent-runs report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

{
  const recent = reports.recent?.json;
  const summary = recentSummary(reports.recent);
  const readyRows = summary.post_hardening_evidence_ready_rows ?? 0;
  matrix.push(verdict('11. Production last-run evidence', [
    reports.recent
      ? evidence(reports.recent.path, readyRows > 0 ? 'proved' : 'missing', readyRows > 0 ? 'at least one production row is ready for root-cause analysis' : 'no production row is ready for root-cause analysis', {
        row_count: recent?.row_count ?? null,
        status_counts: summary.status_counts ?? null,
        missing_counts: summary.post_hardening_missing_counts ?? null,
      })
      : evidence(null, 'missing', 'recent-runs report missing'),
  ], (items) => items.every((item) => item.status === 'proved')));
}

const statusCounts = matrix.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] ?? 0) + 1;
  return acc;
}, {});

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Full LinkedIn register audit objective completion matrix; does not launch browser or touch LinkedIn',
  latest_reports: Object.fromEntries(Object.entries(reports).map(([key, value]) => [key, value ? basename(value.path) : null])),
  deferred: {
    native_source_review: DEFER_NATIVE_SOURCE,
  },
  completion: {
    complete: matrix.every((item) => item.status === 'proved'),
    status_counts: statusCounts,
    proved: matrix.filter((item) => item.status === 'proved').map((item) => item.requirement),
    not_proved: matrix.filter((item) => item.status !== 'proved').map((item) => ({
      requirement: item.requirement,
      status: item.status,
      blocking_checks: item.checks.filter((check) => check.status !== 'proved').map((check) => ({
        status: check.status,
        summary: check.summary,
        path: check.path,
      })),
    })),
  },
  matrix,
};

mkdirSync(OUT_DIR, { recursive: true });
const mode = DEFER_NATIVE_SOURCE ? 'deferred_native' : 'normal';
const outPath = join(OUT_DIR, `linkedin_audit_requirements_matrix_${mode}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  complete: report.completion.complete,
  status_counts: report.completion.status_counts,
  not_proved: report.completion.not_proved,
}, null, 2));
