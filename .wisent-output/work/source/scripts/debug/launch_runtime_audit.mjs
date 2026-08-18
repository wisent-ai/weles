#!/usr/bin/env node
// Launch/runtime side-effect audit. Does not touch LinkedIn.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';

const OUT_DIR = 'recordings/audits';
const LABEL = 'launch_runtime_audit';
const IDLE_MS = Number(process.env.WELES_LAUNCH_AUDIT_IDLE_MS ?? process.argv[2] ?? 12000);

function flagValue(args, prefix) {
  const arg = (args ?? []).find((a) => String(a).startsWith(prefix));
  return arg ? String(arg).slice(prefix.length) : null;
}

function hasFlag(args, pattern) {
  return (args ?? []).some((a) => pattern.test(String(a)));
}

function summarizeLaunch(meta) {
  const intended = Array.isArray(meta?.args) ? meta.args : [];
  const ignored = Array.isArray(meta?.ignore_default_args) ? meta.ignore_default_args : [];
  const actual = Array.isArray(meta?.actual_command_line?.args) ? meta.actual_command_line.args : [];
  const processTree = Array.isArray(meta?.actual_process_tree?.processes) ? meta.actual_process_tree.processes : [];
  const processTreeArgs = processTree.flatMap((p) => Array.isArray(p.args) ? p.args : []);
  const actualAvailable = !!meta?.actual_command_line?.available;
  const treeAvailable = !!meta?.actual_process_tree?.available;
  const sourceArgs = actualAvailable || treeAvailable ? [...actual, ...processTreeArgs] : intended;
  return {
    custom_binary: meta?.custom_binary ?? null,
    executable_path: meta?.executable_path ?? null,
    executable_exists: meta?.executable_exists ?? null,
    headless: meta?.headless ?? null,
    pid: meta?.pid ?? null,
    actual_command_line_available: actualAvailable,
    actual_command_line_source: meta?.actual_command_line?.source ?? null,
    actual_command_line_error: meta?.actual_command_line?.error ?? null,
    profile_state: meta?.actual_command_line?.profile_state ?? null,
    actual_process_tree_available: treeAvailable,
    actual_process_tree_source: meta?.actual_process_tree?.source ?? null,
    actual_process_tree_error: meta?.actual_process_tree?.error ?? null,
    intended_arg_count: intended.length,
    actual_arg_count: actual.length,
    actual_process_tree_count: processTree.length,
    actual_process_tree_arg_count: processTreeArgs.length,
    ignored_default_arg_count: ignored.length,
    intended_args: intended,
    ignored_default_args: ignored,
    actual_args: actual,
    actual_process_tree: processTree,
    risk_buckets: meta?.actual_command_line_risk_buckets ?? {},
    observed_or_intended_flags: {
      remote_debugging_pipe: hasFlag(sourceArgs, /--remote-debugging-pipe/),
      remote_debugging_port: flagValue(sourceArgs, '--remote-debugging-port='),
      user_data_dir_present: hasFlag(sourceArgs, /--user-data-dir=/),
      user_data_dir_redacted: flagValue(sourceArgs, '--user-data-dir='),
      no_startup_window: hasFlag(sourceArgs, /--no-startup-window/),
      no_first_run: hasFlag(sourceArgs, /--no-first-run/),
      disable_background_networking: hasFlag(sourceArgs, /--disable-background-networking/),
      disable_component_update: hasFlag(sourceArgs, /--disable-component-update/),
      disable_extensions: hasFlag(sourceArgs, /--disable-extensions/),
      disable_sync: hasFlag(sourceArgs, /--disable-sync/),
      metrics_recording_only: hasFlag(sourceArgs, /--metrics-recording-only/),
      weles_fingerprint: hasFlag(sourceArgs, /--weles-fingerprint=/),
      use_mock_keychain: hasFlag(sourceArgs, /--use-mock-keychain/),
      password_store_basic: hasFlag(sourceArgs, /--password-store=basic/),
      disable_blink_automation_controlled: hasFlag(sourceArgs, /--disable-blink-features=AutomationControlled/),
      enable_automation: hasFlag(sourceArgs, /--enable-automation/),
      start_stack_profiler: hasFlag(sourceArgs, /--start-stack-profiler/),
      file_url_path_alias: hasFlag(sourceArgs, /--file-url-path-alias=/),
    },
    context_options: meta?.context_options ?? null,
    launch_env: meta?.launch_env ?? null,
    fingerprint_config_client_hints: meta?.fingerprint_config_client_hints ?? null,
  };
}

async function collectIdleNetwork(page, idleMs) {
  const ctx = page.context();
  const cdp = await ctx.newCDPSession(page);
  const events = [];
  const redactUrl = (raw) => {
    try {
      const u = new URL(raw);
      u.username = '';
      u.password = '';
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return String(raw ?? '').slice(0, 300);
    }
  };
  cdp.on('Network.requestWillBeSent', (e) => {
    const url = e.request?.url ?? '';
    events.push({
      ts: Date.now(),
      phase: 'request',
      resource_type: e.type ?? null,
      initiator_type: e.initiator?.type ?? null,
      method: e.request?.method ?? null,
      url: redactUrl(url),
      host: (() => { try { return new URL(url).host; } catch { return null; } })(),
    });
  });
  cdp.on('Network.loadingFailed', (e) => {
    events.push({
      ts: Date.now(),
      phase: 'loading_failed',
      request_id: e.requestId,
      error_text: e.errorText ?? null,
      blocked_reason: e.blockedReason ?? null,
    });
  });
  await cdp.send('Network.enable').catch(() => {});
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.setContent('<!doctype html><title>weles launch runtime audit</title><body>idle</body>').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, idleMs));
  await cdp.detach().catch(() => {});
  const nonData = events.filter((e) => e.host && !['', '127.0.0.1', 'localhost'].includes(e.host));
  const hostCounts = {};
  for (const e of nonData) hostCounts[e.host] = (hostCounts[e.host] ?? 0) + 1;
  return {
    idle_ms: idleMs,
    event_count: events.length,
    external_request_count: nonData.filter((e) => e.phase === 'request').length,
    external_hosts: Object.entries(hostCounts).sort((a, b) => b[1] - a[1]).map(([host, count]) => ({ host, count })),
    events: nonData.slice(0, 80),
  };
}

function deriveRisks(launch, idleNetwork) {
  const flags = launch.observed_or_intended_flags;
  const risks = [];
  if (!launch.actual_command_line_available) risks.push('actual_command_line_unavailable');
  if (!launch.actual_process_tree_available) risks.push('actual_process_tree_unavailable');
  if (flags.remote_debugging_pipe || flags.remote_debugging_port) risks.push('playwright_remote_debugging_transport');
  if (flags.user_data_dir_present) risks.push('temporary_or_controlled_profile');
  if (flags.no_startup_window) risks.push('playwright_no_startup_window');
  if (flags.no_first_run) risks.push('first_run_suppressed');
  if (flags.disable_background_networking || flags.disable_component_update || flags.disable_sync || flags.disable_extensions) risks.push('quiet_browser_suppression_present');
  if (flags.metrics_recording_only) risks.push('metrics_behavior_changed');
  if (flags.disable_blink_automation_controlled || flags.enable_automation) risks.push('automation_flag_present');
  if (flags.start_stack_profiler || flags.file_url_path_alias) risks.push('chromium_debug_or_dev_flag_present');
  if (idleNetwork.external_request_count === 0) risks.push('no_idle_background_network_noise_observed');
  if (flags.weles_fingerprint) risks.push('weles_native_fingerprint_flag_present');
  if (launch.profile_state?.profile_likely_fresh === true) risks.push('fresh_or_sterile_profile_observed');
  if (launch.profile_state?.extension_state_present === false) risks.push('no_extension_state_observed');
  if (launch.profile_state?.cache_state_present === false) risks.push('no_cache_state_observed');
  return [...new Set(risks)];
}

const persona = generatePersona({
  country: process.env.LINKEDIN_PROXY_COUNTRY ?? process.env.WELES_PROXY_COUNTRY ?? 'US',
  os: 'macos',
  browser: 'chromium',
});

let sessionMeta = null;
let idleNetwork = null;
const s = await WSession.start({
  label: LABEL,
  proxy: 'direct',
  persona,
  injectStorage: false,
  record: false,
  passkeyStub: false,
  arkoseCapture: false,
  authFetchCapture: false,
  codecShim: false,
  pageInstrumentation: false,
  completeNetworkCapture: false,
});

try {
  idleNetwork = await collectIdleNetwork(s.page, IDLE_MS);
  sessionMeta = s.sessionMeta ?? null;
} finally {
  await s.close();
}

const launch = summarizeLaunch(sessionMeta?.launch_metadata ?? {});
const report = {
  generated_at: new Date().toISOString(),
  scope: 'Playwright/Weles launch runtime side effects; does not touch LinkedIn',
  host_runtime: sessionMeta?.host_runtime ?? null,
  persona: sessionMeta?.persona ?? null,
  browser_version: sessionMeta?.browser_version ?? null,
  chromium_path: sessionMeta?.chromium_path ?? null,
  browser_visible_diagnostics: sessionMeta?.browser_visible_diagnostics ?? null,
  storage_policy: sessionMeta?.storage_policy ?? null,
  complete_network_capture: sessionMeta?.complete_network_capture ?? null,
  startup_fingerprint_probe_present: !!sessionMeta?.startup_fingerprint_probe,
  launch,
  idle_network: idleNetwork,
};
report.risk_labels = deriveRisks(launch, idleNetwork);
report.linkedin_relevance = {
  actual_command_line_available: launch.actual_command_line_available,
  remote_debugging_transport: launch.observed_or_intended_flags.remote_debugging_pipe || !!launch.observed_or_intended_flags.remote_debugging_port,
  controlled_profile: launch.observed_or_intended_flags.user_data_dir_present,
  profile_likely_fresh: launch.profile_state?.profile_likely_fresh ?? null,
  profile_root_entry_count: launch.profile_state?.root_entry_count ?? null,
  profile_default_entry_count: launch.profile_state?.default_entry_count ?? null,
  first_run_suppressed: launch.observed_or_intended_flags.no_first_run,
  quiet_browser_suppression_present: report.risk_labels.includes('quiet_browser_suppression_present'),
  idle_background_noise_observed: idleNetwork.external_request_count > 0,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `launch_runtime_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  actual_command_line_available: launch.actual_command_line_available,
  actual_command_line_error: launch.actual_command_line_error,
  profile_state: launch.profile_state,
  observed_or_intended_flags: launch.observed_or_intended_flags,
  idle_external_request_count: idleNetwork.external_request_count,
  risk_labels: report.risk_labels,
}, null, 2));
