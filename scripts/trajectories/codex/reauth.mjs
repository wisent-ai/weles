// Mac-mini Codex subscription-pool reauth runner.
//
// Mirrors scripts/trajectories/claude/reauth.mjs:
//   1. Load config from service_credentials id='codex-reauth-config'.
//   2. HMAC-probe the model-router codex-subscription pool.
//   3. If healthy: exit 0.
//   4. If burnt: donate the existing ~/.codex/auth.json when available.
//      Only run login.mjs when no local auth.json can be reused.
//   5. Revoke stale rows after the replacement token is accepted.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGIN_MJS = join(HERE, 'login.mjs');
const CODEX_AUTH_PATH = process.env.CODEX_AUTH_PATH || join(homedir(), '.codex', 'auth.json');

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in env');
  process.exit(1);
}
const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

const BURNOUT_SUBSTR = [
  'refresh token was revoked',
  'access token could not be refreshed',
  'invalid_grant',
  'authentication_error',
  'invalid authentication',
  '401',
  'no active',
  'rate_limit',
];

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`supabase GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function loadConfig() {
  const rows = await sbGet(
    "service_credentials?id=eq.codex-reauth-config&select=metadata");
  if (!rows.length || !rows[0].metadata) {
    throw new Error("no service_credentials row id='codex-reauth-config'");
  }
  const m = rows[0].metadata;
  for (const k of ['MODEL_ROUTER_URL', 'WISENT_APP_AGENT_ID',
    'WISENT_APP_AGENT_AUTH_SECRET', 'WISENT_DONOR_USER_ID']) {
    if (!m[k]) throw new Error(`codex-reauth-config.metadata missing ${k}`);
  }
  return {
    routerUrl: m.MODEL_ROUTER_URL.replace(/\/+$/, ''),
    agentId: m.WISENT_APP_AGENT_ID,
    hmacSecret: m.WISENT_APP_AGENT_AUTH_SECRET,
    donorUserId: m.WISENT_DONOR_USER_ID,
    rawMeta: m,
    activeTokenExpiresAt: Number(m.active_token_expires_at) || 0,
  };
}

function authExpiresAt(authJson) {
  try {
    const d = JSON.parse(authJson);
    // id_token JWT exp claim is the authoritative session expiry.
    const idToken = d?.tokens?.id_token;
    if (idToken) {
      const payload = idToken.split('.')[1];
      const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
      const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      return (claims.exp || 0) * 1000;
    }
    return 0;
  } catch { return 0; }
}

function readExistingAuthJson() {
  if (!existsSync(CODEX_AUTH_PATH)) return null;
  try {
    const raw = readFileSync(CODEX_AUTH_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.tokens?.refresh_token || parsed?.tokens?.id_token || parsed?.auth_mode === 'chatgpt') {
      return raw;
    }
  } catch {}
  return null;
}

async function persistActiveExpiry(rawMeta, expiresAtMs) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/service_credentials?id=eq.codex-reauth-config`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: { ...rawMeta, active_token_expires_at: expiresAtMs } }),
    });
  if (r.status >= 400) console.error(`persist expiry PATCH ${r.status}: ${await r.text()}`);
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
  const subs = (await r.json()).subscriptions ?? [];
  return subs.filter((sub) => sub.provider === 'codex');
}

async function probePool(cfg) {
  const body = JSON.stringify({
    model: 'codex-subscription',
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
  const rows = await sbGet(
    "service_credentials?display_name=ilike.Codex%25"
    + '&or=(login_method.eq.email_password,login_method.eq.google_sso)'
    + '&select=id,display_name,updated_at,login_method&order=updated_at.asc&limit=1');
  if (!rows.length) throw new Error('no Codex email_password/google_sso credential row');
  return rows[0];
}

async function markRowAttempted(rowId, errMsg) {
  const patch = { updated_at: new Date().toISOString() };
  if (errMsg) patch.metadata = { last_login_error: String(errMsg).slice(0, 500), last_login_error_at: patch.updated_at };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/service_credentials?id=eq.${encodeURIComponent(rowId)}`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  if (r.status >= 400) console.error(`mark_row_attempted PATCH ${r.status}: ${await r.text()}`);
}

async function donate(cfg, authJson, label) {
  const body = {
    user_id: cfg.donorUserId,
    provider: 'codex',
    label: label || `reauth-macmini ${new Date().toISOString()}`,
    api_key: authJson,
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

async function deleteSubscription(cfg, sub) {
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: sub.donor_id || cfg.donorUserId, subscription_id: sub.id }),
  });
  return r.status < 400;
}

function runLogin(displayName) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [LOGIN_MJS], {
      env: {
        ...process.env,
        CODEX_DISPLAY_NAME: displayName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('login.mjs exceeded 600s hard cap'));
    }, 600_000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(killer);
      console.log(`[codex reauth] login.mjs closed code=${code} out_len=${out.length} err_len=${err.length}`);
      try {
        // login.mjs emits the raw auth.json on stdout, but WSession internals
        // can also write to stdout afterwards. Find the first '{' and walk
        // backwards from the last '}' until JSON.parse succeeds.
        const first = out.indexOf('{');
        if (first !== -1) {
          let last = out.length;
          while ((last = out.lastIndexOf('}', last - 1)) > first) {
            const candidate = out.slice(first, last + 1);
            try {
              JSON.parse(candidate); // validate
              resolve(candidate);
              return;
            } catch {}
          }
        }
      } catch {}
      const tail = (out + '\n' + err).split('\n').slice(-5).join(' | ').slice(0, 400);
      reject(new Error(`login.mjs exit ${code}, no valid auth.json; tail=${tail}`));
    });
  });
}

async function main() {
  const cfg = await loadConfig();
  const poolBefore = await listSubscriptions(cfg);
  const probe = await probePool(cfg);
  const burnt = isBurnout(probe);
  const marginMs = Number(process.env.CODEX_REAUTH_REFRESH_MARGIN_SEC || 10800) * 1000;
  const expMs = cfg.activeTokenExpiresAt;
  const reason = burnt ? 'burnt'
    : (expMs > 0 && Date.now() >= expMs - marginMs ? 'expiring-soon' : null);
  console.log(`[codex reauth] pool=${poolBefore.length} probe=${probe.status} burnt=${burnt} exp_ms=${expMs} reason=${reason ?? 'none'}`);
  if (probe.status !== 200) console.error(`[codex reauth] probe_body ${JSON.stringify(probe.body).slice(0, 1500)}`);
  const probeStr = JSON.stringify(probe.body ?? {}).toLowerCase();
  if (probe.status !== 200 && (probeStr.includes('usage limit') || probeStr.includes('weekly limit'))) {
    console.log('[codex reauth] account quota exhausted — auth is valid, only quota is spent; re-login cannot restore it, skipping');
    return;
  }
  if (!reason) { console.log('[codex reauth] healthy & not near expiry — nothing to do'); return; }

  let authJson;
  let account = process.env.CODEX_DISPLAY_NAME || 'Codex';
  const existingAuth = readExistingAuthJson();
  if (existingAuth) {
    authJson = existingAuth;
    console.log(`[codex reauth] ${reason} — using existing ${CODEX_AUTH_PATH}`);
  } else {
    const row = await pickLruRow();
    account = row.display_name || account;
    console.log(`[codex reauth] ${reason} — reauthing LRU row ${row.display_name}`);
    const maxTries = Number(process.env.CODEX_REAUTH_LOGIN_TRIES || 3);
    for (let attempt = 1; ; attempt += 1) {
      try {
        authJson = await runLogin(row.display_name);
        break;
      } catch (e) {
        console.log(`[codex reauth] login attempt ${attempt}/${maxTries} failed: ${e.message?.slice(0, 100)}`);
        if (attempt < maxTries) continue;
        await markRowAttempted(row.id, e.message);
        throw e;
      }
    }
    await markRowAttempted(row.id);
  }
  console.log(`[codex reauth] got auth.json len=${authJson.length}`);

  const donateLabel = `codex-reauth ${account} ${new Date().toISOString()}`;
  const newSub = await donate(cfg, authJson, donateLabel);
  console.log(`[codex reauth] donated new sub id=${newSub.id ?? '?'}`);
  const newExp = authExpiresAt(authJson);
  if (newExp > 0) await persistActiveExpiry(cfg.rawMeta, newExp);

  // Revoke only THIS account's prior rows (+ legacy unlabeled reauth rows),
  // never another account's active subscription. This is what lets a
  // multi-account pool survive so the router can rotate across accounts;
  // with a single account it collapses to the same net-one-active as before.
  const accountPrefix = `codex-reauth ${account} `;
  let deleted = 0;
  let kept = 0;
  for (const old of poolBefore) {
    const lbl = old.key_label || '';
    if (lbl.startsWith(accountPrefix) || lbl.startsWith('reauth-macmini ')) {
      if (await deleteSubscription(cfg, old)) deleted += 1;
    } else {
      kept += 1;
    }
  }
  console.log(`[codex reauth] revoked ${deleted}/${poolBefore.length} stale rows; kept ${kept} other-account active`);
}

main().catch((e) => {
  console.error(`[codex reauth] FAILED: ${e.message}`);
  process.exit(1);
});
