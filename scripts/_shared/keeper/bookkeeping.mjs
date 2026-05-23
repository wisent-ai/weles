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

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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

export async function setupKeeperFlow({ session, platform, action, accountId, proxyUrl, sessionMeta, captureVersionsFn, uploadArtifactsFn, getLastUrl }) {
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
    const artifacts = await uploadOrNull(uploadArtifactsFn, `keeper-${session}`, flowRowId, runStart);
    const versionsAtEnd = captureVersionsFn ? captureVersionsFn('scripts/_shared/keeper/keeper.mjs') : null;
    const result = { session: sessionMetaInitial, ban_signal: banSignal ?? { healthy: status === 'completed', signal: status === 'completed' ? 'keeper_completed' : 'keeper_failed' }, versions: versionsAtEnd, artifacts };
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
