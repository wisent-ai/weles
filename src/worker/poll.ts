// Worker: poll account_action_logs, claim atomically, spawn weles trajectory
// subprocess, import ban_signal + pending_review if present, write back. Pure
// orchestration — trajectories own their own WSession + Capture.
import { spawn } from 'node:child_process';
import { readFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadArtifacts } from './upload-artifacts.js';

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

// Action-name → trajectory path. Maps <platform>_<verb> rows.
function resolveTrajectory(action: string): string | null {
  const firstUnderscore = action.indexOf('_');
  if (firstUnderscore < 0) return null;
  const plat = action.slice(0, firstUnderscore);
  const verb = action.slice(firstUnderscore + 1);
  // Benign verbs (dwell/notifications/search/profile_view) share the universal runner with PLATFORM+VERB env; specialized verbs map to specific files; legacy flat <plat>_<verb>.mjs kept as-is.
  const benignPath = 'scripts/trajectories/_shared/benign.mjs';
  const routes: Record<string, (p: string) => string> = {
    dwell: () => benignPath, notifications: () => benignPath, search: () => benignPath, profile_view: () => benignPath,
    browse: (p) => p === 'github' ? 'scripts/trajectories/github/actions/browse.mjs' : `scripts/trajectories/${p}/browse.mjs`,
    health: (p) => p === 'github' ? 'scripts/trajectories/github/health/run.mjs' : `scripts/trajectories/${p}/health.mjs`,
    organic_comment: (p) => `scripts/trajectories/${p}/organic_comment.mjs`, organic_reply: (p) => `scripts/trajectories/${p}/organic_reply.mjs`, organic_message: (p) => `scripts/trajectories/${p}/organic_message.mjs`,
    organic_issue_comment: (p) => `scripts/trajectories/${p}/actions/organic_issue_comment.mjs`,
    promote: (p) => p === 'github' ? 'scripts/trajectories/github/actions/promote.mjs' : `scripts/trajectories/${p}/promote.mjs`,
    register: (p) => p === 'github' || p === 'youtube' ? `scripts/trajectories/${p}/register.mjs` : `scripts/trajectories/${p}_register.mjs`,
    login: (p) => `scripts/trajectories/${p}_login.mjs`, comment: (p) => `scripts/trajectories/${p}_comment.mjs`, dm: (p) => `scripts/trajectories/${p}_dm.mjs`,
    // Twitter + Instagram have deterministic Playwright variants at the root; the platform/actions/ agent-loop variants hit max-iter on X's heart icon. Prefer root variants where the deterministic file exists.
    like: (p) => p === 'twitter' || p === 'instagram' ? `scripts/trajectories/${p}_like.mjs` : (p === 'linkedin' || p === 'tiktok') ? `scripts/trajectories/${p}/actions/like.mjs` : `scripts/trajectories/${p}_like.mjs`,
    follow: (p) => p === 'twitter' || p === 'instagram' ? `scripts/trajectories/${p}_follow.mjs` : (p === 'reddit' || p === 'tiktok' || p === 'github') ? `scripts/trajectories/${p}/actions/follow.mjs` : `scripts/trajectories/${p}_follow.mjs`,
    upvote: (p) => p === 'reddit' ? 'scripts/trajectories/reddit/actions/upvote.mjs' : `scripts/trajectories/${p}_upvote.mjs`,
    star: (p) => p === 'github' ? 'scripts/trajectories/github/star/run.mjs' : `scripts/trajectories/${p}_star.mjs`,
    create_repo: (p) => `scripts/trajectories/${p}/content/create_repo.mjs`, commit: (p) => `scripts/trajectories/${p}/content/commit.mjs`, fork: (p) => `scripts/trajectories/${p}/content/fork.mjs`, open_issue: (p) => `scripts/trajectories/${p}/content/open_issue.mjs`,
    post: (p) => `scripts/trajectories/${p}/content/post.mjs`, post_promote: (p) => `scripts/trajectories/${p}/content/post.mjs`, submit: (p) => `scripts/trajectories/${p}/content/submit.mjs`, submit_promote: (p) => `scripts/trajectories/${p}/content/submit.mjs`,
    connect: (p) => `scripts/trajectories/${p}/actions/connect.mjs`, endorse: (p) => `scripts/trajectories/${p}/actions/endorse.mjs`, react: (p) => `scripts/trajectories/${p}/actions/react.mjs`,
    join_server: (p) => `scripts/trajectories/${p}/actions/join_server.mjs`, join_sub: (p) => `scripts/trajectories/${p}/actions/join_sub.mjs`, watch_repo: (p) => `scripts/trajectories/${p}/actions/watch_repo.mjs`,
    story_view: (p) => `scripts/trajectories/${p}/actions/story_view.mjs`, watch_through: (p) => `scripts/trajectories/${p}/actions/watch_through.mjs`,
    bookmark: (p) => `scripts/trajectories/${p}/actions/bookmark.mjs`, save: (p) => `scripts/trajectories/${p}/actions/save.mjs`,
    reset_password: (p) => p === 'github' ? 'scripts/trajectories/github/recover/reset_password.mjs' : `scripts/trajectories/${p}_reset_password.mjs`,
  };
  const router = routes[verb];
  return router ? router(plat) : null;
}

async function claimOne(): Promise<ActionLogRow | null> {
  // Lookahead 100 rows so the in-flight per-account lock can find a claimable row even when the first dozen queued items all belong to one in-flight account (common: a verification batch enqueues 10+ rows for one account; with limit=10 the worker would idle until those drained).
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/account_action_logs?select=id,account_id,action,platform,params,status&status=eq.queued&or=(scheduled_at.is.null,scheduled_at.lte.now())&order=scheduled_at.asc.nullsfirst&limit=100`,
    { headers: headers() },
  );
  if (!res.ok) return null;
  const candidates = (await res.json()) as ActionLogRow[];
  // Per-account in-flight lock: each account has ONE stored sticky proxy session (Oxylabs sessid). Concurrent connections to one sticky session get refused with ERR_TUNNEL_CONNECTION_FAILED. Serialize per-account; deferred rows pick up next tick. Ignore rows older than 30 min — those are stuck-poison from killed workers and should not block their account forever.
  const inflightAccounts = new Set<string>();
  if (candidates.length) {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?select=account_id,claimed_at&status=eq.running&claimed_at=gte.${cutoff}`, { headers: headers() });
    if (r.ok) for (const row of (await r.json()) as { account_id: string | null }[]) if (row.account_id) inflightAccounts.add(row.account_id);
  }
  const { staleCookieAccounts } = await import('./stale.js');
  const staleAccounts = await staleCookieAccounts(candidates);
  for (const row of candidates) {
    if (!resolveTrajectory(row.action)) continue;
    if (!row.account_id || !row.id) continue; // poison rows: legacy promote-cron sometimes emits orphans
    if (inflightAccounts.has(row.account_id)) continue;
    if (staleAccounts.has(row.account_id)) continue;

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

function paramsToEnv(params: Record<string, unknown>, action: string, trajPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  // Benign runner dispatches on PLATFORM + VERB derived from the action name.
  if (trajPath.endsWith('/_shared/benign.mjs')) {
    const underscore = action.indexOf('_');
    if (underscore > 0) {
      env.PLATFORM = action.slice(0, underscore);
      env.VERB = action.slice(underscore + 1);
    }
  }
  if (typeof params.subreddit === 'string') env.SUBREDDIT = params.subreddit;
  if (typeof params.product_id === 'string') env.PRODUCT_ID = params.product_id;
  if (typeof params.variant === 'string') env.VARIANT = params.variant;
  if (typeof params.issue_url === 'string') env.ISSUE_URL = params.issue_url;
  if (typeof params.server_channel_path === 'string') env.SERVER_CHANNEL_PATH = params.server_channel_path;
  if (typeof params.scrolls === 'number') env.SCROLL_COUNT = String(params.scrolls);
  if (typeof params.posts_to_browse === 'number') env.SCROLL_COUNT = String(params.posts_to_browse);
  if (typeof params.search_query === 'string') env.SEARCH_QUERY = params.search_query;
  if (typeof params.target_user === 'string') env.TARGET_USER = params.target_user;
  if (typeof params.target_url === 'string') env.TARGET_URL = params.target_url;
  if (typeof params.invite_url === 'string') env.INVITE_URL = params.invite_url;
  if (typeof params.repo_url === 'string') env.REPO_URL = params.repo_url;
  if (typeof params.text === 'string') env.SVC_TEXT = params.text;
  if (action.endsWith('_post_promote') || action.endsWith('_submit_promote')) env.POST_PROMOTE = '1';
  for (const [k, ek] of [['repo_name','REPO_NAME'],['repo_desc','REPO_DESC'],['file_path','FILE_PATH'],['file_append','FILE_APPEND'],['commit_message','COMMIT_MESSAGE'],['issue_title','ISSUE_TITLE'],['issue_body','ISSUE_BODY']]) if (typeof params[k] === 'string') env[ek] = params[k];
  if (params.require_approval === true) env.REQUIRE_APPROVAL = '1';
  return env;
}

async function runTrajectory(row: ActionLogRow, path: string): Promise<{ exitCode: number; stderr: string }> {
  // Delete stale ban_signal.json from prior run — same recordings/<action>/
  // dir is shared across runs, so a killed predecessor would otherwise be
  // attributed to this row.
  try { await (await import('node:fs/promises')).unlink(join(RECORDINGS_ROOT, row.action, 'ban_signal.json')).catch(() => {}); } catch { /* noop */ }
  return new Promise((resolve) => {
    const child = spawn('node', [path], {
      env: { ...process.env, ...paramsToEnv(row.params ?? {}, row.action, path), ACCOUNT_ID: row.account_id, ACTION_LOG_ID: row.id },
      cwd: process.cwd(), stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stderr: stderr.slice(-2000) }));
  });
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
  // ip_blocked / proxy_failed are proxy-level signals — the platform refused
  // the EXIT IP, not the account itself. Burn the proxy, NOT the account.
  // markBurned at the call site handles proxy rotation; here we just skip the
  // pauseUntil so the account stays available for the next IP.
  if (signal === 'ip_blocked' || signal === 'proxy_failed' || signal === 'proxy_auth_failed') return;
  const hard = signal ? ['suspended', 'shadowbanned'].includes(signal) : false;
  const body: Record<string, unknown> = { paused_until: new Date(Date.now() + hours * 3600_000).toISOString() };
  if (hard) { body.status = 'flagged'; body.is_active = false; }
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${accountId}`, { method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify(body) }).catch(() => {});
}

async function writeResult(jobId: string, status: 'completed' | 'failed' | 'pending_review', result: Record<string, unknown>, error?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${jobId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      status, result, error: error ?? null,
      completed_at: new Date().toISOString(),
    }),
  }).catch(() => {});
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
  const result: Record<string, unknown> = {};
  try { const m = JSON.parse(await readFile(join(RECORDINGS_ROOT, row.action, 'session_meta.json'), 'utf8')); result.session = { proxy_host: m.proxy_host, proxy_port: m.proxy_port, proxy_user: m.proxy_user, exit_ip: m.exit_ip, platform: m.platform }; } catch {}
  if (banSignal) {
    result.ban_signal = banSignal;
    if (banSignal.healthy === false) await pauseAccount(row.account_id, banSignal.signal);
    if (banSignal.signal === 'ip_blocked' || banSignal.signal === 'proxy_auth_failed') { const s = result.session as any; const t = s?.exit_ip || s?.proxy_host; if (t) { const { markBurned } = await import('../proxy/burned.js'); await markBurned(t, banSignal.signal, row.platform); } }
  } else {
    result.ban_signal = { healthy: exitCode === 0, signal: exitCode === 0 ? 'healthy' : 'unknown_error' };
  }
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
  const pendingPath = join(RECORDINGS_ROOT, row.action, 'pending_review.json');
  let pending: Record<string, unknown> | null = null;
  try { pending = JSON.parse(await readFile(pendingPath, 'utf8')); await unlink(pendingPath); } catch { pending = null; }
  if (exitCode === 0 && pending) {
    result.pending_review = pending;
    await writeResult(row.id, 'pending_review', result);
    console.log(`[worker] ${row.id.slice(0, 8)} pending_review`);
  } else if (exitCode === 0) {
    await writeResult(row.id, 'completed', result);
    await closeCampaignItem(row.params, 'completed');
    console.log(`[worker] ${row.id.slice(0, 8)} completed signal=${(result.ban_signal as BanSignal).signal}`);
  } else {
    await writeResult(row.id, 'failed', result, stderr || `exit ${exitCode}`);
    await closeCampaignItem(row.params, 'failed', stderr || `exit ${exitCode}`);
    console.log(`[worker] ${row.id.slice(0, 8)} failed exit=${exitCode}`);
  }
  return 'claimed';
}
