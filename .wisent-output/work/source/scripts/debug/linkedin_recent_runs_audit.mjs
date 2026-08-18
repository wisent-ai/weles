#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const OUT_DIR = 'recordings/audits';
const SUPABASE_URL = process.env.WELES_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.WELES_SUPABASE_SERVICE_ROLE_KEY ?? '';
const LIMIT = Number(process.env.LINKEDIN_RECENT_RUNS_LIMIT ?? process.argv[2] ?? 80);
const MAX_AGE_DAYS = Number(process.env.LINKEDIN_RECENT_RUNS_DAYS ?? process.argv[3] ?? 14);
const FIXTURE_PATH = process.env.LINKEDIN_RECENT_RUNS_FIXTURE ?? '';

const SECRETISH_RE = /password|passwd|credential|secret|token|cookie|authorization|apikey|api_key|proxy|email|phone|csrf|jsession|li_at|bcookie|bscookie/i;
const PUBLIC_RECORDINGS_RE = /\/storage\/v1\/object\/public\/recordings\//i;

function usage() {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/debug/linkedin_recent_runs_audit.mjs [limit=80] [days=14]\n       or LINKEDIN_RECENT_RUNS_FIXTURE=rows.json node scripts/debug/linkedin_recent_runs_audit.mjs');
  process.exit(2);
}

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function get(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!isObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function compactPath(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^recordings:\/\//.test(value)) return value.split('/').slice(-3).join('/');
  try {
    const u = new URL(value);
    return u.pathname.split('/').slice(-3).join('/');
  } catch {
    return basename(value);
  }
}

function artifactName(ref) {
  if (typeof ref !== 'string') return null;
  try {
    const u = new URL(ref);
    return basename(decodeURIComponent(u.pathname));
  } catch {
    return basename(ref);
  }
}

function artifactRefs(result) {
  const artifacts = get(result, 'artifacts');
  if (!isObject(artifacts)) return [];
  const refs = [];
  for (const key of ['screenshots', 'dom', 'logs']) {
    const values = Array.isArray(artifacts[key]) ? artifacts[key] : [];
    for (const ref of values) if (typeof ref === 'string') refs.push({ kind: key, ref, name: artifactName(ref) });
  }
  if (typeof artifacts.video === 'string') refs.push({ kind: 'video', ref: artifacts.video, name: artifactName(artifacts.video) });
  return refs;
}

function signalFromError(error) {
  const text = String(error ?? '');
  if (!text) return null;
  const checks = [
    ['http_429', /429|too many requests|rate.?limit/i],
    ['captcha', /captcha|recaptcha|hcaptcha|arkose|funcaptcha/i],
    ['checkpoint', /checkpoint|security check|verify/i],
    ['phone_verification', /phone|sms|verification/i],
    ['timeout', /timeout|timed out/i],
    ['proxy_error', /proxy|econnreset|etimedout|tunnel|socket hang up/i],
  ];
  return checks.find(([, rx]) => rx.test(text))?.[0] ?? 'error_present';
}

function statusAge(row) {
  const started = row.started_at ? new Date(row.started_at) : null;
  if (!started || Number.isNaN(started.getTime())) return null;
  return Math.round((Date.now() - started.getTime()) / 60_000);
}

function safeParams(params) {
  if (!isObject(params)) return { keys: [], secretish_keys: [] };
  const keys = Object.keys(params).sort();
  return {
    keys,
    secretish_keys: keys.filter((k) => SECRETISH_RE.test(k)),
  };
}

function safeSession(session) {
  if (!isObject(session)) return null;
  const browser = isObject(session.browser) ? session.browser : {};
  const launch = isObject(session.launch_metadata) ? session.launch_metadata : {};
  const persona = isObject(session.persona) ? session.persona : {};
  const proxyQuality = isObject(session.proxy_quality) ? session.proxy_quality : {};
  const proxySummary = isObject(proxyQuality.proxy) ? proxyQuality.proxy : {};
  const startup = isObject(session.startup_fingerprint_probe) ? session.startup_fingerprint_probe : {};
  const completeNetworkCapture = isObject(session.complete_network_capture) ? session.complete_network_capture : {};
  const diagnostics = isObject(session.browser_visible_diagnostics) ? session.browser_visible_diagnostics : {};
  const actionDiagnostics = isObject(session.action_diagnostics) ? session.action_diagnostics : {};
  const actionCounters = isObject(actionDiagnostics.counters) ? actionDiagnostics.counters : {};
  const actualCommandLine = isObject(launch.actual_command_line) ? launch.actual_command_line : {};
  const actualProcessTree = isObject(launch.actual_process_tree) ? launch.actual_process_tree : {};
  return {
    host: {
      platform: get(session, 'host_runtime.platform') ?? get(session, 'host.platform') ?? get(session, 'host.os') ?? null,
      release: get(session, 'host_runtime.release') ?? get(session, 'host.release') ?? null,
      arch: get(session, 'host_runtime.arch') ?? get(session, 'host.arch') ?? null,
      node: get(session, 'host_runtime.node') ?? get(session, 'host.node') ?? null,
    },
    browser: {
      version: session.browser_version ?? browser.version ?? null,
      path: compactPath(session.chromium_path) ?? compactPath(browser.path),
      executable_path: compactPath(get(launch, 'executable_path')) ?? compactPath(browser.executable_path),
    },
    persona: {
      os: persona.os ?? null,
      browser: persona.browser ?? null,
      locale: persona.locale ?? null,
      timezone: persona.timezone ?? null,
      platform: persona.platform ?? null,
      platform_version: persona.platformVersion ?? persona.platform_version ?? null,
    },
    launch: {
      actual_command_line_available: actualCommandLine.available === true || (Array.isArray(actualCommandLine.args) && actualCommandLine.args.length > 0),
      actual_command_line_error: actualCommandLine.error ?? null,
      profile_state: isObject(actualCommandLine.profile_state) ? {
        user_data_dir_present: actualCommandLine.profile_state.user_data_dir_present ?? null,
        root_entry_count: actualCommandLine.profile_state.root_entry_count ?? null,
        default_profile_exists: actualCommandLine.profile_state.default_profile_exists ?? null,
        default_entry_count: actualCommandLine.profile_state.default_entry_count ?? null,
        local_state_exists: actualCommandLine.profile_state.local_state_exists ?? null,
        preferences_exists: actualCommandLine.profile_state.preferences_exists ?? null,
        first_run_sentinel_exists: actualCommandLine.profile_state.first_run_sentinel_exists ?? null,
        extension_state_present: actualCommandLine.profile_state.extension_state_present ?? null,
        cache_state_present: actualCommandLine.profile_state.cache_state_present ?? null,
        profile_created_ago_ms: actualCommandLine.profile_state.profile_created_ago_ms ?? null,
        profile_modified_ago_ms: actualCommandLine.profile_state.profile_modified_ago_ms ?? null,
        profile_likely_fresh: actualCommandLine.profile_state.profile_likely_fresh ?? null,
      } : null,
      actual_process_tree_available: actualProcessTree.available === true || (Array.isArray(actualProcessTree.processes) && actualProcessTree.processes.length > 0),
      actual_process_tree_error: actualProcessTree.error ?? null,
      actual_command_line_risk_buckets: launch.actual_command_line_risk_buckets ?? null,
      intended_arg_count: Array.isArray(launch.args) ? launch.args.length : launch.intended_arg_count ?? null,
      actual_arg_count: launch.actual_command_line_arg_count ?? null,
      actual_process_tree_arg_count: launch.actual_process_tree_arg_count ?? null,
    },
    diagnostics,
    action_diagnostics: {
      present: !!actionDiagnostics && Object.keys(actionDiagnostics).length > 0,
      page_visible: actionDiagnostics.page_visible ?? null,
      counters: Object.fromEntries(Object.entries(actionCounters).filter(([, v]) => typeof v === 'number').sort(([a], [b]) => a.localeCompare(b))),
      risky_counters: Object.fromEntries(Object.entries(actionCounters).filter(([k, v]) => typeof v === 'number' && /(cdp_keyboard|page_evaluate|forced_click|postmessage|token|mutate|jsClick|captcha)/i.test(k)).sort(([a], [b]) => a.localeCompare(b))),
      recent_count: Array.isArray(actionDiagnostics.recent) ? actionDiagnostics.recent.length : null,
    },
    startup: {
      navigator_platform: get(startup, 'navigator.platform') ?? null,
      navigator_language: get(startup, 'navigator.language') ?? null,
      timezone: get(startup, 'intl.timezone') ?? get(startup, 'timezone') ?? null,
      webgl_vendor: get(startup, 'webgl.vendor') ?? get(startup, 'webgl.unmasked_vendor') ?? null,
      webgl_renderer: get(startup, 'webgl.renderer') ?? get(startup, 'webgl.unmasked_renderer') ?? null,
    },
    network: {
      exit_ip_status: isObject(session.exit_ip_probe) ? session.exit_ip_probe.ok ?? null : null,
      exit_ip_hash: typeof session.exit_ip === 'string' ? sha(session.exit_ip) : null,
      proxy_quality: {
        ok: proxyQuality.ok ?? null,
        inferred_ip_class: proxyQuality.inferred_ip_class ?? null,
        country: get(proxyQuality, 'ip_intel.country_code') ?? get(proxyQuality, 'ip_intel.country') ?? proxyQuality.country ?? null,
        timezone: get(proxyQuality, 'ip_intel.timezone') ?? proxyQuality.timezone ?? null,
        asn: get(proxyQuality, 'ip_intel.asn') ?? proxyQuality.asn ?? null,
        org: get(proxyQuality, 'ip_intel.org') ?? proxyQuality.org ?? null,
        risk_labels: proxyQuality.risk_labels ?? proxyQuality.risks ?? null,
        proxy: {
          ref_hash: proxySummary.ref_hash ?? null,
          endpoint_hash: proxySummary.endpoint_hash ?? null,
          sticky_id_hash: proxySummary.sticky_id_hash ?? null,
          username_hash_present: typeof proxySummary.username_hash === 'string',
          password_hash_present: typeof proxySummary.password_hash === 'string',
        },
      },
    },
    final_state: {
      current_url_hash: typeof session.current_url_hash === 'string' ? session.current_url_hash : null,
      current_url_redacted_present: typeof session.current_url === 'string' && !/^https?:\/\//i.test(session.current_url),
      page_closed: session.page_closed ?? null,
      closed_at: session.closed_at ?? null,
    },
    complete_network_capture: session.complete_network_capture ?? null,
    complete_network_evidence: isObject(completeNetworkCapture.network_evidence) ? {
      request_order_count: completeNetworkCapture.network_evidence.request_order_count ?? null,
      request_header_order_hint_count: completeNetworkCapture.network_evidence.request_header_order_hint_count ?? null,
      response_header_order_hint_count: completeNetworkCapture.network_evidence.response_header_order_hint_count ?? null,
      category_counts: completeNetworkCapture.network_evidence.category_counts ?? null,
      set_cookie_names: completeNetworkCapture.network_evidence.set_cookie_names ?? null,
      redirect_count: Array.isArray(completeNetworkCapture.network_evidence.redirects) ? completeNetworkCapture.network_evidence.redirects.length : null,
      endpoints: completeNetworkCapture.network_evidence.endpoints ?? null,
      body_safety: completeNetworkCapture.network_evidence.body_safety ?? null,
    } : null,
  };
}

function safeWorkerEnv(run) {
  const env = isObject(run?.worker_env) ? run.worker_env : null;
  if (!env) return null;
  const values = isObject(env.values) ? env.values : {};
  const flags = isObject(env.flags) ? env.flags : {};
  const expected = isObject(env.expected) ? env.expected : {};
  const selectedProxyRef = isObject(env.selected_proxy_ref) ? env.selected_proxy_ref : null;
  const proxyRefs = isObject(env.proxy_refs) ? env.proxy_refs : {};
  return {
    present: true,
    keys_checked_count: Array.isArray(env.keys_checked) ? env.keys_checked.length : null,
    proxy_configured: ['LINKEDIN_REGISTER_PROXY', 'WELES_LINKEDIN_PROXY', 'PROXY_URL'].some((key) => values[key] != null),
    params_proxy_override_present: env.params_proxy_override_present === true,
    proxy_kind: values.LINKEDIN_PROXY_KIND ?? values.WELES_LINKEDIN_PROXY_KIND ?? values.WELES_LINKEDIN_PROXY_MODE ?? null,
    selected_proxy_ref: selectedProxyRef ? {
      source: selectedProxyRef.source ?? null,
      ref_hash: selectedProxyRef.ref_hash ?? null,
      endpoint_hash: selectedProxyRef.endpoint_hash ?? null,
    } : null,
    proxy_refs: Object.fromEntries(Object.entries(proxyRefs)
      .filter(([, ref]) => isObject(ref))
      .map(([key, ref]) => [key, {
        present: ref.present === true,
        ref_hash: ref.ref_hash ?? null,
        endpoint_hash: ref.endpoint_hash ?? null,
      }])),
    expected: {
      proxy_country: expected.proxy_country ?? null,
      timezone: expected.timezone ?? null,
      language: expected.language ?? null,
      platform_version: expected.platform_version ?? null,
      architecture: expected.architecture ?? null,
    },
    diagnostics_flags: {
      page_instrumentation: flags.WELES_INSTRUMENT === true && flags.WELES_ALLOW_UNSAFE_PAGE_INSTRUMENTATION === true,
      passkey_stub: flags.WELES_PASSKEY_STUB === true,
      arkose_capture: flags.WELES_ARKOSE_CAPTURE === true,
      auth_fetch_capture: flags.WELES_AUTH_FETCH_CAPTURE === true,
      codec_shim: flags.WELES_CODEC_SHIM === true,
      chrome147_stubs: flags.WELES_ENABLE_CHROME147_STUBS === true,
      complete_network_disabled: flags.WELES_DISABLE_COMPLETE_NETWORK_CAPTURE === true,
      public_artifact_urls: flags.WELES_ARTIFACT_PUBLIC_URLS === true,
      register_storage_injection_allowed: flags.WELES_ALLOW_REGISTER_STORAGE_INJECTION === true,
      linkedin_direct_allowed: flags.WELES_ALLOW_LINKEDIN_DIRECT === true,
      linkedin_residential_allowed: flags.WELES_ALLOW_LINKEDIN_RESIDENTIAL === true,
      linkedin_undeclared_proxy_allowed: flags.WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY === true,
    },
  };
}

function coherenceCheck(session, workerEnv) {
  if (!session || !workerEnv) return null;
  const expected = workerEnv.expected ?? {};
  const checks = {
    proxy_country_matches: expected.proxy_country
      ? session.network?.proxy_quality?.country === expected.proxy_country
      : null,
    persona_timezone_matches: expected.timezone
      ? session.persona?.timezone === expected.timezone
      : null,
    startup_timezone_matches: expected.timezone
      ? session.startup?.timezone === expected.timezone
      : null,
    persona_language_matches: expected.language
      ? [session.persona?.locale, session.persona?.language].includes(expected.language)
      : null,
    startup_language_matches: expected.language
      ? session.startup?.navigator_language === expected.language
      : null,
    platform_version_present: expected.platform_version
      ? session.persona?.platform_version === expected.platform_version
      : null,
  };
  const applicable = Object.entries(checks).filter(([, value]) => value !== null);
  const mismatches = applicable.filter(([, value]) => value === false).map(([key]) => key);
  return {
    checks,
    applicable_count: applicable.length,
    mismatch_count: mismatches.length,
    mismatches,
    proved: applicable.length > 0 && mismatches.length === 0,
  };
}

function summarizeRow(row) {
  const result = isObject(row.result) ? row.result : {};
  const runResult = isObject(result.run) ? result.run : {};
  const refs = artifactRefs(result);
  const logs = refs.filter((r) => r.kind === 'logs').map((r) => r.name).filter(Boolean).sort();
  const session = safeSession(result.session);
  const workerEnv = safeWorkerEnv(runResult);
  const coherence = coherenceCheck(session, workerEnv);
  const banSignal = isObject(result.ban_signal) ? result.ban_signal : null;
  const summarized = {
    id: row.id,
    account_hash: row.account_id ? sha(row.account_id) : null,
    status: row.status,
    platform: row.platform,
    started_at: row.started_at,
    completed_at: row.completed_at,
    age_minutes: statusAge(row),
    claimed_by_hash: row.claimed_by ? sha(row.claimed_by) : null,
    params: safeParams(row.params),
    run: {
      worker_id_hash: get(result, 'run.worker_id') ? sha(get(result, 'run.worker_id')) : null,
      exit_code: get(result, 'run.exit_code') ?? null,
      trajectory_path: get(result, 'run.trajectory_path') ?? null,
      params_keys: get(result, 'run.params_keys') ?? null,
      worker_env: workerEnv,
      worker_session_coherence: coherence,
    },
    versions: isObject(result.versions) ? {
      weles_package_version: result.versions.weles_package_version ?? null,
      weles_git_commit: typeof result.versions.weles_git_commit === 'string' ? result.versions.weles_git_commit.slice(0, 12) : null,
      weles_git_dirty: result.versions.weles_git_dirty ?? null,
      trajectory_sha256: result.versions.trajectory_sha256 ?? null,
    } : null,
    ban_signal: banSignal ? {
      healthy: banSignal.healthy ?? null,
      signal: banSignal.signal ?? null,
      detail_keys: isObject(banSignal.details) ? Object.keys(banSignal.details).sort() : [],
    } : null,
    error_signal: signalFromError(row.error),
    session,
    artifacts: {
      total_refs: refs.length,
      public_refs: refs.filter((r) => PUBLIC_RECORDINGS_RE.test(r.ref)).length,
      private_refs: refs.filter((r) => /^recordings:\/\//.test(r.ref)).length,
      logs,
      has_network_ndjson: logs.includes('network.ndjson'),
      has_complete_network_ndjson: logs.includes('complete_network.ndjson'),
      has_session_meta_log: logs.includes('session_meta.json'),
      has_video: refs.some((r) => r.kind === 'video'),
      has_dom: refs.some((r) => r.kind === 'dom'),
      has_screenshot: refs.some((r) => r.kind === 'screenshots'),
      screenshot_count: refs.filter((r) => r.kind === 'screenshots').length,
    },
    coverage: {
      has_result_session: !!session,
      has_ban_signal: !!banSignal,
      has_proxy_quality: !!session?.network?.proxy_quality?.inferred_ip_class || !!session?.network?.proxy_quality?.asn,
      has_actual_command_line: !!session?.launch?.actual_command_line_available,
      has_profile_state: !!session?.launch?.profile_state,
      has_actual_process_tree: !!session?.launch?.actual_process_tree_available,
      has_startup_fingerprint: !!session?.startup && Object.values(session.startup).some((v) => v !== null && v !== undefined),
      has_complete_network_capture_meta: !!session?.complete_network_capture,
      has_complete_network_evidence_summary: !!session?.complete_network_evidence,
      has_uploaded_network: logs.includes('network.ndjson'),
      has_uploaded_complete_network: logs.includes('complete_network.ndjson'),
      has_action_diagnostics: !!session?.action_diagnostics?.present,
      has_non_page_visible_action_diagnostics: session?.action_diagnostics?.page_visible === false,
      has_risky_action_path_counters: !!session?.action_diagnostics?.risky_counters && Object.keys(session.action_diagnostics.risky_counters).length > 0,
      has_input_provenance_counters: !!session?.action_diagnostics?.counters
        && Object.keys(session.action_diagnostics.counters).some((key) => /(cdp_keyboard|os_keyboard|native_keyboard|input_provenance)/i.test(key)),
      has_private_artifact_refs: refs.length > 0 && refs.every((r) => /^recordings:\/\//.test(r.ref)),
      has_no_public_artifact_refs: refs.every((r) => !PUBLIC_RECORDINGS_RE.test(r.ref)),
      has_video: refs.some((r) => r.kind === 'video'),
      has_screenshot: refs.some((r) => r.kind === 'screenshots'),
      has_final_url_state: !!session?.final_state?.current_url_hash,
      has_worker_env: !!workerEnv?.present,
      has_worker_expected_coherence_pins: !!workerEnv
        && Object.values(workerEnv.expected).some((v) => v !== null && v !== undefined && v !== ''),
      has_worker_session_coherence: coherence?.proved === true,
      has_no_page_visible_worker_diagnostics: workerEnv
        ? !workerEnv.diagnostics_flags.page_instrumentation
          && !workerEnv.diagnostics_flags.passkey_stub
          && !workerEnv.diagnostics_flags.arkose_capture
          && !workerEnv.diagnostics_flags.auth_fetch_capture
          && !workerEnv.diagnostics_flags.codec_shim
          && !workerEnv.diagnostics_flags.chrome147_stubs
        : false,
    },
  };
  summarized.post_hardening_evidence = postHardeningEvidence(summarized);
  return summarized;
}

function postHardeningEvidence(row) {
  const required = {
    session: row.coverage.has_result_session,
    ban_signal: row.coverage.has_ban_signal,
    proxy_quality: row.coverage.has_proxy_quality,
    startup_fingerprint: row.coverage.has_startup_fingerprint,
    complete_network_capture_meta: row.coverage.has_complete_network_capture_meta,
    complete_network_evidence_summary: row.coverage.has_complete_network_evidence_summary,
    uploaded_network: row.coverage.has_uploaded_network,
    uploaded_complete_network: row.coverage.has_uploaded_complete_network,
    action_diagnostics: row.coverage.has_action_diagnostics,
    non_page_visible_action_diagnostics: row.coverage.has_non_page_visible_action_diagnostics,
    input_provenance_counters: row.coverage.has_input_provenance_counters,
    actual_process_tree: row.coverage.has_actual_process_tree,
    profile_state: row.coverage.has_profile_state,
    private_artifact_refs: row.coverage.has_private_artifact_refs,
    no_public_artifact_refs: row.coverage.has_no_public_artifact_refs,
    screenshot: row.coverage.has_screenshot,
    video: row.coverage.has_video,
    final_url_state: row.coverage.has_final_url_state,
    worker_env: row.coverage.has_worker_env,
    worker_expected_coherence_pins: row.coverage.has_worker_expected_coherence_pins,
    worker_session_coherence: row.coverage.has_worker_session_coherence,
    no_page_visible_worker_diagnostics: row.coverage.has_no_page_visible_worker_diagnostics,
  };
  const missing = Object.entries(required).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    ready_for_root_cause_analysis: missing.length === 0,
    missing,
    required,
  };
}

function countBy(rows, fn) {
  const counts = new Map();
  for (const row of rows) {
    const key = fn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function proxyReuseSummary(rows) {
  const selectedRef = (row) => row.run?.worker_env?.selected_proxy_ref
    ?? row.session?.network?.proxy_quality?.proxy
    ?? null;
  const withRef = rows.filter((row) => selectedRef(row)?.ref_hash);
  const byRefHash = countBy(withRef, (row) => selectedRef(row).ref_hash);
  const byEndpointHash = countBy(
    rows.filter((row) => selectedRef(row)?.endpoint_hash),
    (row) => selectedRef(row).endpoint_hash,
  );
  const failuresByRefHash = countBy(
    withRef.filter((row) => row.status === 'failed'),
    (row) => selectedRef(row).ref_hash,
  );
  const statusByRefHash = Object.fromEntries(Object.keys(byRefHash).sort().map((hash) => [hash, countBy(
    withRef.filter((row) => selectedRef(row).ref_hash === hash),
    (row) => row.status ?? 'unknown',
  )]));
  return {
    rows_with_selected_proxy_hash: withRef.length,
    unique_selected_proxy_hashes: Object.keys(byRefHash).length,
    selected_proxy_hash_counts: byRefHash,
    selected_proxy_endpoint_hash_counts: byEndpointHash,
    failed_rows_by_selected_proxy_hash: failuresByRefHash,
    status_counts_by_selected_proxy_hash: statusByRefHash,
    repeated_selected_proxy_hashes: Object.entries(byRefHash)
      .filter(([, count]) => count > 1)
      .map(([hash, count]) => ({ hash, count, failed: failuresByRefHash[hash] ?? 0 })),
  };
}

async function fetchRuns() {
  if (FIXTURE_PATH) {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.rows ?? [];
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) usage();
  const since = new Date(Date.now() - MAX_AGE_DAYS * 24 * 3600_000).toISOString();
  const params = new URLSearchParams({
    select: 'id,account_id,action,platform,params,status,result,error,started_at,completed_at,claimed_by,claimed_at',
    action: 'eq.linkedin_register',
    started_at: `gte.${since}`,
    order: 'started_at.desc.nullslast',
    limit: String(LIMIT),
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?${params}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase query failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

const rawRows = await fetchRuns();
const rows = rawRows.map(summarizeRow);
const report = {
  generated_at: new Date().toISOString(),
  source: FIXTURE_PATH ? 'fixture' : 'supabase_rest',
  fixture_path: FIXTURE_PATH || null,
  action: 'linkedin_register',
  window_days: MAX_AGE_DAYS,
  requested_limit: LIMIT,
  row_count: rows.length,
  redaction: {
    account_ids: 'sha256-prefix only',
    worker_ids: 'sha256-prefix only',
    params: 'keys only; values omitted',
    errors: 'regex-derived labels only; raw text omitted',
    artifacts: 'refs counted and filenames only; no artifact bodies fetched',
    proxy_exit_ip: 'sha256-prefix only when present',
    worker_proxy_refs: 'sha256-prefixes for exact proxy ref and credentialless endpoint only',
  },
  summary: {
    status_counts: countBy(rows, (r) => r.status ?? 'unknown'),
    ban_signal_counts: countBy(rows, (r) => r.ban_signal?.signal ?? 'missing'),
    error_signal_counts: countBy(rows, (r) => r.error_signal ?? 'none'),
    stale_running_over_60m: rows.filter((r) => r.status === 'running' && (r.age_minutes ?? 0) > 60).length,
    public_artifact_rows: rows.filter((r) => r.artifacts.public_refs > 0).length,
    private_artifact_rows: rows.filter((r) => r.artifacts.private_refs > 0).length,
    private_only_artifact_rows: rows.filter((r) => r.coverage.has_private_artifact_refs).length,
    no_public_artifact_rows: rows.filter((r) => r.coverage.has_no_public_artifact_refs).length,
    network_uploaded_rows: rows.filter((r) => r.artifacts.has_network_ndjson).length,
    complete_network_uploaded_rows: rows.filter((r) => r.artifacts.has_complete_network_ndjson).length,
    complete_network_evidence_summary_rows: rows.filter((r) => r.coverage.has_complete_network_evidence_summary).length,
    screenshot_rows: rows.filter((r) => r.artifacts.has_screenshot).length,
    video_rows: rows.filter((r) => r.artifacts.has_video).length,
    session_meta_rows: rows.filter((r) => r.coverage.has_result_session).length,
    proxy_quality_rows: rows.filter((r) => r.coverage.has_proxy_quality).length,
    actual_command_line_rows: rows.filter((r) => r.coverage.has_actual_command_line).length,
    profile_state_rows: rows.filter((r) => r.coverage.has_profile_state).length,
    actual_process_tree_rows: rows.filter((r) => r.coverage.has_actual_process_tree).length,
    startup_fingerprint_rows: rows.filter((r) => r.coverage.has_startup_fingerprint).length,
    final_url_state_rows: rows.filter((r) => r.coverage.has_final_url_state).length,
    worker_env_rows: rows.filter((r) => r.coverage.has_worker_env).length,
    worker_expected_coherence_pin_rows: rows.filter((r) => r.coverage.has_worker_expected_coherence_pins).length,
    worker_session_coherence_rows: rows.filter((r) => r.coverage.has_worker_session_coherence).length,
    no_page_visible_worker_diagnostics_rows: rows.filter((r) => r.coverage.has_no_page_visible_worker_diagnostics).length,
    action_diagnostics_rows: rows.filter((r) => r.coverage.has_action_diagnostics).length,
    non_page_visible_action_diagnostics_rows: rows.filter((r) => r.coverage.has_non_page_visible_action_diagnostics).length,
    input_provenance_counter_rows: rows.filter((r) => r.coverage.has_input_provenance_counters).length,
    post_hardening_evidence_ready_rows: rows.filter((r) => r.post_hardening_evidence.ready_for_root_cause_analysis).length,
    post_hardening_missing_counts: countBy(
      rows.flatMap((r) => r.post_hardening_evidence.missing.map((missing) => ({ missing }))),
      (r) => r.missing,
    ),
    proxy_reuse: proxyReuseSummary(rows),
  },
  rows,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `linkedin_recent_runs_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  row_count: report.row_count,
  status_counts: report.summary.status_counts,
  ban_signal_counts: report.summary.ban_signal_counts,
  coverage: {
    session_meta_rows: report.summary.session_meta_rows,
    proxy_quality_rows: report.summary.proxy_quality_rows,
    actual_command_line_rows: report.summary.actual_command_line_rows,
    profile_state_rows: report.summary.profile_state_rows,
    actual_process_tree_rows: report.summary.actual_process_tree_rows,
    complete_network_evidence_summary_rows: report.summary.complete_network_evidence_summary_rows,
    action_diagnostics_rows: report.summary.action_diagnostics_rows,
    input_provenance_counter_rows: report.summary.input_provenance_counter_rows,
    post_hardening_evidence_ready_rows: report.summary.post_hardening_evidence_ready_rows,
    network_uploaded_rows: report.summary.network_uploaded_rows,
    complete_network_uploaded_rows: report.summary.complete_network_uploaded_rows,
    private_only_artifact_rows: report.summary.private_only_artifact_rows,
    screenshot_rows: report.summary.screenshot_rows,
    video_rows: report.summary.video_rows,
    final_url_state_rows: report.summary.final_url_state_rows,
    worker_env_rows: report.summary.worker_env_rows,
    worker_expected_coherence_pin_rows: report.summary.worker_expected_coherence_pin_rows,
    worker_session_coherence_rows: report.summary.worker_session_coherence_rows,
    no_page_visible_worker_diagnostics_rows: report.summary.no_page_visible_worker_diagnostics_rows,
  },
}, null, 2));
