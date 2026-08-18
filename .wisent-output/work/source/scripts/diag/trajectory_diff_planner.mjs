#!/usr/bin/env node
/**
 * Read-only trajectory diff planner.
 *
 * Given a Weles console testing URL, fetches the trajectory run rows from the
 * console API, partitions completed vs failed cohorts, and reports:
 *   - current dominant failure buckets
 *   - discriminator fields separating failures from completed runs
 *   - nearest observed completed run for each failure bucket
 *   - evidence gaps that prevent automatic attribution
 *
 * It does not launch browsers, run trajectories, or mutate console state.
 */
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_SOURCE = 'https://console.wisent.com/weles/testing/linkedin_register';
const SENSITIVE_KEY_RE = /password|passwd|pwd|secret|token|cookie|csrf|email|phone|first.?name|last.?name|username/i;
const RUNNING_STALE_MS = 2 * 3600_000;

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
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
}

loadDotEnv();

function usage() {
  console.log(`Usage:
  node scripts/diag/trajectory_diff_planner.mjs [console-testing-url] [options]

Options:
  --json          Emit machine-readable JSON.
  --all           Fetch /weles/testing and plan every listed trajectory.
  --limit=N       Rows to fetch from /api/weles/testing/<action>. Default: 200.
  --max-actions=N In --all mode, cap actions analyzed. Default: no cap.
  --cookie=...    Console auth cookie. Defaults to WELES_CONSOLE_COOKIE.
  --token=...     Console diagnostics bearer token. Defaults to WELES_CONSOLE_API_TOKEN.

Example:
  node scripts/diag/trajectory_diff_planner.mjs https://console.wisent.com/weles/testing/linkedin_register`);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function sanitizeText(value, max = 220) {
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
    return sanitizeText(raw);
  }
}

function safeValue(key, value) {
  if (value === undefined || value === null) return '';
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (/proxy|url|host|server/i.test(key)) return sanitizeUrl(value);
    return sanitizeText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? sanitizeText(JSON.stringify(value.slice(0, 4))) : '';
  if (typeof value === 'object') return sanitizeText(JSON.stringify(value));
  return sanitizeText(value);
}

function hostFromUrl(value) {
  try { return new URL(value).host; } catch { return ''; }
}

function actionFromTestingUrl(source) {
  const u = new URL(source);
  const m = u.pathname.match(/^\/weles\/testing\/(.+)$/);
  if (!m) throw new Error(`source must be /weles/testing/<action>: ${source}`);
  return decodeURIComponent(m[1]);
}

function apiUrlFor(source, limit) {
  const u = new URL(source);
  const action = actionFromTestingUrl(source);
  const api = new URL(`/api/weles/testing/${encodeURIComponent(action)}`, `${u.protocol}//${u.host}`);
  api.searchParams.set('limit', String(limit));
  return api.toString();
}

function consoleHeaders(options) {
  const headers = { accept: 'application/json' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return headers;
}

function consoleHtmlHeaders(options) {
  const headers = { accept: 'text/html' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return headers;
}

async function fetchJson(url, options) {
  const res = await fetch(url, { headers: consoleHeaders(options) });
  const text = await res.text();
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText}: ${sanitizeUrl(url)} body=${sanitizeText(text, 300)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON from ${sanitizeUrl(url)}: ${e.message}`);
  }
}

async function fetchText(url, options) {
  const res = await fetch(url, { headers: consoleHtmlHeaders(options) });
  const text = await res.text();
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText}: ${sanitizeUrl(url)} body=${sanitizeText(text, 300)}`);
  return text;
}

function testingIndexUrl(source) {
  const u = new URL(source);
  if (/^\/weles\/testing\/.+/.test(u.pathname)) return new URL('/weles/testing', `${u.protocol}//${u.host}`).toString();
  if (u.pathname === '/weles/testing') return u.toString();
  return new URL('/weles/testing', `${u.protocol}//${u.host}`).toString();
}

async function fetchActionsFromTestingIndex(source, options) {
  const indexUrl = testingIndexUrl(source);
  const html = await fetchText(indexUrl, options);
  const actions = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/weles\/testing\/([^"'<>?#\s]+)/g)) {
    const action = decodeURIComponent(m[1]);
    if (!action || seen.has(action)) continue;
    seen.add(action);
    actions.push(action);
  }
  return { indexUrl, actions };
}

function sourceForAction(source, action) {
  const u = new URL(source);
  return new URL(`/weles/testing/${encodeURIComponent(action)}`, `${u.protocol}//${u.host}`).toString();
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function banSignal(row) {
  const result = objectOrNull(row?.result) ?? {};
  return objectOrNull(row?.ban_signal) ?? objectOrNull(result.ban_signal);
}

function details(row) {
  return objectOrNull(banSignal(row)?.details) ?? {};
}

function runSignal(row) {
  return String(banSignal(row)?.signal ?? '').toLowerCase();
}

function runStatus(row) {
  return String(row?.status ?? '').toLowerCase();
}

function isRunningish(row) {
  const status = runStatus(row);
  if (['completed', 'failed', 'pending_review'].includes(status)) return false;
  return ['running', 'in_progress'].includes(status) || (!status && /running/.test(runSignal(row)));
}

function claimAgeMs(row) {
  if (!row?.claimed_at) return Infinity;
  const t = Date.parse(row.claimed_at);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

function runAgeMs(row) {
  const raw = row?.started_at ?? row?.scheduled_at;
  if (!raw) return Infinity;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

function isPending(row) {
  return ['queued', 'pending'].includes(runStatus(row)) || /pending/.test(runSignal(row));
}

function isActiveRunning(row) {
  if (!isRunningish(row)) return false;
  if (!row?.claimed_by || !row?.claimed_at) return false;
  const age = claimAgeMs(row);
  return age >= 0 && age <= RUNNING_STALE_MS;
}

function isStaleRunning(row) {
  if (!isRunningish(row) || isActiveRunning(row)) return false;
  if (!row?.claimed_by || !row?.claimed_at) return runAgeMs(row) > RUNNING_STALE_MS;
  return claimAgeMs(row) > RUNNING_STALE_MS;
}

function failureReasons(row) {
  if (runStatus(row) === 'failed' && (/orphaned/i.test(row?.error ?? '') || /running/.test(runSignal(row)))) {
    return [{ code: 'orphaned_running', message: sanitizeText(row?.error ?? 'running row was closed as orphaned') }];
  }
  if (isStaleRunning(row)) {
    const claimed = row?.claimed_by ? `claimed_by=${sanitizeText(row.claimed_by)}` : 'unclaimed';
    return [{ code: 'orphaned_running', message: `${claimed}; no active claim inside worker stale window` }];
  }
  const fromRow = Array.isArray(row?.failure_reasons) ? row.failure_reasons : [];
  const fromDetails = Array.isArray(details(row).failure_reasons) ? details(row).failure_reasons : [];
  const raw = fromRow.length ? fromRow : fromDetails;
  const reasons = raw
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      code: typeof r.code === 'string' && r.code ? r.code : 'unclassified',
      message: sanitizeText(r.message ?? '', 300),
    }));
  if (reasons.length) return reasons;
  const sig = banSignal(row)?.signal;
  if (sig && sig !== 'healthy') return [{ code: sig, message: '' }];
  if (row?.status === 'failed') return [{ code: 'failed_without_reason', message: '' }];
  return [];
}

function isCompleted(row) {
  const sig = banSignal(row);
  const signal = String(sig?.signal ?? '').toLowerCase();
  return row?.status === 'completed' ||
    sig?.healthy === true ||
    ['healthy', 'completed', 'keeper_completed', 'no_proxy_clean_pass'].includes(signal);
}

function isInProgress(row) {
  return isActiveRunning(row);
}

function executionMode(row) {
  const params = objectOrNull(row?.params) ?? {};
  const versions = objectOrNull(row?.versions) ?? objectOrNull(row?.result?.versions) ?? {};
  const path = String(versions.trajectory_path ?? '');
  if (params.keeper === true || typeof params.keeper_session === 'string' || path.includes('/keeper/')) return 'keeper';
  if (/real_chrome/i.test(path) || row?.session?.real_chrome) return 'real_chrome';
  return 'worker';
}

function artifactCounts(row) {
  const artifacts = objectOrNull(row?.artifacts) ?? objectOrNull(row?.result?.artifacts) ?? {};
  const count = (value) => Array.isArray(value) ? value.length : value ? 1 : 0;
  const logs = Array.isArray(artifacts.logs) ? artifacts.logs : [];
  return {
    screenshots: count(artifacts.screenshots),
    dom: count(artifacts.dom),
    video: count(artifacts.video) + count(artifacts.videos),
    logs: logs.length,
    network: logs.filter((u) => /network|complete_network/i.test(String(u))).length,
  };
}

function screenString(persona) {
  const screen = objectOrNull(persona?.screen);
  if (!screen) return '';
  const width = screen.width ?? '';
  const height = screen.height ?? '';
  const dpr = screen.dpr ?? '';
  return width || height || dpr ? `${width}x${height}@${dpr}` : '';
}

function rowVector(row) {
  const session = objectOrNull(row?.session) ?? objectOrNull(row?.result?.session) ?? {};
  const persona = objectOrNull(session.persona) ?? {};
  const browserProvenance = objectOrNull(session.browser_provenance) ?? {};
  const params = objectOrNull(row?.params) ?? {};
  const versions = objectOrNull(row?.versions) ?? objectOrNull(row?.result?.versions) ?? {};
  const capture = objectOrNull(row?.capture_summary);
  const artifacts = artifactCounts(row);
  const stageEvents = Array.isArray(row?.stage_events) ? row.stage_events : Array.isArray(details(row).stage_events) ? details(row).stage_events : [];
  const lastStage = stageEvents.length ? stageEvents[stageEvents.length - 1]?.stage : '';
  const proxyRequested = session.proxy_requested ?? params.proxy_url_override ?? params.proxy ?? '';
  return {
    'run.mode': executionMode(row),
    'run.status': row?.status ?? '',
    'run.signal': banSignal(row)?.signal ?? '',
    'run.last_stage': lastStage ?? '',
    'trajectory.path': versions.trajectory_path ?? '',
    'trajectory.commit': versions.weles_git_commit ?? versions.weles_commit ?? '',
    'trajectory.dirty': Boolean(versions.weles_dirty ?? versions.weles_git_dirty ?? versions.dirty),
    'session.provider': session.provider ?? '',
    'session.proxy_type': session.proxy_type ?? '',
    'session.proxy_host': session.proxy_host ?? hostFromUrl(session.proxy_url ?? ''),
    'session.proxy_port': session.proxy_port ?? '',
    'session.exit_ip': session.exit_ip ?? '',
    'session.proxy_requested': proxyRequested,
    'browser.name': persona.browser ?? browserProvenance.browser ?? '',
    'browser.os': persona.os ?? browserProvenance.os ?? '',
    'browser.platform': persona.platform ?? '',
    'browser.language': persona.language ?? '',
    'browser.timezone': persona.timezone ?? '',
    'browser.screen': screenString(persona),
    'browser.gpu_vendor': persona.gpu_vendor ?? persona.gpu?.vendor ?? '',
    'browser.gpu_renderer': persona.gpu_renderer ?? persona.gpu?.renderer ?? '',
    'evidence.capture_sql': capture ? 'yes' : 'no',
    'evidence.artifact_dom': artifacts.dom ? 'yes' : 'no',
    'evidence.artifact_network': artifacts.network ? 'yes' : 'no',
    'evidence.artifact_video': artifacts.video ? 'yes' : 'no',
  };
}

function sanitizeVector(vector) {
  return Object.fromEntries(Object.entries(vector).map(([key, value]) => [key, safeValue(key, value)]));
}

const DIFF_FIELDS = [
  'run.mode',
  'trajectory.path',
  'trajectory.commit',
  'trajectory.dirty',
  'session.provider',
  'session.proxy_type',
  'session.proxy_host',
  'session.proxy_port',
  'session.exit_ip',
  'session.proxy_requested',
  'browser.name',
  'browser.os',
  'browser.platform',
  'browser.language',
  'browser.timezone',
  'browser.screen',
  'browser.gpu_vendor',
  'browser.gpu_renderer',
  'evidence.capture_sql',
  'evidence.artifact_dom',
  'evidence.artifact_network',
  'evidence.artifact_video',
];

function fieldDistance(a, b) {
  let n = 0;
  for (const field of DIFF_FIELDS) {
    if (safeValue(field, a[field]) !== safeValue(field, b[field])) n += 1;
  }
  return n;
}

function uniq(values) {
  return [...new Set(values.filter((v) => v !== undefined && v !== null && String(v) !== '').map(String))];
}

function setDisjoint(a, b) {
  if (!a.length || !b.length) return false;
  const bb = new Set(b);
  return a.every((x) => !bb.has(x));
}

function discriminatorRows(failed, completed) {
  const rows = [];
  for (const field of DIFF_FIELDS) {
    const failValues = uniq(failed.map((r) => safeValue(field, r.vector[field])));
    const passValues = uniq(completed.map((r) => safeValue(field, r.vector[field])));
    if (!setDisjoint(failValues, passValues)) continue;
    rows.push({
      field,
      failed_values: failValues.slice(0, 8),
      completed_values: passValues.slice(0, 8),
      failed_distinct: failValues.length,
      completed_distinct: passValues.length,
      score: failed.length + completed.length - failValues.length - passValues.length,
    });
  }
  return rows.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field));
}

function failureBuckets(rows) {
  const buckets = new Map();
  for (const row of rows) {
    if (isCompleted(row) || isInProgress(row) || isPending(row)) continue;
    const reasons = failureReasons(row);
    for (const reason of reasons.length ? reasons : [{ code: 'unclassified', message: '' }]) {
      const key = reason.code;
      const bucket = buckets.get(key) ?? { code: key, runs: [], messages: new Set() };
      bucket.runs.push(row);
      if (reason.message) bucket.messages.add(reason.message);
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()].sort((a, b) => b.runs.length - a.runs.length || a.code.localeCompare(b.code));
}

function runSummary(row) {
  return {
    id: row.id,
    detail_url: row.detail_url ?? '',
    started_at: row.started_at ?? '',
    status: row.status ?? '',
    signal: banSignal(row)?.signal ?? '',
    mode: executionMode(row),
    vector: sanitizeVector(row.vector),
  };
}

function nearestCompletedPath(bucketRows, completedRows) {
  if (!completedRows.length) return null;
  let best = null;
  for (const pass of completedRows) {
    const distances = bucketRows.map((row) => fieldDistance(row.vector, pass.vector)).sort((a, b) => a - b);
    const median = distances.length ? distances[Math.floor(distances.length / 2)] : 0;
    const worst = distances.at(-1) ?? 0;
    const candidate = { row: pass, median_distance: median, worst_distance: worst };
    if (!best || candidate.median_distance < best.median_distance || (candidate.median_distance === best.median_distance && candidate.worst_distance < best.worst_distance)) {
      best = candidate;
    }
  }
  return {
    median_distance: best.median_distance,
    worst_distance: best.worst_distance,
    completed_run: runSummary(best.row),
  };
}

function evidenceGaps(rows) {
  const gaps = [];
  const missingBan = rows.filter((row) => !banSignal(row)).length;
  const missingCapture = rows.filter((row) => !row.capture_summary).length;
  const missingSession = rows.filter((row) => !row.session && !row.result?.session).length;
  const missingNetwork = rows.filter((row) => !artifactCounts(row).network).length;
  if (missingBan) gaps.push({ code: 'missing_ban_signal', runs: missingBan });
  if (missingSession) gaps.push({ code: 'missing_session_fingerprint', runs: missingSession });
  if (missingCapture) gaps.push({ code: 'missing_sql_capture', runs: missingCapture });
  if (missingNetwork) gaps.push({ code: 'missing_network_artifact', runs: missingNetwork });
  return gaps;
}

function buildPlan(payload, source) {
  const rows = (Array.isArray(payload?.rows) ? payload.rows : []).map((row) => {
    const withVector = { ...row };
    withVector.vector = rowVector(withVector);
    return withVector;
  });
  const completed = rows.filter(isCompleted);
  const pending = rows.filter((row) => !isCompleted(row) && !isInProgress(row) && isPending(row));
  const staleRunning = rows.filter((row) => !isCompleted(row) && isStaleRunning(row));
  const failed = rows.filter((row) => !isCompleted(row) && !isInProgress(row) && !isPending(row));
  const inProgress = rows.filter(isInProgress);
  const buckets = failureBuckets(rows);
  const bucketPlans = buckets.map((bucket) => {
    const nearest = nearestCompletedPath(bucket.runs, completed);
    const discriminators = discriminatorRows(bucket.runs, completed);
    const failedModes = uniq(bucket.runs.map(executionMode));
    const completedModes = uniq(completed.map(executionMode));
    const modeGap = failedModes.filter((mode) => !completedModes.includes(mode));
    return {
      reason: bucket.code,
      runs: bucket.runs.length,
      examples: bucket.runs.slice(0, 6).map((row) => row.id),
      messages: [...bucket.messages].slice(0, 5),
      nearest_completed_path: nearest,
      discriminators: discriminators.slice(0, 14),
      automation_gap: modeGap.length ? {
        failed_modes_without_completed_counterpart: modeGap,
        completed_modes: completedModes,
      } : null,
    };
  });
  return {
    source,
    action: payload?.action ?? actionFromTestingUrl(source),
    generated_at: new Date().toISOString(),
    counts: {
      total: rows.length,
      completed: completed.length,
      failed: failed.length,
      in_progress: inProgress.length,
      pending: pending.length,
      stale_running: staleRunning.length,
    },
    current_primary_reason: bucketPlans[0]?.reason ?? (completed.length ? 'completed' : 'no_runs'),
    completed_paths: completed.slice(0, 10).map(runSummary),
    failure_buckets: bucketPlans,
    evidence_gaps: evidenceGaps(rows),
  };
}

function printHuman(plan) {
  console.log(`source: ${plan.source}`);
  console.log(`action: ${plan.action}`);
  console.log(`runs: total=${plan.counts.total} completed=${plan.counts.completed} failed=${plan.counts.failed} in_progress=${plan.counts.in_progress} pending=${plan.counts.pending ?? 0} stale_running=${plan.counts.stale_running ?? 0}`);
  console.log(`current_primary_reason: ${plan.current_primary_reason}`);
  console.log('completed_paths:');
  if (!plan.completed_paths.length) console.log('- none observed');
  for (const pass of plan.completed_paths.slice(0, 5)) {
    console.log(`- ${pass.id.slice(0, 8)} mode=${pass.mode} signal=${pass.signal || '—'} path=${pass.vector['trajectory.path'] || '—'} provider=${pass.vector['session.provider'] || '—'} exit=${pass.vector['session.exit_ip'] || pass.vector['session.proxy_host'] || '—'} browser=${pass.vector['browser.name'] || '—'} os=${pass.vector['browser.os'] || '—'}`);
  }
  console.log('failure_buckets:');
  for (const bucket of plan.failure_buckets.slice(0, 12)) {
    console.log(`- ${bucket.reason}: runs=${bucket.runs} examples=${bucket.examples.map((id) => id.slice(0, 8)).join(',')}`);
    if (bucket.nearest_completed_path) {
      const pass = bucket.nearest_completed_path.completed_run;
      console.log(`  nearest_pass=${pass.id.slice(0, 8)} mode=${pass.mode} median_distance=${bucket.nearest_completed_path.median_distance} signal=${pass.signal || '—'}`);
    } else {
      console.log('  nearest_pass=none_observed');
    }
    for (const d of bucket.discriminators.slice(0, 6)) {
      console.log(`  diff ${d.field}: failed=[${d.failed_values.join('|') || '—'}] completed=[${d.completed_values.join('|') || '—'}]`);
    }
    if (bucket.automation_gap) {
      console.log(`  automation_gap failed_modes_without_completed_counterpart=[${bucket.automation_gap.failed_modes_without_completed_counterpart.join(',')}] completed_modes=[${bucket.automation_gap.completed_modes.join(',') || 'none'}]`);
    }
  }
  if (plan.evidence_gaps.length) {
    console.log('evidence_gaps:');
    for (const gap of plan.evidence_gaps) console.log(`- ${gap.code}: runs=${gap.runs}`);
  }
}

if (flag('-h') || flag('--help')) {
  usage();
  process.exit(0);
}

const source = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? DEFAULT_SOURCE;
const limit = Number(argValue('--limit', '200')) || 200;
const maxActions = Number(argValue('--max-actions', '0')) || 0;
const options = {
  cookie: argValue('--cookie', process.env.WELES_CONSOLE_COOKIE ?? ''),
  token: argValue('--token', process.env.WELES_CONSOLE_API_TOKEN ?? ''),
};

try {
  if (flag('--all')) {
    const { indexUrl, actions: allActions } = await fetchActionsFromTestingIndex(source, options);
    const actions = maxActions > 0 ? allActions.slice(0, maxActions) : allActions;
    const plans = [];
    for (const action of actions) {
      const actionSource = sourceForAction(indexUrl, action);
      const payload = await fetchJson(apiUrlFor(actionSource, limit), options);
      plans.push(buildPlan(payload, actionSource));
    }
    const report = {
      source: indexUrl,
      generated_at: new Date().toISOString(),
      action_count: plans.length,
      plans,
    };
    if (flag('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`source: ${indexUrl}`);
      console.log(`actions: ${plans.length}`);
      for (const plan of plans) {
        const firstBucket = plan.failure_buckets[0];
        const nearest = firstBucket?.nearest_completed_path?.completed_run;
        console.log(`- ${plan.action}: total=${plan.counts.total} completed=${plan.counts.completed} failed=${plan.counts.failed} active=${plan.counts.in_progress} stale=${plan.counts.stale_running ?? 0} primary=${plan.current_primary_reason}${nearest ? ` nearest_pass=${nearest.id.slice(0, 8)}:${nearest.mode}` : ''}`);
      }
    }
  } else {
    const payload = await fetchJson(apiUrlFor(source, limit), options);
    const plan = buildPlan(payload, source);
    if (flag('--json')) console.log(JSON.stringify(plan, null, 2));
    else printHuman(plan);
  }
} catch (e) {
  console.error(`trajectory_diff_planner: ${e.message}`);
  process.exit(1);
}
