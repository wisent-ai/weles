/**
 * Poll account_action_logs, claim atomically, run the corresponding weles
 * trajectory as a subprocess, import the ban_signal.json, write results back.
 *
 * Handles every action name the lifecycle scheduler emits, plus the legacy
 * bundled action 'browse_and_engage' which routes to the platform's browse
 * trajectory. Replaces the cross-language Python-to-Node bridge that existed
 * when we had the Python AccountActions handle organic actions.
 *
 * No Playwright here — trajectory subprocesses own their own WSession +
 * Capture. This worker is pure orchestration (poll / claim / spawn / writeback).
 */
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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
const INSTANCE_ID = process.env.INSTANCE_ID ?? `weles-${process.pid}`;
const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT ?? 'recordings';

function headers(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

// Action-name → trajectory path. Covers both new <platform>_<verb> names
// and the legacy 'browse_and_engage' bundle (routed to <platform>/browse.mjs
// using the row's platform column).
function resolveTrajectory(action: string, platform?: string): string | null {
  if (action === 'browse_and_engage' && platform) {
    return `scripts/trajectories/${platform}/browse.mjs`;
  }
  const firstUnderscore = action.indexOf('_');
  if (firstUnderscore < 0) return null;
  const plat = action.slice(0, firstUnderscore);
  const verb = action.slice(firstUnderscore + 1);
  const routes: Record<string, (p: string) => string> = {
    browse:                (p) => `scripts/trajectories/${p}/browse.mjs`,
    health:                (p) => p === 'github' ? 'scripts/trajectories/github/health/run.mjs' : `scripts/trajectories/${p}/health.mjs`,
    organic_comment:       (p) => `scripts/trajectories/${p}/organic_comment.mjs`,
    organic_reply:         (p) => `scripts/trajectories/${p}/organic_reply.mjs`,
    organic_message:       (p) => `scripts/trajectories/${p}/organic_message.mjs`,
    organic_issue_comment: (p) => `scripts/trajectories/${p}/actions/organic_issue_comment.mjs`,
    promote:               (p) => p === 'github' ? 'scripts/trajectories/github/actions/promote.mjs' : `scripts/trajectories/${p}/promote.mjs`,
    // Legacy flat trajectories — <platform>_<verb>.mjs at the top level.
    register:              (p) => p === 'github' || p === 'youtube' ? `scripts/trajectories/${p}/register.mjs` : `scripts/trajectories/${p}_register.mjs`,
    login:                 (p) => `scripts/trajectories/${p}_login.mjs`,
    like:                  (p) => `scripts/trajectories/${p}_like.mjs`,
    follow:                (p) => `scripts/trajectories/${p}_follow.mjs`,
    comment:               (p) => `scripts/trajectories/${p}_comment.mjs`,
    upvote:                (p) => `scripts/trajectories/${p}_upvote.mjs`,
    dm:                    (p) => `scripts/trajectories/${p}_dm.mjs`,
    star:                  (p) => `scripts/trajectories/${p}_star.mjs`,
  };
  const router = routes[verb];
  return router ? router(plat) : null;
}

async function claimOne(): Promise<ActionLogRow | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/account_action_logs?select=id,account_id,action,platform,params,status&status=eq.queued&or=(scheduled_at.is.null,scheduled_at.lte.now())&order=scheduled_at.asc.nullsfirst&limit=10`,
    { headers: headers() },
  );
  if (!res.ok) return null;
  const candidates = (await res.json()) as ActionLogRow[];
  for (const row of candidates) {
    if (!resolveTrajectory(row.action, row.platform)) continue;
    const claim = await fetch(
      `${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${row.id}&status=eq.queued`,
      {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'running', claimed_by: INSTANCE_ID,
          claimed_at: new Date().toISOString(), started_at: new Date().toISOString(),
        }),
      },
    );
    if (!claim.ok) continue;
    const claimed = (await claim.json()) as ActionLogRow[];
    if (claimed.length > 0) return claimed[0];
  }
  return null;
}

function paramsToEnv(params: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  if (typeof params.subreddit === 'string') env.SUBREDDIT = params.subreddit;
  if (typeof params.product_id === 'string') env.PRODUCT_ID = params.product_id;
  if (typeof params.variant === 'string') env.VARIANT = params.variant;
  if (typeof params.issue_url === 'string') env.ISSUE_URL = params.issue_url;
  if (typeof params.server_channel_path === 'string') env.SERVER_CHANNEL_PATH = params.server_channel_path;
  if (typeof params.scrolls === 'number') env.SCROLL_COUNT = String(params.scrolls);
  if (typeof params.posts_to_browse === 'number') env.SCROLL_COUNT = String(params.posts_to_browse);
  return env;
}

async function runTrajectory(row: ActionLogRow, path: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [path], {
      env: { ...process.env, ...paramsToEnv(row.params ?? {}) },
      cwd: process.cwd(),
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stderr: stderr.slice(-2000) }));
  });
}

async function readBanSignal(action: string, platform?: string): Promise<BanSignal | null> {
  const label = action === 'browse_and_engage' && platform ? `${platform}_browse` : action;
  const path = join(RECORDINGS_ROOT, label, 'ban_signal.json');
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as BanSignal;
  } catch { return null; }
}

async function importHealthSnapshot(accountId: string, platform: string): Promise<{ signal: string; karma: number | null; shadowbanned: boolean } | null> {
  const dir = join(RECORDINGS_ROOT, `${platform}_health`);
  let snapshot: any = null;
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1];
    const raw = await readFile(join(dir, latest), 'utf8');
    snapshot = JSON.parse(raw);
    if (snapshot.account_id !== accountId) return null;
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

async function pauseAccount(accountId: string, hours = 24): Promise<void> {
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${accountId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ paused_until: until }),
  }).catch(() => {});
}

async function writeResult(jobId: string, status: 'completed' | 'failed', result: Record<string, unknown>, error?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${jobId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      status, result, error: error ?? null,
      completed_at: new Date().toISOString(),
    }),
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
  const row = await claimOne();
  if (!row) return 'idle';
  const trajPath = resolveTrajectory(row.action, row.platform);
  if (!trajPath) {
    await writeResult(row.id, 'failed', {}, `no trajectory for action=${row.action}`);
    return 'claimed';
  }
  console.log(`[worker] claimed ${row.id.slice(0, 8)} action=${row.action} account=${row.account_id.slice(0, 8)} -> ${trajPath}`);

  const { exitCode, stderr } = await runTrajectory(row, trajPath);
  const banSignal = await readBanSignal(row.action, row.platform);
  const result: Record<string, unknown> = {};
  if (banSignal) {
    result.ban_signal = banSignal;
    if (banSignal.healthy === false) await pauseAccount(row.account_id);
  } else {
    result.ban_signal = { healthy: exitCode === 0, signal: exitCode === 0 ? 'healthy' : 'unknown_error' };
  }
  if (row.action.endsWith('_health')) {
    const platform = row.action.slice(0, -'_health'.length);
    const snap = await importHealthSnapshot(row.account_id, platform);
    if (snap) result.health_snapshot = snap;
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
  if (exitCode === 0) {
    await writeResult(row.id, 'completed', result);
    console.log(`[worker] ${row.id.slice(0, 8)} completed signal=${(result.ban_signal as BanSignal).signal}`);
  } else {
    await writeResult(row.id, 'failed', result, stderr || `exit ${exitCode}`);
    console.log(`[worker] ${row.id.slice(0, 8)} failed exit=${exitCode}`);
  }
  return 'claimed';
}
