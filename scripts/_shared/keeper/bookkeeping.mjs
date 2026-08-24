// Keeper run bookkeeping is stored in Skarbiec under the Stado job id.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeRunRecord } from '../../trajectories/_shared/skarbiec_accounts.mjs';

const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT || 'recordings';



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

export async function setupKeeperFlow({ session, platform, action, accountId, proxyUrl, sessionMeta, diagnostic, captureVersionsFn, uploadArtifactsFn, challengeOutcomeFn, getLastUrl, closeSessionFn }) {
  const runStart = new Date();
  const versionsAtStart = captureVersionsFn ? captureVersionsFn('scripts/_shared/keeper/keeper.mjs') : null;
  const sessionMetaInitial = sessionMeta ?? { provider: 'keeper', proxy_url: proxyUrl ?? null, platform: platform ?? null };
  const diagnosticParams = diagnostic && typeof diagnostic === 'object' && diagnostic.stage
    ? {
      diagnostic_stage: diagnostic.stage,
      diagnostic: {
        ...diagnostic,
        requested_at: diagnostic.requested_at ?? runStart.toISOString(),
        capture_contract: Array.isArray(diagnostic.capture_contract)
          ? diagnostic.capture_contract
          : ['ban_signal', 'session_fingerprint', 'network_artifact', 'video_artifact'],
      },
    }
    : {};
  const flowRowId = process.env.ACTION_LOG_ID || process.env.WC_JOB_ID || randomUUID();
  const flowRecord = {
    account_id: accountId ?? null, action, platform: platform ?? null,
    status: 'running', started_at: runStart.toISOString(),
    params: { keeper: true, keeper_session: session, proxy_url_override: proxyUrl ?? null, keeper_started_versions: versionsAtStart, ...diagnosticParams },
    result: { session: sessionMetaInitial, ban_signal: { healthy: null, signal: 'keeper_running' } },
  };
  writeRunRecord(flowRowId, flowRecord);
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
    if (!uploadArtifactsFn) throw new Error('private Stado artifact uploader is required');
    const artifacts = await uploadArtifactsFn(flowRowId);
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
    // proxy_preflight: full provider/sticky selection history — the worker imports
    // this too; the keeper import landed session_meta + captcha but missed it.
    const pf = await readJsonInRun(flowRowId, 'proxy_preflight.json');
    if (pf && result.session && typeof result.session === 'object') result.session.proxy_preflight = pf;
    // challenge_outcome: decode the reCAPTCHA/checkpoint flow from the HAR into
    // a queryable verdict (challenge type, grid, objects, solve verdicts, whether
    // LinkedIn accepted). Best-effort, never fails the close.
    if (challengeOutcomeFn) {
      try { const co = await challengeOutcomeFn(flowRowId); if (co) result.challenge_outcome = co; }
      catch (e) { console.log(`[keeper-bookkeeping] challenge_outcome threw: ${e?.message?.slice(0, 100) ?? String(e).slice(0, 100)}`); }
    }
    writeRunRecord(flowRowId, { ...flowRecord, status, completed_at: new Date().toISOString(), result });
    console.log(`[keeper-bookkeeping] closed run=${flowRowId.slice(0, 8)} status=${status}`);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      // getLastUrl() reads s.page.url(), which can throw once the context is torn
      // down (WSession's own SIGTERM handler closes it) — guard it AND close() so
      // an abandoned keeper still records its provenance + capture instead of
      // dying before close() runs.
      let last = null;
      try { last = getLastUrl ? getLastUrl() : null; } catch { /* context closing */ }
      try { await close('failed', { healthy: false, signal: 'keeper_abandoned', details: { last_url: last } }, null); }
      catch (e) { console.log(`[keeper-bookkeeping] SIGTERM close threw: ${e?.message?.slice(0, 100) ?? String(e).slice(0, 100)}`); }
      process.exit(0);
    });
  }
  return { rowId: flowRowId, close };
}
