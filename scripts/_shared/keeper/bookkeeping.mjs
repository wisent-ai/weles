// Database bookkeeping for keeper-driven flows.
//
// The keeper today writes nothing to account_action_logs. Successful flows
// leave a side-effect (social_accounts row via save_account); failed flows
// leave no trace at all, so keeper attempts are uncountable and the
// burn-attribution matcher can't pair them against worker rows.
//
// This module emits account_action_logs rows that match the worker schema:
//   - setupKeeperFlow inserts status='running' at keeper start, registers
//     SIGINT/SIGTERM handlers that PATCH the row to status='failed', and
//     returns a `close(status, banSignal, savedAccountId)` helper for the
//     keeper to call from save_account / mark_failed dispatches.
//
// The returned `close` writes the same result.{session,ban_signal,artifacts,
// versions,account_id} shape the worker emits, so keeper rows are
// pair-eligible by the burn-attribution matcher.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT || 'recordings';

function headers() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

async function insertOpen(body) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs`, {
    method: 'POST', headers: { ...headers(), Prefer: 'return=representation' }, body: JSON.stringify(body),
  });
  if (!res.ok) { console.log(`[keeper-bookkeeping] open INSERT failed http=${res.status}`); return null; }
  const row = (await res.json())[0];
  return row?.id ?? null;
}

async function patchClose(rowId, body) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !rowId) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=eq.${rowId}`, {
    method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });
  if (!res.ok) { console.log(`[keeper-bookkeeping] close PATCH failed http=${res.status}`); return false; }
  return true;
}

async function uploadOrNull(uploadFn, label, rowId, runStart) {
  if (!uploadFn) return null;
  try { return await uploadFn(label, rowId, runStart, { force: true }); }
  catch (e) { console.log(`[keeper-bookkeeping] uploadArtifacts threw: ${e?.message?.slice(0, 100) ?? String(e).slice(0, 100)}`); return null; }
}

async function findInRun(rowId, filename) {
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      } else if (e.name === filename) {
        return full;
      }
    }
    return null;
  }
  return walk(join(RECORDINGS_ROOT, rowId));
}

async function readJsonInRun(rowId, filename) {
  if (!rowId) return null;
  const p = await findInRun(rowId, filename);
  if (!p) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

function sessionFromMeta(meta, fallback) {
  if (!meta || typeof meta !== 'object') return fallback;
  return {
    proxy_host: meta.proxy_host,
    proxy_port: meta.proxy_port,
    proxy_user_present: !!meta.proxy_user_present,
    proxy_user_hash: meta.proxy_user_hash ?? null,
    exit_ip: meta.exit_ip,
    platform: meta.platform,
    provider: meta.provider,
    browser_provenance: meta.browser_provenance,
    persona: meta.persona,
    realized_fingerprint: meta.realized_fingerprint,
    env_flags: meta.env_flags,
    env_all: meta.env_all,
    sticky_session_id: meta.sticky_session_id,
    sticky_hash: meta.sticky_hash,
    exit_reputation: meta.exit_reputation,
  };
}

export async function setupKeeperFlow({ session, platform, action, accountId, proxyUrl, sessionMeta, captureVersionsFn, uploadArtifactsFn, getLastUrl, closeSessionFn }) {
  const runStart = new Date();
  const versionsAtStart = captureVersionsFn ? captureVersionsFn('scripts/_shared/keeper/keeper.mjs') : null;
  const sessionMetaInitial = sessionMeta ?? { provider: 'keeper', proxy_url: proxyUrl ?? null, platform: platform ?? null };
  const flowRowId = await insertOpen({
    account_id: accountId ?? null, action, platform: platform ?? null,
    status: 'running', started_at: runStart.toISOString(), scheduled_at: runStart.toISOString(),
    params: { keeper: true, keeper_session: session, proxy_url_override: proxyUrl ?? null, keeper_started_versions: versionsAtStart },
    result: { session: sessionMetaInitial, ban_signal: { healthy: null, signal: 'keeper_running' } },
  });
  let closed = false;
  async function close(status, banSignal, savedAccountId) {
    if (closed || !flowRowId) return;
    closed = true;
    // Close WSession FIRST so finalize.ts wsClose runs: captures DOM via
    // _cap.save, renames page@<hash>.webm into the labeled subdir, writes
    // network.ndjson, dumps __inst flush. Otherwise uploadArtifacts runs
    // before any of those files exist on disk.
    if (closeSessionFn) {
      try { await closeSessionFn(); }
      catch (e) { console.log(`[keeper-bookkeeping] closeSession err: ${e?.message?.slice(0, 100) ?? String(e).slice(0, 100)}`); }
    }
    const artifacts = await uploadOrNull(uploadArtifactsFn, `keeper-${session}`, flowRowId, runStart);
    const versionsAtEnd = captureVersionsFn ? captureVersionsFn('scripts/_shared/keeper/keeper.mjs') : null;
    const meta = await readJsonInRun(flowRowId, 'session_meta.json');
    const captcha = await readJsonInRun(flowRowId, 'captcha_events.json');
    const result = {
      session: sessionFromMeta(meta, sessionMetaInitial),
      ban_signal: banSignal ?? { healthy: status === 'completed', signal: status === 'completed' ? 'keeper_completed' : 'keeper_failed' },
      versions: versionsAtEnd,
      artifacts,
    };
    if (meta?.identity) result.identity = meta.identity;
    if (typeof meta?.timing_seed === 'number') result.run = { timing_seed: meta.timing_seed };
    if (captcha) result.captcha = captcha;
    if (savedAccountId) result.account_id = savedAccountId;
    await patchClose(flowRowId, { status, completed_at: new Date().toISOString(), result });
    console.log(`[keeper-bookkeeping] closed row=${flowRowId.slice(0, 8)} status=${status}`);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      const last = getLastUrl ? getLastUrl() : null;
      await close('failed', { healthy: false, signal: 'keeper_abandoned', details: { last_url: last } }, null);
      process.exit(0);
    });
  }
  return { rowId: flowRowId, close };
}
