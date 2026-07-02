// Worker: poll account_action_logs, claim atomically, spawn weles trajectory
// subprocess, import ban_signal + pending_review if present, write back. Pure
// orchestration — trajectories own their own WSession + Capture.
import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import os from 'node:os';
import { uploadArtifacts } from './upload-artifacts.js';
import { paramsToEnv, resolveTrajectory } from './dispatch.js';
import { claimOne } from './claim.js';
import { sweepZombiesIfDue } from './stale.js';
import { captureVersions } from '../diagnostics/versions.js';
import { importRunProvenance, writeNetworkCapture, pgConnectionString } from '../diagnostics/run-import.js';
import postgres from 'postgres';
import { verifyRunArtifacts } from './verification.js';

export interface ActionLogRow {
  id: string;
  account_id: string | null;
  action: string;
  platform?: string;
  params?: Record<string, unknown>;
  status?: string;
  webhook_url?: string | null;
  cancel_requested?: boolean | null;
  priority?: number | null;
}

export interface BanSignal { healthy: boolean; signal: string; details?: Record<string, unknown>; }

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT ?? 'recordings';
const LIGHT_RESULT_ACTIONS = new Set(['overleaf_version_history_scan', 'slack_provision_user_token']);

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

type TrajectoryBuildRow = {
  id: string;
  tenant_id?: string | null;
  name: string;
  platform: string;
  url: string;
  objective: string;
  constraints?: Record<string, unknown> | null;
  env?: Record<string, unknown> | null;
  trajectory_id?: string | null;
  test_run_id?: string | null;
};

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textParam(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function replayStepsFromHistory(value: unknown): Array<{ tool: string; args: Record<string, unknown>; result?: string }> {
  if (!Array.isArray(value)) return [];
  const steps: Array<{ tool: string; args: Record<string, unknown>; result?: string }> = [];
  for (const raw of value) {
    const record = recordOrEmpty(raw);
    const tool = typeof record.tool === 'string' ? record.tool : '';
    if (!tool) continue;
    const args = recordOrEmpty(record.args);
    const step: { tool: string; args: Record<string, unknown>; result?: string } = { tool, args };
    if (typeof record.result === 'string') step.result = record.result;
    steps.push(step);
  }
  return steps;
}

function secretCandidateFromValue(value: unknown): { field: string; value: string } | null {
  const record = recordOrEmpty(value);
  for (const [field, raw] of Object.entries(record)) {
    if (typeof raw !== 'string') continue;
    const name = field.toLowerCase();
    if (!/(^|_)(api_)?key$|token|secret/.test(name)) continue;
    const candidate = raw.trim();
    if (candidate.length < 8) continue;
    if (/pending|submitted|received|wait|email/i.test(candidate)) continue;
    return { field, value: candidate };
  }
  return null;
}

function previewSecret(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

async function persistServiceCredentialReference(row: ActionLogRow, result: Record<string, unknown>): Promise<void> {
  const params = recordOrEmpty(row.params);
  const constraints = recordOrEmpty(params.constraints);
  if (constraints.store_secret_target !== 'service_credentials') return;
  const generic = recordOrEmpty(result.generic_browser_task);
  const value = recordOrEmpty(generic.value);
  const secret = secretCandidateFromValue(value);
  if (!secret) return;

  const displayName = textParam(constraints, 'display_name') ?? textParam(params, 'promote_name') ?? 'Acquired API key';
  const envVar = textParam(constraints, 'env_var');
  const metadata = {
    source: 'weles_secret_acquisition',
    source_run_id: row.id,
    key_field: secret.field,
    value_status: typeof value.status === 'string' ? value.status : null,
    captured_at: new Date().toISOString(),
  };
  const patch = {
    display_name: displayName,
    category: 'api',
    api_key_env_var: envVar,
    api_key_preview: previewSecret(secret.value),
    notes: `Acquired by Weles run ${row.id}; plaintext remains in the source run result.`,
    metadata,
    updated_at: new Date().toISOString(),
  };

  try {
    const match = await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(displayName)}&select=id&limit=1`, { headers: headers() });
    const existing = match.ok ? (await match.json() as Array<{ id: string }>) : [];
    const id = existing[0]?.id;
    if (id) {
      await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      return;
    }
    await fetch(`${SUPABASE_URL}/rest/v1/service_credentials`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.log(`[worker] service_credentials persistence skipped: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
  }
}

function trajectoryActionFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  if (!slug) return 'saved_browser_task';
  return `saved_${slug}`;
}

async function patchTrajectoryBuild(buildId: string, patch: Record<string, unknown>): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/weles_trajectory_builds?id=eq.${buildId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function fetchTrajectoryBuild(buildId: string): Promise<TrajectoryBuildRow | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/weles_trajectory_builds?id=eq.${buildId}&select=id,tenant_id,name,platform,url,objective,constraints,env,trajectory_id,test_run_id`, { headers: headers() });
    if (!res.ok) return null;
    const rows = await res.json() as TrajectoryBuildRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function insertReturning<T>(table: string, row: Record<string, unknown>, select: string): Promise<T | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(await res.text());
    const rows = await res.json() as T[];
    return rows[0] ?? null;
  } catch (e) {
    console.log(`[builder] insert ${table} failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    return null;
  }
}

async function promoteTrajectoryBuild(row: ActionLogRow, result: Record<string, unknown>): Promise<void> {
  const params = row.params ?? {};
  const buildId = textParam(params, 'trajectory_build_id');
  if (!buildId || params.auto_promote_trajectory !== true) return;

  const build = await fetchTrajectoryBuild(buildId);
  if (!build) return;
  if (build.trajectory_id && build.test_run_id) return;

  const url = textParam(params, 'url') ?? build.url;
  const objective = textParam(params, 'objective') ?? build.objective;
  const name = textParam(params, 'promote_name') ?? build.name;
  const action = trajectoryActionFromName(`${name} ${buildId.slice(0, 8)}`);
  const genericResult = recordOrEmpty(result.generic_browser_task);
  const replay = replayStepsFromHistory(genericResult.history);
  if (replay.length === 0) {
    await patchTrajectoryBuild(buildId, { status: 'failed', source_run_id: row.id, error: 'trajectory promotion failed: no replayable history', result: { source_run_id: row.id } });
    return;
  }
  const definition = {
    url,
    objective,
    constraints: recordOrEmpty(params.constraints ?? build.constraints),
    env: recordOrEmpty(params.env ?? build.env),
    flow_name: textParam(params, 'flow_name') ?? `promoted:${action}`,
    proxy: textParam(params, 'proxy'),
    headless: params.headless === true,
    promoted_from: { run_id: row.id, status: 'completed', completed_at: new Date().toISOString() },
    replay,
    last_result: genericResult,
  };
  let site = 'unknown';
  try { site = new URL(url).hostname; } catch { /* keep unknown */ }

  const trajectory = build.trajectory_id ? { id: build.trajectory_id } : await insertReturning<{ id: string }>('weles_trajectories', {
    tenant_id: build.tenant_id ?? null,
    name,
    action,
    site,
    url,
    objective,
    definition,
    created_from_run_id: row.id,
    status: 'active',
    created_by: 'trajectory-builder',
  }, 'id');
  if (!trajectory?.id) {
    await patchTrajectoryBuild(buildId, { status: 'failed', error: 'trajectory promotion failed', result: { source_run_id: row.id } });
    return;
  }

  const testRun = build.test_run_id ? { id: build.test_run_id } : await insertReturning<{ id: string }>('account_action_logs', {
    action: 'generic_saved_task',
    platform: 'generic',
    status: 'queued',
    scheduled_at: new Date().toISOString(),
    params: { trajectory_id: trajectory.id, trajectory_build_id: buildId, build_test: true },
    tenant_id: build.tenant_id ?? null,
    priority: row.priority ?? 10,
    queued_by: 'trajectory-builder',
  }, 'id');
  if (!testRun?.id) {
    await patchTrajectoryBuild(buildId, { status: 'failed', trajectory_id: trajectory.id, error: 'trajectory test enqueue failed' });
    return;
  }

  await patchTrajectoryBuild(buildId, {
    status: 'testing',
    source_run_id: row.id,
    trajectory_id: trajectory.id,
    test_run_id: testRun.id,
    result: { source_run_id: row.id, trajectory_id: trajectory.id, test_run_id: testRun.id },
  });
  console.log(`[builder] build=${buildId.slice(0, 8)} promoted trajectory=${trajectory.id.slice(0, 8)} test=${testRun.id.slice(0, 8)}`);
}

async function updateTrajectoryBuildAfterRun(row: ActionLogRow, status: 'completed' | 'failed' | 'cancelled' | 'pending_review', result: Record<string, unknown>, error?: string): Promise<void> {
  const buildId = textParam(row.params, 'trajectory_build_id');
  if (!buildId) return;
  if (row.action === 'generic_browser_task' || row.action === 'generic_keeper_task') {
    if (status === 'completed') {
      await promoteTrajectoryBuild(row, result);
    } else if (status === 'pending_review') {
      await patchTrajectoryBuild(buildId, { status: 'pending_review', source_run_id: row.id, error: error ?? 'pending_review', result: { source_run_id: row.id, status, verification: result.verification ?? null } });
    } else {
      await patchTrajectoryBuild(buildId, { status: 'failed', source_run_id: row.id, error: error ?? status, result: { source_run_id: row.id, status } });
    }
    return;
  }
  if (row.action === 'generic_saved_task' && row.params?.build_test === true) {
    await patchTrajectoryBuild(buildId, {
      status: status === 'completed' ? 'completed' : status === 'pending_review' ? 'pending_review' : 'failed',
      test_run_id: row.id,
      error: status === 'completed' ? null : (error ?? status),
      result: { test_run_id: row.id, status, generic_browser_task: result.generic_browser_task ?? null, ban_signal: result.ban_signal ?? null, verification: result.verification ?? null },
    });
  }
}

async function cancelRequested(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${jobId}&select=cancel_requested,status`, { headers: headers() });
    if (!res.ok) return false;
    const rows = await res.json() as Array<{ cancel_requested?: boolean; status?: string }>;
    const row = rows[0];
    return row?.cancel_requested === true || row?.status === 'cancelled';
  } catch {
    return false;
  }
}

async function runTrajectory(row: ActionLogRow, path: string, extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; stderr: string; cancelled: boolean }> {
  // G17: recordings/<run_uuid>/ is unique per run, so there is no stale
  // predecessor file to clear (the old shared recordings/<action>/ hazard is gone).
  const secretResultPath = row.action === 'slack_provision_user_token'
    ? join(os.tmpdir(), `weles-secret-${row.id}.json`)
    : '';
  return new Promise((resolve) => {
    const child = spawn('node', [path], {
      env: {
        ...process.env,
        // G17g: produce the FULL forensic surface by default — netlog + pcap +
        // storage/worker/host diagnostics (overridable). HAR/video are already
        // on by default. So a run captures everything it possibly can.
        WELES_FULL_DIAGNOSTICS: process.env.WELES_FULL_DIAGNOSTICS ?? '1',
        ...paramsToEnv(row.params ?? {}, row.action, path),
        ...extraEnv,
        ...(secretResultPath ? { WELES_SECRET_RESULT_FILE: secretResultPath } : {}),
        ...(row.account_id ? { ACCOUNT_ID: row.account_id } : {}),
        ACTION_LOG_ID: row.id,
        ACTION: row.action,
      },
      cwd: process.cwd(), stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    let killed = false;
    let cancelled = false;
    const requestStop = (message: string) => {
      if (killed) return;
      killed = true;
      stderr += message;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 8000);
    };
    const cancelTimer = setInterval(() => {
      void cancelRequested(row.id).then((requested) => {
        if (!requested) return;
        cancelled = true;
        requestStop('\nFAIL: cancel_requested — SIGTERM, then SIGKILL after grace');
      });
    }, 5000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearInterval(cancelTimer);
      resolve({ exitCode: killed ? 137 : (code ?? -1), stderr: stderr.slice(-2000), cancelled });
    });
  });
}

// Diagnostic retry: when a trajectory fails without WELES_INSTRUMENT, re-run
// it with instrumentation on so the next debug session has a fresh dump in
// .work/inst/<label>_*.json that diff_trajectory.mjs can pick up. The retry's
// outcome is ignored — the original failure stays as the action_log's
// recorded result. Skipped for cheap service trajectories (balance/topup/
// health) where instrumentation has little diagnostic value.
//
// Opt out with AUTO_INSTRUMENT_RETRIES=0.
async function diagnosticRetry(_row: ActionLogRow, _path: string): Promise<string | null> {
  // Vestigial: instrumentation is now unconditional, so the original run
  // already wrote the .work/inst/<label>_*.json dump. Nothing to retry.
  return null;
}

// G17: artifacts live under recordings/<run_uuid>/ (across varying
// sub-action/label dirs). Find a file by name anywhere in the run's tree.
async function findInRun(runId: string, filename: string): Promise<string | null> {
  async function walk(dir: string): Promise<string | null> {
    let entries: any[];
    try { entries = (await readdir(dir, { withFileTypes: true } as any)) as any; } catch { return null; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { const r = await walk(full); if (r) return r; }
      else if (e.name === filename) return full;
    }
    return null;
  }
  return walk(join(RECORDINGS_ROOT, runId));
}
async function readJsonInRun(runId: string, filename: string): Promise<any | null> {
  const p = await findInRun(runId, filename);
  if (!p) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

async function readBanSignal(runId: string): Promise<BanSignal | null> {
  return (await readJsonInRun(runId, 'ban_signal.json')) as BanSignal | null;
}

// pgConnectionString + writeNetworkCapture moved to ../diagnostics/run-import.ts
// so the keeper shares the exact same capture write (no drift on the ::text::jsonb
// cast / U+0000 sanitization). importRunProvenance lives there too.

async function importHealthSnapshot(accountId: string, _platform: string, runId: string): Promise<{ signal: string; karma: number | null; shadowbanned: boolean } | null> {
  // G17: the health snapshot json is written somewhere under recordings/<run_uuid>/.
  // Collect all .json under the run tree (newest-first by mtime) and pick the
  // health snapshot matching this account (has account_id + checked_at).
  let snapshot: any = null;
  try {
    const root = join(RECORDINGS_ROOT, runId);
    const found: Array<{ path: string; m: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: any[];
      try { entries = (await readdir(dir, { withFileTypes: true } as any)) as any; } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (e.name.endsWith('.json')) { try { found.push({ path: full, m: (await stat(full)).mtimeMs }); } catch { /* skip */ } }
      }
    };
    await walk(root);
    for (const { path } of found.sort((a, b) => b.m - a.m)) {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (parsed.account_id === accountId && parsed.checked_at) { snapshot = parsed; break; }
    }
    if (!snapshot) return null;
  } catch { return null; }
  await fetch(`${SUPABASE_URL}/rest/v1/account_health_snapshots`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      account_id: snapshot.account_id, checked_at: snapshot.checked_at,
      signal: snapshot.signal ?? 'unknown', shadowbanned: !!snapshot.shadowbanned,
      is_suspended: !!snapshot.is_suspended, karma: snapshot.karma ?? null,
      logged_in: snapshot.logged_in, logged_out: snapshot.logged_out,
    }),
  }).catch(() => {});
  return { signal: snapshot.signal, karma: snapshot.karma ?? null, shadowbanned: !!snapshot.shadowbanned };
}

async function importCreatedAccount(runId: string): Promise<{ id: string; username: string; platform: string } | null> {
  // WSession.saveAccount writes account.json under recordings/<run_uuid>/<label>/.
  return (await readJsonInRun(runId, 'account.json')) as { id: string; username: string; platform: string } | null;
}

async function pauseAccount(accountId: string, signal?: string, hours = 24): Promise<void> {
  // ip_blocked/proxy_failed: proxy-level — burn the proxy, not the account.
  // rate_limited: brief account-level throttle — 4h cooldown, not 24h.
  if (signal === 'ip_blocked' || signal === 'proxy_failed' || signal === 'proxy_auth_failed') return;
  if (signal === 'rate_limited') hours = 4;
  // account_missing = the platform 404s the account's own profile (signup
  // never finalized, or silently deleted). Re-trying never recovers, so
  // deactivate the row like suspended/shadowbanned.
  const hard = signal ? ['suspended', 'shadowbanned', 'account_missing'].includes(signal) : false;
  const body: Record<string, unknown> = { paused_until: new Date(Date.now() + hours * 3600_000).toISOString() };
  if (hard) { body.status = 'flagged'; body.is_active = false; }
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${accountId}`, { method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify(body) }).catch(() => {});
}

type FinalRunStatus = 'completed' | 'failed' | 'pending_review' | 'cancelled';

async function writeResult(jobId: string, status: FinalRunStatus, result: Record<string, unknown>, error?: string, costs?: { cost_usd: number; service_costs: Record<string, number> }): Promise<void> {
  const body: Record<string, unknown> = {
    status, result, error: error ?? null,
    completed_at: new Date().toISOString(),
  };
  if (costs) {
    body.cost_usd = costs.cost_usd;
    body.service_costs = costs.service_costs;
  }
  await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${jobId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function validWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch {
    return false;
  }
}

async function sendRunWebhook(row: ActionLogRow, status: FinalRunStatus, result: Record<string, unknown>, error?: string): Promise<void> {
  const webhookUrl = row.webhook_url;
  if (!webhookUrl || !validWebhookUrl(webhookUrl)) return;
  const body = JSON.stringify({
    run_id: row.id,
    action: row.action,
    platform: row.platform ?? null,
    account_id: row.account_id,
    status,
    error: error ?? null,
    result,
    completed_at: new Date().toISOString(),
  });
  const headersOut: Record<string, string> = {
    'content-type': 'application/json',
    'x-weles-event': 'run.finished',
    'x-weles-run-id': row.id,
  };
  const secret = process.env.WELES_WEBHOOK_SECRET;
  if (secret) headersOut['x-weles-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  await fetch(webhookUrl, { method: 'POST', headers: headersOut, body }).catch(() => {});
}

async function readCosts(jobId: string): Promise<{ cost_usd: number; service_costs: Record<string, number> } | null> {
  const path = join(RECORDINGS_ROOT, '_costs', `${jobId}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.cost_usd === 'number' && parsed.service_costs && typeof parsed.service_costs === 'object') {
      void unlink(path).catch(() => {});
      return { cost_usd: parsed.cost_usd, service_costs: parsed.service_costs };
    }
  } catch { /* file absent or malformed */ }
  return null;
}

async function closeCampaignItem(params: Record<string, unknown> | undefined, finalStatus: 'completed' | 'failed', error?: string): Promise<void> {
  const itemId = params?.campaign_item_id as string | undefined;
  if (!itemId) return;
  await fetch(`${SUPABASE_URL}/rest/v1/campaign_items?id=eq.${itemId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ status: finalStatus, error: error ?? null, completed_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function workersEnabled(): Promise<boolean> {
  if (process.env.WELES_WORKER_FORCE_ENABLED === '1') return true;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/system_settings?key=eq.workers_enabled&select=value`,
      { headers: headers() },
    );
    if (!res.ok) return true;
    const rows = (await res.json()) as Array<{ value: { enabled?: boolean } }>;
    const flag = rows[0]?.value?.enabled;
    return flag !== false;   // default on if missing
  } catch { return true; }
}

// Enforcement: a worker must never run a workflow it cannot record. Before
// claiming any job we verify BOTH log sinks are live — the 'recordings' Storage
// bucket (forensic artifacts) and the direct-PG network-capture write. If either
// is unreachable the worker claims nothing, so the job stays pending for a
// healthy worker instead of running blind. Memoized for DIAG_PREFLIGHT_TTL_MS:
// one probe per window for ok AND fail alike, which also bounds DB auth attempts
// (a wrong/rotated password can't turn this into a fail2ban-tripping retry loop).
let _diagPreflight: { ok: boolean; at: number; reason: string } | null = null;
const DIAG_PREFLIGHT_TTL_MS = 5 * 60_000;

async function diagnosticsUploadable(): Promise<{ ok: boolean; reason: string }> {
  const now = Date.now();
  if (_diagPreflight && now - _diagPreflight.at < DIAG_PREFLIGHT_TTL_MS) return _diagPreflight;

  // 1. Storage: upsert a tiny marker into the recordings bucket (the same path
  //    + service-role auth uploadArtifacts uses), proving artifacts can land.
  let storageReason = '';
  try {
    const marker = `_preflight/${encodeURIComponent(os.hostname() || 'worker')}.txt`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/recordings/${marker}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'text/plain', 'x-upsert': 'true' },
      body: `worker preflight ${new Date().toISOString()}`,
    });
    if (!res.ok) storageReason = `storage upload HTTP ${res.status}`;
  } catch (e) { storageReason = `storage upload error: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`; }

  // 2. DB capture: connect and confirm INSERT privilege on the capture table
  //    (a non-writing probe — proves connectivity + grant without polluting).
  let dbReason = '';
  const conn = pgConnectionString();
  if (!conn) {
    dbReason = 'no DB connection configured (set SUPABASE_DB_URL or SUPABASE_DB_PASSWORD)';
  } else {
    const sql = postgres(conn, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 15 });
    try {
      const r = await sql`select has_table_privilege('public.account_action_log_capture', 'INSERT') as can`;
      if (r[0]?.can !== true) dbReason = 'no INSERT privilege on account_action_log_capture';
    } catch (e) { dbReason = `capture probe failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`; }
    finally { await sql.end({ timeout: 5 }).catch(() => {}); }
  }

  const ok = !storageReason && !dbReason;
  const reason = ok ? 'storage+capture ok' : [storageReason, dbReason].filter(Boolean).join('; ');
  _diagPreflight = { ok, at: now, reason };
  return _diagPreflight;
}

export async function pollOnce(): Promise<'claimed' | 'idle' | 'error'> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[worker] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    return 'error';
  }
  if (!(await workersEnabled())) return 'idle';
  // Enforcement gate: refuse to claim/run anything unless logs are uploadable.
  const diag = await diagnosticsUploadable();
  if (!diag.ok) {
    console.error(`[worker] REFUSING to claim — diagnostics not uploadable (${diag.reason}). Job left pending for a healthy worker.`);
    return 'error';
  }
  await sweepZombiesIfDue();
  const row = await claimOne();
  if (!row) return 'idle';
  const trajPath = resolveTrajectory(row.action);
  if (!trajPath) {
    const message = `no trajectory for action=${row.action}`;
    await writeResult(row.id, 'failed', {}, message);
    await sendRunWebhook(row, 'failed', {}, message);
    return 'claimed';
  }
  console.log(`[worker] claimed ${row.id.slice(0, 8)} action=${row.action} account=${row.account_id?.slice(0, 8) ?? 'none'} -> ${trajPath}`);

  const runStart = new Date();
  const { exitCode, stderr, cancelled } = await runTrajectory(row, trajPath);
  const banSignal = await readBanSignal(row.id);
  const lightResultOnly = LIGHT_RESULT_ACTIONS.has(row.action);
  const result: Record<string, unknown> = lightResultOnly ? {} : { versions: captureVersions(trajPath) };
  if (row.action === 'slack_provision_user_token') {
    const secretPath = join(os.tmpdir(), `weles-secret-${row.id}.json`);
    const secretResult = await readFile(secretPath, 'utf8').then(JSON.parse).catch(() => null);
    await unlink(secretPath).catch(() => {});
    if (secretResult && typeof secretResult === 'object') result.slack_user_token = secretResult;
  }
  // G5: when the run executed against a dirty repo/trajectory, mirror the full
  // working-tree diff (already captured in result.versions.dirty_diff) to
  // recordings/<action>/source_diff.patch for the storage backup. upload-artifacts
  // allowlists .patch -> 'logs'. Best-effort; never fails the run.
  if (!lightResultOnly) try {
    const v = result.versions as Record<string, unknown>;
    if (v.weles_dirty === true || v.trajectory_file_dirty === true) {
      let diff = typeof v.dirty_diff === 'string' ? (v.dirty_diff as string) : '';
      if (!diff) { try { diff = execSync('git diff', { encoding: 'utf8' }); } catch { /* best-effort */ } }
      if (diff) {
        const pdir = join(RECORDINGS_ROOT, row.id, row.action);
        await (await import('node:fs/promises')).mkdir(pdir, { recursive: true });
        await writeFile(join(pdir, 'source_diff.patch'), diff);
      }
    }
  } catch { /* best-effort */ }
  // Rich per-run provenance: session_meta.json → persona / realized_fingerprint /
  // browser_provenance / env / sticky / exit_reputation / identity / timing_seed,
  // plus proxy_preflight.json, OR the meta_missing fallback when the run died
  // before any session existed. Shared with the keeper via run-import.ts so both
  // the worker and keeper paths import identically (no drift, no black holes).
  if (!lightResultOnly) {
    const prov = await importRunProvenance(row.id, row.params);
    if (prov.session) result.session = prov.session;
    if (prov.identity) result.identity = prov.identity;
    if (prov.run) result.run = prov.run;
    if (prov.challenge_outcome) result.challenge_outcome = prov.challenge_outcome;
  }
  // G8: full per-run captcha event log — challenge_faced flag plus the complete
  // attempt/marker sequence (every solve, every all-providers-failed marker),
  // verbatim. Absent file (no session label) => skipped. A no-captcha run still
  // produces {challenge_faced:false, events:[]}, distinct from a missing file.
  if (!lightResultOnly) {
    const cap = await readJsonInRun(row.id, 'captcha_events.json');
    if (cap) result.captcha = cap;
  }
  if (!lightResultOnly) {
    const pangram = await readJsonInRun(row.id, 'pangram_result.json');
    if (pangram) result.pangram = pangram;
  }
  {
    const genericTask = await readJsonInRun(row.id, 'generic_task_result.json');
    if (genericTask) result.generic_browser_task = genericTask;
  }
  {
    const overleafHistorySummary = await readJsonInRun(row.id, 'overleaf_version_history_summary.json');
    if (overleafHistorySummary) result.overleaf_version_history_summary = overleafHistorySummary;
  }
  {
    const yahooRegister = await readJsonInRun(row.id, 'yahoo_register_result.json');
    if (yahooRegister) result.yahoo_register = yahooRegister;
  }
  {
    const serviceAction = await readJsonInRun(row.id, 'service_action_result.json');
    if (serviceAction) result.service_action = serviceAction;
  }
  const pendingPath = await findInRun(row.id, 'pending_review.json');
  let pending: Record<string, unknown> | null = null;
  if (pendingPath) { try { pending = JSON.parse(await readFile(pendingPath, 'utf8')); } catch { pending = null; } }
  // IP-drift detection: first session stores observed exit_ip; subsequent sessions compare, mismatch -> ip_drift + pause.
  if (!lightResultOnly) try { const ip = (result.session as any)?.exit_ip; if (ip && row.account_id) { const r = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${row.account_id}&select=metadata`, { headers: headers() }); if (r.ok) { const j = await r.json() as any[]; const m = j[0]?.metadata ?? {}; const stored = m.proxy?.exit_ip; if (!stored) { const nm = { ...m, proxy: { ...(m.proxy ?? {}), exit_ip: ip } }; await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${row.account_id}`, { method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: nm }) }); } else if (stored !== ip) { result.ban_signal = { healthy: false, signal: 'ip_drift', details: { expected: stored, observed: ip } }; await pauseAccount(row.account_id, 'ip_drift'); } } } } catch (e) { console.log('[ip-drift]', e instanceof Error ? e.message : String(e)); }
  if (banSignal) {
    result.ban_signal = banSignal;
    if (banSignal.healthy === false && row.account_id) await pauseAccount(row.account_id, banSignal.signal);
    // NOTE: previous version wrote unconditional IP burns on ip_blocked / proxy_auth_failed signals. That was paired-comparison-incorrect by symmetry with the _register burn writer reverted in 4cd2eb4. Removed for consistency — the burn-attribution cron (content-platform src/lib/burn-attribution/runner.ts) is now the sole writer to system_settings.burned_proxies, and only on paired counterfactuals.
    // NOTE: previous version wrote unconditional (domain, ip, host) burns on every _register failure. That was paired-comparison-incorrect — a single failure with no counterfactual cannot isolate which factor caused the failure. Removed b5235af → see this commit. Domain/IP attribution must come from a paired (fail, pass) matcher that observes one factor changed and outcome flipped.
  } else {
    result.ban_signal = { healthy: exitCode === 0, signal: exitCode === 0 ? 'healthy' : 'unknown_error' };
  }
  if (row.action.endsWith('_health') && row.account_id) {
    const snap = await importHealthSnapshot(row.account_id, row.action.slice(0, -'_health'.length), row.id);
    if (snap) { result.health_snapshot = snap; result.ban_signal = { healthy: snap.signal === 'healthy', signal: snap.signal }; }
  }
  if (row.action.endsWith('_register')) {
    const created = await importCreatedAccount(row.id);
    if (created) {
      result.account_id = created.id;
      // Back-link the action_log row to the new account so timeline queries work.
      await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify({ account_id: created.id }),
      }).catch(() => {});
    }
  }
  let verificationPending = false;
  let verificationMessage: string | undefined;
  if (!lightResultOnly) {
    // Always upload so every run has recordings on the detail page.
    await uploadArtifacts(row.action, row.id, runStart, { force: true }).then(a => { if (a) result.artifacts = a }).catch(() => {});
    // G18: persist the full network/instrumentation capture into the lazy
    // account_action_log_capture table (direct PG; best-effort).
    await writeNetworkCapture(row.id).catch(() => {});
    const verification = await verifyRunArtifacts(row, result);
    if (verification) result.verification = verification;
    verificationPending = verification ? !verification.passed : false;
    verificationMessage = verificationPending ? `verification_${verification?.verdict}: ${verification?.reason}` : undefined;
  }
  // Capability-matrix update: record (provider, action) outcome so the
  // selector self-heals as providers go bad / recover. Skips when provider
  // unknown (direct egress) or signal is non-classifying (script error).
  if (!lightResultOnly) try {
    const { recordOutcome } = await import('../proxy/capability.js');
    const s = result.session as any;
    const finalSignal = (result.ban_signal as BanSignal).signal;
    const finalStatus = exitCode === 0 && (pending || verificationPending) ? 'pending_review' : (exitCode === 0 ? 'completed' : 'failed');
    if (s?.provider) await recordOutcome(s.provider, row.action, finalStatus, finalSignal, row.platform);
  } catch { /* best-effort */ }
  const costs = await readCosts(row.id);
  if (costs) console.log(`[worker] ${row.id.slice(0, 8)} cost=$${costs.cost_usd.toFixed(4)} services=${Object.keys(costs.service_costs).join(',')}`);
  if (pendingPath) await unlink(pendingPath).catch(() => {});
  if (cancelled) {
    const message = stderr || 'cancel_requested';
    result.cancelled = true;
    result.ban_signal = { healthy: false, signal: 'cancelled' };
    await writeResult(row.id, 'cancelled', result, message, costs ?? undefined);
    await updateTrajectoryBuildAfterRun(row, 'cancelled', result, message);
    await closeCampaignItem(row.params, 'failed', message);
    await sendRunWebhook(row, 'cancelled', result, message);
    console.log(`[worker] ${row.id.slice(0, 8)} cancelled`);
  } else if (exitCode === 0 && (pending || verificationPending)) {
    if (pending) result.pending_review = pending;
    await writeResult(row.id, 'pending_review', result, verificationMessage, costs ?? undefined);
    await updateTrajectoryBuildAfterRun(row, 'pending_review', result, verificationMessage ?? 'pending_review');
    await sendRunWebhook(row, 'pending_review', result, verificationMessage);
    console.log(`[worker] ${row.id.slice(0, 8)} pending_review`);
  } else if (exitCode === 0) {
    await persistServiceCredentialReference(row, result);
    await writeResult(row.id, 'completed', result, undefined, costs ?? undefined);
    await updateTrajectoryBuildAfterRun(row, 'completed', result);
    await closeCampaignItem(row.params, 'completed');
    await sendRunWebhook(row, 'completed', result);
    console.log(`[worker] ${row.id.slice(0, 8)} completed signal=${(result.ban_signal as BanSignal).signal}`);
  } else {
    // Kick off diagnostic retry BEFORE writing the failure result so the
    // dump path can be attached to result.instrumented_dump. This doubles
    // the cost of failed runs (one extra trajectory invocation with
    // WELES_INSTRUMENT=1 set) but ensures the diff harness has data the
    // moment someone investigates. Opt out with AUTO_INSTRUMENT_RETRIES=0.
    const dumpPath = await diagnosticRetry(row, trajPath);
    if (dumpPath) result.instrumented_dump = dumpPath;
    const message = stderr || `exit ${exitCode}`;
    await writeResult(row.id, 'failed', result, message, costs ?? undefined);
    await updateTrajectoryBuildAfterRun(row, 'failed', result, message);
    await closeCampaignItem(row.params, 'failed', message);
    await sendRunWebhook(row, 'failed', result, message);
    console.log(`[worker] ${row.id.slice(0, 8)} failed exit=${exitCode}`);
  }
  return 'claimed';
}
