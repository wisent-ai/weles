// Worker: poll account_action_logs, claim atomically, spawn weles trajectory
// subprocess, import ban_signal + pending_review if present, write back. Pure
// orchestration — trajectories own their own WSession + Capture.
import { spawn } from 'node:child_process';
import { readFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadArtifacts } from './upload-artifacts.js';
import { paramsToEnv, resolveTrajectory } from './dispatch.js';
import { claimOne } from './claim.js';
import { sweepZombiesIfDue } from './stale.js';
import { captureVersions } from '../diagnostics/versions.js';

export interface ActionLogRow {
  id: string;
  account_id: string;
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
  // Delete stale ban_signal.json from prior run — same recordings/<action>/
  // dir is shared across runs, so a killed predecessor would otherwise be
  // attributed to this row.
  try { await (await import('node:fs/promises')).unlink(join(RECORDINGS_ROOT, row.action, 'ban_signal.json')).catch(() => {}); } catch { /* noop */ }
  // Hard wall-clock cap. Health/probe 90s; topup 360s; register/login 900s
  // (bumped from 600s 2026-05-05: CapMonster->CapSolver->AntiCaptcha V2
  // fall-through can take 12+ min). Override per-row via WORKER_HARD_TIMEOUT_MS.
  const overrideMs = Number(process.env.WORKER_HARD_TIMEOUT_MS ?? 0);
  const defaultMs = row.action.endsWith('_health') || row.action.endsWith('_balance') ? 90_000
    : row.action.endsWith('_topup') ? 360_000
    : row.action.endsWith('_register') || row.action.endsWith('_login') ? 900_000
    : 360_000;
  const hardTimeoutMs = overrideMs > 0 ? overrideMs : defaultMs;
  return new Promise((resolve) => {
    const child = spawn('node', [path], {
      env: { ...process.env, ...paramsToEnv(row.params ?? {}, row.action, path), ...extraEnv, ACCOUNT_ID: row.account_id, ACTION_LOG_ID: row.id, ACTION: row.action },
      cwd: process.cwd(), stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      stderr += `\nFAIL: worker hard timeout (${hardTimeoutMs}ms) — sent SIGKILL`;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
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
async function diagnosticRetry(row: ActionLogRow, path: string): Promise<string | null> {
  if (process.env.AUTO_INSTRUMENT_RETRIES === '0') return null;
  if (process.env.WELES_INSTRUMENT !== '0') return null; // already instrumented (default-on)
  const SKIP_SUFFIXES = ['_balance', '_topup', '_health'];
  if (SKIP_SUFFIXES.some((s) => row.action.endsWith(s))) return null;
  console.log(`[worker] ${row.id.slice(0, 8)} diagnostic retry with WELES_INSTRUMENT=1 ...`);
  try {
    await runTrajectory(row, path, { WELES_INSTRUMENT: '1' });
  } catch (e) {
    console.log(`[worker] ${row.id.slice(0, 8)} diagnostic retry error: ${(e as Error).message?.slice(0, 200)}`);
  }
  // Find newest matching dump.
  try {
    const { readdirSync, statSync } = await import('node:fs');
    const instDir = join(process.cwd(), '.work', 'inst');
    const trajLabel = path.split('/').pop()?.replace(/\.mjs$/, '') ?? '';
    const dumps = readdirSync(instDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('chrome_'))
      .map((f) => ({ f, full: join(instDir, f), m: statSync(join(instDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    const match = dumps.find((d) => d.f.startsWith(`${trajLabel}_`)) || dumps[0];
    if (match) {
      console.log(`[worker] ${row.id.slice(0, 8)} instrumented dump -> ${match.full}`);
      console.log(`[worker]   review with: node scripts/debug/diff_trajectory.mjs ${path}`);
      return match.full;
    }
  } catch { /* noop */ }
  return null;
}

async function readBanSignal(action: string): Promise<BanSignal | null> {
  const path = join(RECORDINGS_ROOT, action, 'ban_signal.json');
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as BanSignal;
  } catch { return null; }
}

async function importHealthSnapshot(accountId: string, platform: string): Promise<{ signal: string; karma: number | null; shadowbanned: boolean } | null> {
  const dir = join(RECORDINGS_ROOT, `${platform}_health`);
  let snapshot: any = null;
  try {
    // Scan newest-first (by mtime); pick the file matching accountId. Plain
    // alphabetical sort picks a different account's file and returns null.
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const stats = await Promise.all(files.map(async (f) => ({ f, m: (await stat(join(dir, f))).mtimeMs })));
    for (const { f } of stats.sort((a, b) => b.m - a.m)) {
      const parsed = JSON.parse(await readFile(join(dir, f), 'utf8'));
      if (parsed.account_id === accountId) { snapshot = parsed; break; }
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

async function importCreatedAccount(action: string): Promise<{ id: string; username: string; platform: string } | null> {
  // WSession.saveAccount writes recordings/<label>/account.json after a successful
  // POST to social_accounts. Label for register trajectories = action name.
  const path = join(RECORDINGS_ROOT, action, 'account.json');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
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

export async function pollOnce(): Promise<'claimed' | 'idle' | 'error'> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[worker] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    return 'error';
  }
  if (!(await workersEnabled())) return 'idle';
  await sweepZombiesIfDue();
  const row = await claimOne();
  if (!row) return 'idle';
  const trajPath = resolveTrajectory(row.action);
  if (!trajPath) {
    await writeResult(row.id, 'failed', {}, `no trajectory for action=${row.action}`);
    return 'claimed';
  }
  console.log(`[worker] claimed ${row.id.slice(0, 8)} action=${row.action} account=${row.account_id.slice(0, 8)} -> ${trajPath}`);

  const runStart = new Date();
  const { exitCode, stderr } = await runTrajectory(row, trajPath);
  const banSignal = await readBanSignal(row.action);
  const result: Record<string, unknown> = { versions: captureVersions(trajPath) };
  try { const m = JSON.parse(await readFile(join(RECORDINGS_ROOT, row.action, 'session_meta.json'), 'utf8')); result.session = { proxy_host: m.proxy_host, proxy_port: m.proxy_port, proxy_user: m.proxy_user, exit_ip: m.exit_ip, platform: m.platform, provider: m.provider }; } catch {}
  // IP-drift detection: first session stores observed exit_ip; subsequent sessions compare, mismatch -> ip_drift + pause.
  try { const ip = (result.session as any)?.exit_ip; if (ip && row.account_id) { const r = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${row.account_id}&select=metadata`, { headers: headers() }); if (r.ok) { const j = await r.json() as any[]; const m = j[0]?.metadata ?? {}; const stored = m.proxy?.exit_ip; if (!stored) { const nm = { ...m, proxy: { ...(m.proxy ?? {}), exit_ip: ip } }; await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${row.account_id}`, { method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: nm }) }); } else if (stored !== ip) { result.ban_signal = { healthy: false, signal: 'ip_drift', details: { expected: stored, observed: ip } }; await pauseAccount(row.account_id, 'ip_drift'); } } } } catch (e) { console.log('[ip-drift]', e instanceof Error ? e.message : String(e)); }
  if (banSignal) {
    result.ban_signal = banSignal;
    if (banSignal.healthy === false) await pauseAccount(row.account_id, banSignal.signal);
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
  if (row.action.endsWith('_health')) {
    const snap = await importHealthSnapshot(row.account_id, row.action.slice(0, -'_health'.length));
    if (snap) { result.health_snapshot = snap; result.ban_signal = { healthy: snap.signal === 'healthy', signal: snap.signal }; }
  }
  if (row.action.endsWith('_register')) {
    const created = await importCreatedAccount(row.action);
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
  const costs = await readCosts(row.id);
  if (costs) console.log(`[worker] ${row.id.slice(0, 8)} cost=$${costs.cost_usd.toFixed(4)} services=${Object.keys(costs.service_costs).join(',')}`);
  const pendingPath = join(RECORDINGS_ROOT, row.action, 'pending_review.json');
  let pending: Record<string, unknown> | null = null;
  try { pending = JSON.parse(await readFile(pendingPath, 'utf8')); await unlink(pendingPath); } catch { pending = null; }
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
