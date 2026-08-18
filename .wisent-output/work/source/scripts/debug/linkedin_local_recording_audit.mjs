#!/usr/bin/env node
// Validate local recordings/linkedin_register evidence after a controlled run.
// Does not launch a browser and does not touch LinkedIn.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const OUT_DIR = 'recordings/audits';
const LABEL = process.env.WELES_RECORDING_LABEL ?? process.argv[2] ?? 'linkedin_register';
const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT ?? 'recordings';
const DIR = join(RECORDINGS_ROOT, LABEL);

const SECRET_RE = /password|passwd|authorization|proxy-authorization|cookie|set-cookie|li_at|bcookie|bscookie|csrf|token|credential|secret|g-recaptcha-response/i;

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function readText(path, max = 3_000_000) {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, max).toString('utf8');
  } catch {
    return '';
  }
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fileInfo(name) {
  const path = join(DIR, name);
  if (!existsSync(path)) return { name, path, exists: false };
  const st = statSync(path);
  return { name, path, exists: true, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
}

function files() {
  try { return readdirSync(DIR).sort(); } catch { return []; }
}

function countExt(names, ext) {
  return names.filter((name) => name.toLowerCase().endsWith(ext)).length;
}

function ndjsonStats(name) {
  const info = fileInfo(name);
  if (!info.exists) return { ...info, line_count: 0, phases: {}, secret_residual_hits: [] };
  const text = readText(info.path);
  const phases = {};
  const secretResidualHits = [];
  let lineCount = 0;
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    lineCount++;
    if (SECRET_RE.test(line) && !/<redacted>/i.test(line)) {
      secretResidualHits.push({ line: lineCount, hash: sha(line), excerpt: line.slice(0, 160) });
    }
    try {
      const parsed = JSON.parse(line);
      const phase = parsed.phase ?? parsed.event ?? 'unknown';
      phases[phase] = (phases[phase] ?? 0) + 1;
    } catch {
      phases.unparseable = (phases.unparseable ?? 0) + 1;
    }
  }
  return {
    ...info,
    line_count: lineCount,
    phases,
    secret_residual_hits: secretResidualHits.slice(0, 20),
  };
}

function visibleDiagnosticsOff(meta) {
  const d = isObject(meta?.browser_visible_diagnostics) ? meta.browser_visible_diagnostics : {};
  return {
    ok: ['page_instrumentation', 'passkey_stub', 'arkose_capture', 'auth_fetch_capture', 'codec_shim', 'chrome147_stubs']
      .every((key) => d[key] === false || d[key] == null),
    diagnostics: d,
  };
}

function localJsonSensitiveFiles(names) {
  return names
    .filter((name) => /^session_responses_.*\.json$/i.test(name) || /^environment_.*\.json$/i.test(name) || name === 'account.json')
    .map((name) => fileInfo(name));
}

const names = files();
const sessionMeta = readJson(join(DIR, 'session_meta.json'));
const banSignal = readJson(join(DIR, 'ban_signal.json'));
const loopHistory = readJson(join(DIR, 'loop_history.json'));
const completeMeta = readJson(join(DIR, 'complete_network.meta.json'));
const network = ndjsonStats('network.ndjson');
const completeNetwork = ndjsonStats('complete_network.ndjson');
const visible = visibleDiagnosticsOff(sessionMeta);
const localSensitive = localJsonSensitiveFiles(names);

const required = {
  recording_dir_exists: existsSync(DIR),
  session_meta: !!sessionMeta,
  ban_signal: !!banSignal,
  loop_history: Array.isArray(loopHistory),
  network_ndjson: network.exists && network.line_count > 0,
  complete_network_ndjson: completeNetwork.exists && completeNetwork.line_count > 0,
  complete_network_meta: !!completeMeta,
  complete_network_not_page_visible: completeMeta?.page_visible === false || sessionMeta?.complete_network_capture?.page_visible === false,
  complete_network_has_request_headers: !!completeNetwork.phases.request || !!completeNetwork.phases.request_extra,
  complete_network_has_responses: !!completeNetwork.phases.response || !!completeNetwork.phases.response_extra,
  complete_network_has_network_evidence_summary: !!completeMeta?.network_evidence
    && Array.isArray(completeMeta.network_evidence.request_order)
    && !!completeMeta.network_evidence.body_safety,
  browser_visible_diagnostics_off: visible.ok,
  register_storage_not_injected: sessionMeta?.storage_policy?.inject_storage === false && sessionMeta?.storage_injected === false,
  proxy_quality: !!sessionMeta?.proxy_quality?.inferred_ip_class || !!sessionMeta?.proxy_quality?.ip_intel || !!sessionMeta?.proxy_quality?.exit_ip_probe,
  startup_fingerprint_probe: !!sessionMeta?.startup_fingerprint_probe,
  action_diagnostics: sessionMeta?.action_diagnostics?.page_visible === false && isObject(sessionMeta?.action_diagnostics?.counters),
  actual_process_tree: sessionMeta?.launch_metadata?.actual_process_tree?.available === true
    || (Array.isArray(sessionMeta?.launch_metadata?.actual_process_tree?.processes) && sessionMeta.launch_metadata.actual_process_tree.processes.length > 0),
  final_url_redacted: typeof sessionMeta?.current_url_hash === 'string' && !/^https?:\/\//i.test(String(sessionMeta?.current_url ?? '')),
  video: names.some((name) => /\.(webm|mp4)$/i.test(name)),
};

const uploadable = {
  screenshots: countExt(names, '.png') + countExt(names, '.jpg') + countExt(names, '.jpeg'),
  videos: names.filter((name) => /\.(webm|mp4)$/i.test(name)).length,
  dom: countExt(names, '.html'),
  logs: names.filter((name) => /\.(ndjson|log)$/i.test(name)).length,
};

const warnings = [
  localSensitive.length ? 'local_sensitive_json_files_present_not_uploaded_by_default' : null,
  network.secret_residual_hits.length ? 'legacy_network_secret_terms_without_redaction_marker' : null,
  completeNetwork.secret_residual_hits.length ? 'complete_network_secret_terms_without_redaction_marker' : null,
  required.actual_process_tree ? null : 'actual_process_tree_missing_or_unavailable',
  required.video ? null : 'video_missing',
  required.complete_network_has_network_evidence_summary ? null : 'complete_network_network_evidence_summary_missing',
].filter(Boolean);

const missing = Object.entries(required).filter(([, ok]) => !ok).map(([key]) => key);
const report = {
  generated_at: new Date().toISOString(),
  scope: 'Local recordings evidence validator for linkedin_register; does not launch browser or touch LinkedIn',
  label: LABEL,
  dir: DIR,
  complete: missing.length === 0,
  required,
  missing,
  warnings,
  files: {
    total: names.length,
    uploadable,
    session_meta: fileInfo('session_meta.json'),
    ban_signal: fileInfo('ban_signal.json'),
    loop_history: fileInfo('loop_history.json'),
    network_ndjson: network,
    complete_network_ndjson: completeNetwork,
    complete_network_meta: fileInfo('complete_network.meta.json'),
    local_sensitive_json: localSensitive,
  },
  session_summary: sessionMeta ? {
    browser_version: sessionMeta.browser_version ?? null,
    chromium_path_present: !!sessionMeta.chromium_path,
    host_runtime: sessionMeta.host_runtime ?? null,
    persona: sessionMeta.persona ?? null,
    storage_policy: sessionMeta.storage_policy ?? null,
    browser_visible_diagnostics: visible.diagnostics,
    complete_network_capture: sessionMeta.complete_network_capture ?? null,
    proxy_quality: sessionMeta.proxy_quality ? {
      ok: sessionMeta.proxy_quality.ok ?? null,
      inferred_ip_class: sessionMeta.proxy_quality.inferred_ip_class ?? null,
      country: sessionMeta.proxy_quality.ip_intel?.country_code ?? sessionMeta.proxy_quality.country ?? null,
      asn: sessionMeta.proxy_quality.ip_intel?.connection?.asn ?? sessionMeta.proxy_quality.asn ?? null,
      risk_labels: sessionMeta.proxy_quality.risk_labels ?? sessionMeta.proxy_quality.risks ?? null,
    } : null,
    action_diagnostics: sessionMeta.action_diagnostics ? {
      page_visible: sessionMeta.action_diagnostics.page_visible ?? null,
      counters: sessionMeta.action_diagnostics.counters ?? null,
      recent_count: Array.isArray(sessionMeta.action_diagnostics.recent) ? sessionMeta.action_diagnostics.recent.length : null,
    } : null,
    launch: sessionMeta.launch_metadata ? {
      actual_command_line_available: sessionMeta.launch_metadata.actual_command_line?.available ?? null,
      actual_process_tree_available: sessionMeta.launch_metadata.actual_process_tree?.available ?? null,
      actual_process_tree_error: sessionMeta.launch_metadata.actual_process_tree?.error ?? null,
      risk_buckets: sessionMeta.launch_metadata.actual_command_line_risk_buckets ?? null,
    } : null,
  } : null,
  ban_signal: banSignal ? {
    healthy: banSignal.healthy ?? null,
    signal: banSignal.signal ?? null,
    detail_keys: isObject(banSignal.details) ? Object.keys(banSignal.details).sort() : [],
  } : null,
  loop_history: Array.isArray(loopHistory) ? {
    steps: loopHistory.length,
    tools: [...new Set(loopHistory.map((h) => h?.tool).filter(Boolean))].sort(),
  } : null,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `linkedin_local_recording_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  complete: report.complete,
  missing,
  warnings,
  uploadable,
  ban_signal: report.ban_signal?.signal ?? null,
}, null, 2));
