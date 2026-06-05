// Worker: poll account_action_logs, claim atomically, spawn weles trajectory
// subprocess, import ban_signal + pending_review if present, write back. Pure
// orchestration — trajectories own their own WSession + Capture.
import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { uploadArtifacts } from './upload-artifacts.js';
import { paramsToEnv, resolveTrajectory } from './dispatch.js';
import { claimOne } from './claim.js';
import { sweepZombiesIfDue } from './stale.js';
import { captureVersions } from '../diagnostics/versions.js';
import { importRunProvenance, writeNetworkCapture, pgConnectionString } from '../diagnostics/run-import.js';
import postgres from 'postgres';

export interface ActionLogRow {
  id: string;
  account_id: string | null;
  action: string;
  platform?: string;
  params?: Record<string, unknown>;
  status?: string;
}

export interface BanSignal { healthy: boolean; signal: string; details?: Record<string, unknown>; }

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT ?? 'recordings';

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

async function runTrajectory(row: ActionLogRow, path: string, extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; stderr: string }> {
  // G17: recordings/<run_uuid>/ is unique per run, so there is no stale
  // predecessor file to clear (the old shared recordings/<action>/ hazard is gone).
  // Hard wall-clock cap. Health/probe 90s; topup 360s; register/login 900s
  // (bumped from 600s 2026-05-05: CapMonster->CapSolver->AntiCaptcha V2
  // fall-through can take 12+ min). Override per-row via WORKER_HARD_TIMEOUT_MS.
  const overrideMs = Number(process.env.WORKER_HARD_TIMEOUT_MS ?? 0);
  const defaultMs = row.action.endsWith('_health') || row.action.endsWith('_balance') ? 90_000
    : row.action.endsWith('_topup') ? 360_000
    : row.action.endsWith('_register') || row.action.endsWith('_login') ? 900_000
    // verify_domain_status sends probes then polls receiving twice (batch +
    // confirmation re-probe), up to ~4-5 min; give it headroom over the default.
    : row.action.endsWith('_verify_domain_status') ? 600_000
    : 360_000;
  const hardTimeoutMs = overrideMs > 0 ? overrideMs : defaultMs;
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
        ...(row.account_id ? { ACCOUNT_ID: row.account_id } : {}),
        ACTION_LOG_ID: row.id,
        ACTION: row.action,
      },
      cwd: process.cwd(), stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    let killed = false;
    // G17g: graceful timeout — SIGTERM first so WSession's handler can close the
    // context (sealing HAR + video), then SIGKILL after a grace window. Avoids
    // losing the whole HAR/video on a timed-out run.
    const killTimer = setTimeout(() => {
      killed = true;
      stderr += `\nFAIL: worker hard timeout (${hardTimeoutMs}ms) — SIGTERM, then SIGKILL after grace`;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 8000);
    }, hardTimeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ exitCode: killed ? 137 : (code ?? -1), stderr: stderr.slice(-2000) });
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

async function writeResult(jobId: string, status: 'completed' | 'failed' | 'pending_review', result: Record<string, unknown>, error?: string, costs?: { cost_usd: number; service_costs: Record<string, number> }): Promise<void> {
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
    await writeResult(row.id, 'failed', {}, `no trajectory for action=${row.action}`);
    return 'claimed';
  }
  console.log(`[worker] claimed ${row.id.slice(0, 8)} action=${row.action} account=${row.account_id?.slice(0, 8) ?? 'none'} -> ${trajPath}`);

  const runStart = new Date();
  const { exitCode, stderr } = await runTrajectory(row, trajPath);
  const banSignal = await readBanSignal(row.id);
  const result: Record<string, unknown> = { versions: captureVersions(trajPath) };
  // G5: when the run executed against a dirty repo/trajectory, mirror the full
  // working-tree diff (already captured in result.versions.dirty_diff) to
  // recordings/<action>/source_diff.patch for the storage backup. upload-artifacts
  // allowlists .patch -> 'logs'. Best-effort; never fails the run.
  try {
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
  const prov = await importRunProvenance(row.id, row.params);
  if (prov.session) result.session = prov.session;
  if (prov.identity) result.identity = prov.identity;
  if (prov.run) result.run = prov.run;
  if (prov.challenge_outcome) result.challenge_outcome = prov.challenge_outcome;
  // G8: full per-run captcha event log — challenge_faced flag plus the complete
  // attempt/marker sequence (every solve, every all-providers-failed marker),
  // verbatim. Absent file (no session label) => skipped. A no-captcha run still
  // produces {challenge_faced:false, events:[]}, distinct from a missing file.
  {
    const cap = await readJsonInRun(row.id, 'captcha_events.json');
    if (cap) result.captcha = cap;
  }
  // IP-drift detection: first session stores observed exit_ip; subsequent sessions compare, mismatch -> ip_drift + pause.
  try { const ip = (result.session as any)?.exit_ip; if (ip && row.account_id) { const r = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${row.account_id}&select=metadata`, { headers: headers() }); if (r.ok) { const j = await r.json() as any[]; const m = j[0]?.metadata ?? {}; const stored = m.proxy?.exit_ip; if (!stored) { const nm = { ...m, proxy: { ...(m.proxy ?? {}), exit_ip: ip } }; await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${row.account_id}`, { method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: nm }) }); } else if (stored !== ip) { result.ban_signal = { healthy: false, signal: 'ip_drift', details: { expected: stored, observed: ip } }; await pauseAccount(row.account_id, 'ip_drift'); } } } } catch (e) { console.log('[ip-drift]', e instanceof Error ? e.message : String(e)); }
  if (banSignal) {
    result.ban_signal = banSignal;
    if (banSignal.healthy === false && row.account_id) await pauseAccount(row.account_id, banSignal.signal);
    // NOTE: previous version wrote unconditional IP burns on ip_blocked / proxy_auth_failed signals. That was paired-comparison-incorrect by symmetry with the _register burn writer reverted in 4cd2eb4. Removed for consistency — the burn-attribution cron (content-platform src/lib/burn-attribution/runner.ts) is now the sole writer to system_settings.burned_proxies, and only on paired counterfactuals.
    // NOTE: previous version wrote unconditional (domain, ip, host) burns on every _register failure. That was paired-comparison-incorrect — a single failure with no counterfactual cannot isolate which factor caused the failure. Removed b5235af → see this commit. Domain/IP attribution must come from a paired (fail, pass) matcher that observes one factor changed and outcome flipped.
  } else {
    result.ban_signal = { healthy: exitCode === 0, signal: exitCode === 0 ? 'healthy' : 'unknown_error' };
  }
  // Capability-matrix update: record (provider, action) outcome so the
  // selector self-heals as providers go bad / recover. Skips when provider
  // unknown (direct egress) or signal is non-classifying (script error).
  try {
    const { recordOutcome } = await import('../proxy/capability.js');
    const s = result.session as any;
    const finalSignal = (result.ban_signal as BanSignal).signal;
    const finalStatus = exitCode === 0 ? 'completed' : 'failed';
    if (s?.provider) await recordOutcome(s.provider, row.action, finalStatus, finalSignal, row.platform);
  } catch { /* best-effort */ }
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
  // Always upload so every run has recordings on the detail page.
  await uploadArtifacts(row.action, row.id, runStart, { force: true }).then(a => { if (a) result.artifacts = a }).catch(() => {});
  // G18: persist the full network/instrumentation capture into the lazy
  // account_action_log_capture table (direct PG; best-effort).
  await writeNetworkCapture(row.id).catch(() => {});
  const costs = await readCosts(row.id);
  if (costs) console.log(`[worker] ${row.id.slice(0, 8)} cost=$${costs.cost_usd.toFixed(4)} services=${Object.keys(costs.service_costs).join(',')}`);
  const pendingPath = await findInRun(row.id, 'pending_review.json');
  let pending: Record<string, unknown> | null = null;
  if (pendingPath) { try { pending = JSON.parse(await readFile(pendingPath, 'utf8')); await unlink(pendingPath); } catch { pending = null; } }
  if (exitCode === 0 && pending) {
    result.pending_review = pending;
    await writeResult(row.id, 'pending_review', result, undefined, costs ?? undefined);
    console.log(`[worker] ${row.id.slice(0, 8)} pending_review`);
  } else if (exitCode === 0) {
    await writeResult(row.id, 'completed', result, undefined, costs ?? undefined);
    await closeCampaignItem(row.params, 'completed');
    console.log(`[worker] ${row.id.slice(0, 8)} completed signal=${(result.ban_signal as BanSignal).signal}`);
  } else {
    // Kick off diagnostic retry BEFORE writing the failure result so the
    // dump path can be attached to result.instrumented_dump. This doubles
    // the cost of failed runs (one extra trajectory invocation with
    // WELES_INSTRUMENT=1 set) but ensures the diff harness has data the
    // moment someone investigates. Opt out with AUTO_INSTRUMENT_RETRIES=0.
    const dumpPath = await diagnosticRetry(row, trajPath);
    if (dumpPath) result.instrumented_dump = dumpPath;
    await writeResult(row.id, 'failed', result, stderr || `exit ${exitCode}`, costs ?? undefined);
    await closeCampaignItem(row.params, 'failed', stderr || `exit ${exitCode}`);
    console.log(`[worker] ${row.id.slice(0, 8)} failed exit=${exitCode}`);
  }
  return 'claimed';
}
