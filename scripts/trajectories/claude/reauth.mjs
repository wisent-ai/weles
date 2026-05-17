// Mac-mini claude_code subscription-pool reauth runner.
//
// Replaces the deleted GCP Cloud Run `wisent-claude-reauth` service.
// Runs on the mac mini under a launchd LaunchAgent
// (com.wisent.claude-reauth). Each tick:
//   1. read config from weles supabase service_credentials
//      id='claude-reauth-config' (model-router URL, agent id, HMAC
//      secret, donor user id) — no secrets on disk beyond worker.env's
//      SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY which bootstrap the read.
//   2. HMAC-probe the model-router claude-code-subscription pool.
//   3. if healthy: exit 0.
//   4. if burnt: pick the LRU google_sso Claude credential row, run
//      login.mjs LOCALLY (real Chromium, mac-mini's trusted residential
//      IP — Google does NOT bot-block it, so no proxy/VM/xvfb), capture
//      the {"claudeAiOauth":...} blob, donate it to model-router, mark
//      the row used, and revoke every previously-active row.
//
// No GCE VM, no GCS, no proxy, no Resend, no email-code path.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGIN_MJS = join(HERE, 'login.mjs');

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in env (source worker.env)');
  process.exit(1);
}
const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

const BURNOUT_SUBSTR = [
  'hit your limit', 'authentication_error', 'invalid authentication',
  'rate_limit', 'no active',
];

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`supabase GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function loadConfig() {
  const rows = await sbGet(
    'service_credentials?id=eq.claude-reauth-config&select=metadata');
  if (!rows.length || !rows[0].metadata) {
    throw new Error("no service_credentials row id='claude-reauth-config'");
  }
  const m = rows[0].metadata;
  for (const k of ['MODEL_ROUTER_URL', 'WISENT_APP_AGENT_ID',
    'WISENT_APP_AGENT_AUTH_SECRET', 'WISENT_DONOR_USER_ID']) {
    if (!m[k]) throw new Error(`claude-reauth-config.metadata missing ${k}`);
  }
  return {
    routerUrl: m.MODEL_ROUTER_URL.replace(/\/+$/, ''),
    agentId: m.WISENT_APP_AGENT_ID,
    hmacSecret: m.WISENT_APP_AGENT_AUTH_SECRET,
    donorUserId: m.WISENT_DONOR_USER_ID,
  };
}

function sign(cfg, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const msg = `${cfg.agentId}:${ts}:${bodyHash}`;
  const sig = crypto.createHmac('sha256', cfg.hmacSecret).update(msg).digest('hex');
  return {
    'x-agent-id': cfg.agentId,
    'x-agent-timestamp': ts,
    'x-agent-signature': sig,
    'content-type': 'application/json',
  };
}

async function listSubscriptions(cfg) {
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`);
  if (!r.ok) throw new Error(`list subscriptions -> ${r.status}`);
  return (await r.json()).subscriptions ?? [];
}

async function probePool(cfg) {
  const body = JSON.stringify({
    model: 'claude-code-subscription',
    messages: [{ role: 'user', content: 'Reply with the single word PROBE.' }],
    max_tokens: 10,
  });
  const r = await fetch(`${cfg.routerUrl}/v1/chat/completions`,
    { method: 'POST', headers: sign(cfg, body), body });
  let data;
  try { data = await r.json(); } catch { data = { raw: await r.text() }; }
  return { status: r.status, body: data };
}

function isBurnout(probe) {
  if (probe.status !== 200) return true;
  const s = JSON.stringify(probe.body ?? {}).toLowerCase();
  return BURNOUT_SUBSTR.some((sub) => s.includes(sub));
}

async function pickLruRow() {
  // The 3 Max rows are display_name ILIKE 'Claude%' AND
  // login_method=google_sso. The display_name filter is essential:
  // other rows (e.g. 'Oxylabs Residential') also carry
  // login_method=google_sso, and the api_key_only config row
  // 'claude-reauth-config' would match display_name ILIKE 'Claude%'
  // — the two filters together select exactly the 3 accounts.
  const rows = await sbGet(
    'service_credentials?display_name=ilike.Claude%25'
    + '&login_method=eq.google_sso'
    + '&select=id,display_name,updated_at&order=updated_at.asc&limit=1');
  if (!rows.length) throw new Error('no Claude google_sso credential row');
  return rows[0];
}

async function markRowUsed(rowId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/service_credentials?id=eq.${encodeURIComponent(rowId)}`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ updated_at: new Date().toISOString() }),
    });
  if (r.status >= 400) console.error(`mark_row_used PATCH ${r.status}: ${await r.text()}`);
}

async function donate(cfg, blobJson) {
  const body = {
    user_id: cfg.donorUserId,
    provider: 'claude_code',
    key_label: `reauth-macmini ${new Date().toISOString()}`,
    api_key: blobJson,
  };
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`donate -> ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.subscription ?? j;
}

async function deleteSubscription(cfg, subId) {
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: cfg.donorUserId, subscription_id: subId }),
  });
  return r.status < 400;
}

// Run login.mjs locally. Inherits env (SUPABASE_*, CHROMIUM_PATH from
// worker.env) and pins CLAUDE_LOGIN_PROXY=none — the mac mini's own
// residential IP is trusted by Google, the entire reason this moved off
// GCE. login.mjs writes the {"claudeAiOauth":...} blob to stdout.
function runLogin(displayName) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [LOGIN_MJS], {
      env: {
        ...process.env,
        CLAUDE_DISPLAY_NAME: displayName,
        CLAUDE_LOGIN_PROXY: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('login.mjs exceeded 720s hard cap'));
    }, 720_000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {}); // text logs are the phrase only
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(killer);
      for (const line of out.split('\n').reverse()) {
        const t = line.trim();
        if (t.startsWith('{"claudeAiOauth"')) { resolve(t); return; }
      }
      reject(new Error(`login.mjs exit ${code}, no claudeAiOauth blob in stdout`));
    });
  });
}

async function main() {
  const cfg = await loadConfig();
  const poolBefore = await listSubscriptions(cfg);
  const probe = await probePool(cfg);
  const burnt = isBurnout(probe);
  console.log(`[reauth] pool=${poolBefore.length} probe_status=${probe.status} burnt=${burnt}`);
  if (!burnt) { console.log('[reauth] healthy — nothing to do'); return; }

  const row = await pickLruRow();
  console.log(`[reauth] burnt — reauthing LRU row ${row.display_name} (updated ${row.updated_at})`);
  const blob = await runLogin(row.display_name);
  console.log(`[reauth] got OAuth blob len=${blob.length} for ${row.display_name}`);

  const newSub = await donate(cfg, blob);
  console.log(`[reauth] donated new sub id=${newSub.id ?? '?'}`);
  await markRowUsed(row.id);

  let deleted = 0;
  for (const old of poolBefore) {
    if (await deleteSubscription(cfg, old.id)) deleted += 1;
  }
  console.log(`[reauth] revoked ${deleted}/${poolBefore.length} stale rows — rotation complete`);
}

main().catch((e) => {
  console.error(`[reauth] FAILED: ${e.message}`);
  process.exit(1);
});
