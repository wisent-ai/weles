#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ALL_ACTIONS = [
  'umami_login',
  'umami_create_website',
  'umami_find_website',
  'umami_get_website_id',
  'umami_get_tracking_snippet',
  'umami_update_website_settings',
  'umami_verify_tracking_script',
  'umami_verify_realtime_event',
  'umami_view_realtime',
  'umami_view_summary',
  'umami_view_pages',
  'umami_view_referrers',
  'umami_view_events',
  'umami_track_custom_event',
  'umami_view_sessions',
  'umami_create_report',
  'umami_view_funnels',
  'umami_view_goals',
  'umami_view_user_journeys',
  'umami_view_retention',
  'umami_view_cohorts',
  'umami_view_utm_campaigns',
  'umami_api_query',
  'umami_create_share_url',
  'umami_manage_user_access',
  'umami_export_report',
  'googleanalytics_login',
  'googleanalytics_find_property',
  'googleanalytics_create_account',
  'googleanalytics_create_property',
  'googleanalytics_create_web_stream',
  'googleanalytics_get_measurement_id',
  'googleanalytics_get_global_site_tag',
  'googleanalytics_create_measurement_protocol_secret',
  'googleanalytics_install_gtag',
  'googleanalytics_verify_realtime',
  'googleanalytics_view_debugview',
  'googleanalytics_view_realtime',
  'googleanalytics_run_data_api_report',
  'googleanalytics_view_acquisition',
  'googleanalytics_view_engagement',
  'googleanalytics_view_pages',
  'googleanalytics_create_key_event',
  'googleanalytics_view_key_events',
  'googleanalytics_create_audience',
  'googleanalytics_create_custom_dimension',
  'googleanalytics_create_custom_metric',
  'googleanalytics_link_search_console',
  'googleanalytics_link_google_ads',
  'googleanalytics_update_data_retention',
  'googleanalytics_add_user',
  'googleanalytics_export_report',
];

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeReadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function latestSignals() {
  const byAction = new Map();
  for (const file of walk('recordings')) {
    if (!file.endsWith('/ban_signal.json')) continue;
    const action = basename(dirname(file));
    if (!ALL_ACTIONS.includes(action)) continue;
    const mtime = statSync(file).mtimeMs;
    const prev = byAction.get(action);
    if (!prev || mtime > prev.mtime) byAction.set(action, { file, mtime });
  }
  return byAction;
}

function summaryRow(action, source, exitCode = null, timeout = false) {
  const signal = safeReadJson(source);
  if (!signal) return { action, outcome: 'missing_signal', exitCode, timeout, signal: null, healthy: null, reason: 'ban_signal.json not found', file: source };
  const reason = signal.details?.reason ?? '';
  const finalUrl = signal.details?.final_url ?? '';
  const outcome = signal.signal === 'pending_review'
    ? 'pending_review'
    : signal.healthy === true
      ? 'healthy'
      : 'failed';
  return { action, outcome, exitCode, timeout, signal: signal.signal ?? null, healthy: signal.healthy ?? null, reason, finalUrl, file: source };
}

function writeSummary(outDir, rows) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    total_actions: rows.length,
    counts: rows.reduce((acc, row) => {
      acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
      return acc;
    }, {}),
    rows,
  }, null, 2));
  writeFileSync(join(outDir, 'summary.tsv'), [
    'action\toutcome\tsignal\thealthy\texit_code\ttimeout\treason\tfinal_url\tfile',
    ...rows.map((row) => [
      row.action,
      row.outcome,
      row.signal ?? '',
      row.healthy ?? '',
      row.exitCode ?? '',
      row.timeout ? 'true' : 'false',
      row.reason ?? '',
      row.finalUrl ?? '',
      row.file ?? '',
    ].map((value) => String(value).replace(/\s+/g, ' ').trim()).join('\t')),
  ].join('\n'));
}

function selectedActions() {
  const explicit = argValue('--actions');
  let actions = explicit ? explicit.split(',').map((a) => a.trim()).filter(Boolean) : [...ALL_ACTIONS];
  const platform = argValue('--platform', 'all');
  if (platform !== 'all') actions = actions.filter((action) => action.startsWith(`${platform}_`));
  if (actions.some((action) => !ALL_ACTIONS.includes(action))) {
    throw new Error(`unknown action(s): ${actions.filter((action) => !ALL_ACTIONS.includes(action)).join(', ')}`);
  }
  return actions;
}

function defaultEnv(action, ctx) {
  const propertyId = ctx.propertyId || process.env.ANALYTICS_MATRIX_PROPERTY_ID || '';
  const measurementId = ctx.measurementId || process.env.ANALYTICS_MATRIX_MEASUREMENT_ID || '';
  return {
    DOMAIN: process.env.ANALYTICS_MATRIX_DOMAIN || 'needher.ai',
    DISPLAY_NAME: process.env.ANALYTICS_MATRIX_DISPLAY_NAME || 'NeedHer',
    DOMAIN_OR_NAME: process.env.ANALYTICS_MATRIX_DOMAIN_OR_NAME || 'controlai-406621',
    WEBSITE_ID: process.env.ANALYTICS_MATRIX_UMAMI_WEBSITE_ID || 'needher-website-id',
    SETTINGS_PATCH: '{"name":"NeedHer"}',
    SITE_URL: process.env.ANALYTICS_MATRIX_SITE_URL || 'https://www.needher.ai',
    EVENT_NAME: 'needher_test_event',
    ENDPOINT: '/api/websites',
    QUERY: '{"websiteId":"needher-website-id"}',
    REPORT_TYPE: 'traffic',
    DATE_RANGE: 'last_7_days',
    FUNNEL_NAME: 'signup',
    USER_EMAIL: 'test@example.com',
    ROLE: 'viewer',
    ACCOUNT_NAME: 'NeedHer Test Account',
    GA_ACCOUNT_ID: process.env.ANALYTICS_MATRIX_GA_ACCOUNT_ID || '',
    PROPERTY_ID: propertyId,
    PROPERTY_NAME: 'NeedHer Test Property',
    TIMEZONE: 'America/Los_Angeles',
    CURRENCY: 'USD',
    STREAM_ID: process.env.ANALYTICS_MATRIX_STREAM_ID || 'unknown-stream',
    STREAM_NAME: 'NeedHer Web',
    MEASUREMENT_ID: measurementId,
    NICKNAME: 'NeedHer Protocol Secret',
    DIMENSIONS: '["pagePath"]',
    METRICS: '["activeUsers"]',
    DEBUG_DEVICE_OR_EVENT: 'browser',
    AUDIENCE_DEFINITION: '{"name":"NeedHer Test Audience"}',
    DIMENSION_NAME: 'needher_dimension',
    SCOPE: 'event',
    PARAMETER_NAME: 'needher_parameter',
    METRIC_NAME: 'needher_metric',
    UNIT: 'standard',
    SEARCH_CONSOLE_PROPERTY: process.env.ANALYTICS_MATRIX_SITE_URL || 'https://www.needher.ai/',
    GOOGLE_ADS_CUSTOMER_ID: '0000000000',
    RETENTION_DURATION: '14_months',
    REPORT_NAME: 'realtime',
  };
}

function learnGaContext(action, runId, ctx) {
  if (!action.startsWith('googleanalytics_')) return;
  const evidence = safeReadJson(join('recordings', runId, action, 'service_action_result.json'));
  const text = evidence?.bodyText ?? '';
  const url = evidence?.url ?? '';
  const property = url.match(/p(\d+)\//)?.[1] || url.match(/p(\d+)/)?.[1];
  const measurement = text.match(/Measurement ID:(G-[A-Z0-9]+)/i)?.[1];
  if (property && !ctx.propertyId) ctx.propertyId = property;
  if (measurement && !ctx.measurementId) ctx.measurementId = measurement;
}

function cleanupHeavy(runId) {
  const root = join('recordings', runId);
  if (!existsSync(root)) return;
  for (const file of walk(root)) {
    if (/\.(webm|png|har|html)$/i.test(file)) unlinkSync(file);
  }
}

function executeMatrix(actions) {
  const stamp = nowStamp();
  const outDir = join('recordings', `analytics-service-matrix-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const ctx = {};
  const rows = [];
  const timeoutMs = Number(argValue('--timeout-ms', process.env.ANALYTICS_MATRIX_TIMEOUT_MS || '240000'));
  const keepHeavy = hasFlag('--keep-heavy');

  const ordered = [...actions];
  if (ordered.some((action) => action.startsWith('googleanalytics_')) && !process.env.ANALYTICS_MATRIX_PROPERTY_ID && !ordered.includes('googleanalytics_login')) {
    ordered.unshift('googleanalytics_login');
  }
  if (ordered.some((action) => action.startsWith('googleanalytics_')) && ordered.includes('googleanalytics_login')) {
    ordered.splice(ordered.indexOf('googleanalytics_login'), 1);
    ordered.unshift('googleanalytics_login');
  }
  if (ordered.some((action) => action.startsWith('umami_')) && ordered.includes('umami_login')) {
    ordered.splice(ordered.indexOf('umami_login'), 1);
    ordered.unshift('umami_login');
  }

  for (const action of ordered) {
    const runId = `analytics-matrix-${stamp}-${action}`;
    const logPath = join(outDir, `${action}.log`);
    const env = { ...process.env, ...defaultEnv(action, ctx), ACTION: action, SERVICE_ACTION: action, ACTION_LOG_ID: runId };
    const result = spawnSync(process.execPath, ['scripts/trajectories/_shared/analytics-service.mjs'], {
      env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
    });
    writeFileSync(logPath, [
      `$ ${process.execPath} scripts/trajectories/_shared/analytics-service.mjs`,
      `action=${action}`,
      `run_id=${runId}`,
      `exit=${result.status ?? ''}`,
      `signal=${result.signal ?? ''}`,
      result.stdout ?? '',
      result.stderr ?? '',
    ].join('\n'));
    learnGaContext(action, runId, ctx);
    if (!keepHeavy) cleanupHeavy(runId);
    const signalPath = join('recordings', runId, action, 'ban_signal.json');
    rows.push(summaryRow(action, signalPath, result.status, result.error?.code === 'ETIMEDOUT'));
    writeSummary(outDir, rows);
    console.log(`${action}\t${rows[rows.length - 1].outcome}\t${rows[rows.length - 1].reason || rows[rows.length - 1].finalUrl || ''}`);
  }
  return outDir;
}

loadDotEnv();

if (hasFlag('--summary-existing')) {
  const outDir = join('recordings', `analytics-service-matrix-existing-${nowStamp()}`);
  const signals = latestSignals();
  const rows = selectedActions().map((action) => {
    const source = signals.get(action)?.file ?? join('recordings', '<missing>', action, 'ban_signal.json');
    return summaryRow(action, source);
  });
  writeSummary(outDir, rows);
  console.log(outDir);
} else {
  console.log(executeMatrix(selectedActions()));
}
