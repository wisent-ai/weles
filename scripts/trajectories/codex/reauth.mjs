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
import {
  loadFromSkarbiec,
  persistToSkarbiec,
  resolveBearer,
  supabaseConfigured,
} from '../_shared/reauth_config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGIN_MJS = join(HERE, 'login.mjs');
const CODEX_AUTH_PATH = process.env.CODEX_AUTH_PATH || join(homedir(), '.codex', 'auth.json');

// The Supabase project this was written against is gone, and exiting on its
// absence meant an expired subscription was never refreshed -- the accounts are
// alive, only the token is not. Skarbiec holds the same configuration row, so
// the runner reads whichever store this host actually has.
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
const CONFIG_ITEM = 'codex-reauth-config';

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
  if (!supabaseConfigured()) {
    const cfg = loadFromSkarbiec(CONFIG_ITEM);
    cfg.bearer = resolveBearer(cfg.agentId);
    console.error(
      `config from skarbiec ${CONFIG_ITEM}; router ${cfg.routerUrl}; `
      + `bearer ${cfg.bearer ? 'present' : 'absent'}`,
    );
    return cfg;
  }
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
    store: 'supabase',
    item: CONFIG_ITEM,
    routerUrl: m.MODEL_ROUTER_URL.replace(/\/+$/, ''),
    agentId: m.WISENT_APP_AGENT_ID,
    // The gateway refuses a signed trio with a bare 401 when no bearer carries
    // the client identity, as the header builder below says. Only the Skarbiec
    // branch resolved one, so on a host whose database configuration is present
    // -- the branch that is meant to be the normal one -- every run reached the
    // gateway and was refused for a credential nobody had asked for. Claude's
    // trajectory resolves it outside the branches; this one now agrees.
    bearer: resolveBearer(m.WISENT_APP_AGENT_ID),
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

async function persistActiveExpiry(cfg, expiresAtMs) {
  // Recording the new expiry is what makes the NEXT tick refresh before the
  // token dies rather than after, so it follows the store the config came from.
  if (cfg.store === 'skarbiec') {
    try {
      persistToSkarbiec(cfg, { active_token_expires_at: expiresAtMs });
    } catch (error) {
      console.error(`persist expiry to skarbiec failed: ${error.message}`);
    }
    return;
  }
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/service_credentials?id=eq.codex-reauth-config`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: { ...cfg.rawMeta, active_token_expires_at: expiresAtMs } }),
    });
  if (r.status >= 400) console.error(`persist expiry PATCH ${r.status}: ${await r.text()}`);
}

function sign(cfg, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  // The verifier hashes an absent body to the empty string, not to the digest of
  // no bytes, so a GET signed with sha256('') never matches.
  const bodyHash = body ? crypto.createHash('sha256').update(body).digest('hex') : '';
  const msg = `${cfg.agentId}:${ts}:${bodyHash}`;
  const sig = crypto.createHmac('sha256', cfg.hmacSecret).update(msg).digest('hex');
  const headers = {
    'x-agent-id': cfg.agentId,
    'x-agent-timestamp': ts,
    'x-agent-signature': sig,
    'content-type': 'application/json',
  };
  // The gateway reads the client identity from the bearer first and only then
  // checks that this signed agent belongs to it, so the trio alone is refused
  // with a bare 401 that names neither half.
  if (cfg.bearer) headers.authorization = `Bearer ${cfg.bearer}`;
  return headers;
}

async function listSubscriptions(cfg) {
  // Signed and bearing like every other call: an unsigned read was refused
  // before the route was reached, which read as a missing endpoint from here.
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    headers: sign(cfg, ''),
  });
  if (!r.ok) throw new Error(`list subscriptions -> ${r.status}`);
  const subs = (await r.json()).subscriptions ?? [];
  return subs.filter((sub) => sub.provider === 'codex');
}

// Account name embedded in a donation label `codex-reauth <account> <ISO>`
// (ISO has no spaces; account may). Returns null for non-matching labels.
// Matched EXACTLY (not by prefix) so "Codex" never matches "Codex Wisent".
function accountOfLabel(lbl) {
  const m = /^codex-reauth (.+) (\S+)$/.exec(lbl || '');
  return m ? m[1] : null;
}

async function probePool(cfg) {
  // `codex-subscription` was a pool alias on the router that went away. Brama
  // takes a canonical `provider/model` route or one of its selectors, and a
  // canonical codex route is what this probe is actually asking about: an
  // unknown name answered 400 and read as burnout on every tick, so the runner
  // donated a fresh credential each run whether or not anything was wrong.
  const body = JSON.stringify({
    model: process.env.CODEX_PROBE_MODEL || 'codex/gpt-5.5',
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
  // Only a fresh browser login needs a donor row, and the row lives in the
  // store that went away. Say so plainly instead of failing on a fetch to an
  // empty URL: reusing this host's own auth.json needs no donor at all.
  if (!supabaseConfigured()) {
    throw new Error(
      'a fresh login needs a donor credential row, and no credential store is '
      + 'configured on this host; reuse of a local auth.json is the only path left',
    );
  }
  const rows = await sbGet(
    "service_credentials?display_name=ilike.Codex%25"
    + '&or=(login_method.eq.email_password,login_method.eq.google_sso)'
    + '&select=id,display_name,updated_at,login_method&order=updated_at.asc&limit=1');
  if (!rows.length) throw new Error('no Codex email_password/google_sso credential row');
  return rows[0];
}

async function pickNamedRow(displayName) {
  if (!supabaseConfigured()) {
    throw new Error('a named fresh login needs the configured credential store');
  }
  const rows = await sbGet(
    `service_credentials?display_name=eq.${encodeURIComponent(displayName)}`
    + '&or=(login_method.eq.email_password,login_method.eq.google_sso)'
    + '&select=id,display_name,updated_at,login_method&limit=1');
  if (!rows.length) {
    throw new Error(`no Codex credential row named ${displayName}`);
  }
  return rows[0];
}

async function markRowAttempted(rowId, errMsg) {
  if (!supabaseConfigured()) {
    console.error('mark_row_attempted: no credential store configured; not recorded');
    return;
  }
  const patch = { updated_at: new Date().toISOString() };
  if (errMsg) {
    // MERGE existing metadata first — a bare {metadata} PATCH clobbers
    // google_totp_secret and every other key (real data-loss bug). If the
    // read fails, skip the metadata write entirely (fail closed) rather than
    // risk clobbering with an empty base — only updated_at is touched then.
    try {
      const cur = await sbGet(`service_credentials?id=eq.${encodeURIComponent(rowId)}&select=metadata`);
      const existingMeta = (cur[0] && cur[0].metadata) || {};
      patch.metadata = { ...existingMeta, last_login_error: String(errMsg).slice(0, 500), last_login_error_at: patch.updated_at };
    } catch (e) {
      console.error(`mark_row_attempted: metadata read failed, skipping metadata write to avoid clobber: ${e.message}`);
    }
  }
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
  // Brama's donate contract is `{provider, label, api_key}` and rejects
  // anything else outright. `user_id` belonged to the Cloud Run router that
  // went away: the donor is now the authenticated caller, not a field.
  const body = {
    provider: 'codex',
    label: label || `reauth-macmini ${new Date().toISOString()}`,
    api_key: authJson,
  };
  // Signed and bearing, like the read: an unsigned POST is refused as
  // `unauthenticated` before the donation is looked at, which reads as a
  // rejected credential rather than a rejected caller.
  const payload = JSON.stringify(body);
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'POST',
    headers: sign(cfg, payload),
    body: payload,
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

async function runLoginWithRetries(row) {
  const maxTries = Number(process.env.CODEX_REAUTH_LOGIN_TRIES || 3);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const authJson = await runLogin(row.display_name);
      await markRowAttempted(row.id);
      return authJson;
    } catch (e) {
      console.log(`[codex reauth] login attempt ${attempt}/${maxTries} failed: ${e.message?.slice(0, 100)}`);
      if (attempt < maxTries) continue;
      await markRowAttempted(row.id, e.message);
      throw e;
    }
  }
}

async function main() {
  const cfg = await loadConfig();
  const requestedDisplayName = process.env.CODEX_DISPLAY_NAME?.trim();
  if (requestedDisplayName) {
    const row = await pickNamedRow(requestedDisplayName);
    console.log(`[codex reauth] requested fresh login for ${row.display_name}`);
    const authJson = await runLoginWithRetries(row);
    console.log(`[codex reauth] got requested auth.json len=${authJson.length}`);
    const newSub = await donate(
      cfg,
      authJson,
      `codex-reauth ${row.display_name} ${new Date().toISOString()}`,
    );
    console.log(`[codex reauth] donated requested sub id=${newSub.id ?? '?'}`);
    const newExp = authExpiresAt(authJson);
    if (newExp > 0) await persistActiveExpiry(cfg, newExp);
    return;
  }
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
  const quotaBurnt = probe.status !== 200 && (probeStr.includes('usage limit') || probeStr.includes('weekly limit'));
  if (quotaBurnt) {
    // Quota is spent on the pool's current account. Re-logging THAT account
    // cannot restore it. But if a fresh auth.json is already on disk (a
    // different account was just logged in), donate it to onboard that account
    // into the pool so the router can rotate onto its quota. Crucially we only
    // proceed when auth.json already exists — we NEVER trigger a login on a
    // burnt tick, so this cannot re-spam the 2FA prompt.
    const fresh = readExistingAuthJson();
    if (!fresh) {
      console.log('[codex reauth] quota exhausted and no fresh auth.json on disk — skipping (no login, no 2FA push)');
      return;
    }
    console.log('[codex reauth] quota exhausted but fresh auth.json present — onboarding it to the pool (no login)');
    // fall through: the existingAuth branch below donates it without a login.
  }
  if (!reason) { console.log('[codex reauth] healthy & not near expiry — nothing to do'); return; }

  let authJson;
  let account = 'Codex';
  const existingAuth = readExistingAuthJson();
  if (existingAuth) {
    authJson = existingAuth;
    // Prefer the sidecar account written by login.mjs so an onboarded on-disk
    // token is labeled by its TRUE account, not the env default. Without this a
    // second account's reauth would collide on the shared "codex-reauth Codex "
    // label prefix during scoped-revoke and delete the wrong account's rows.
    try {
      const sidecar = readFileSync(`${CODEX_AUTH_PATH}.account`, 'utf8').trim();
      if (sidecar) account = sidecar;
    } catch { /* no sidecar — keep env default */ }
    console.log(`[codex reauth] ${reason} — using existing ${CODEX_AUTH_PATH} (account=${account})`);
    // A refresh-capable token already live in the pool needs no re-mint: the
    // router refreshes it via refresh_token, so exp_ms (access-token expiry)
    // near/past does NOT mean the pool is degraded. Skip re-donation when the
    // pool is healthy AND this account already has an active sub — stops the
    // per-tick donate/revoke churn and duplicate accumulation.
    if (!burnt && probe.status === 200) {
      const alreadyActive = poolBefore.some((s) => accountOfLabel(s.key_label) === account && (s.status ?? 'active') === 'active');
      if (alreadyActive) {
        console.log(`[codex reauth] pool healthy and ${account} already active — no re-mint needed`);
        return;
      }
    }
  } else {
    const row = await pickLruRow();
    account = row.display_name || account;
    console.log(`[codex reauth] ${reason} — reauthing LRU row ${row.display_name}`);
    authJson = await runLoginWithRetries(row);
  }
  console.log(`[codex reauth] got auth.json len=${authJson.length}`);

  const donateLabel = `codex-reauth ${account} ${new Date().toISOString()}`;
  const newSub = await donate(cfg, authJson, donateLabel);
  console.log(`[codex reauth] donated new sub id=${newSub.id ?? '?'}`);
  const newExp = authExpiresAt(authJson);
  if (newExp > 0) await persistActiveExpiry(cfg, newExp);

  // Revoke only THIS account's prior rows (+ legacy unlabeled reauth rows),
  // never another account's active subscription. This is what lets a
  // multi-account pool survive so the router can rotate across accounts;
  // with a single account it collapses to the same net-one-active as before.
  //
  let deleted = 0;
  let kept = 0;
  for (const old of poolBefore) {
    const lbl = old.key_label || '';
    if (accountOfLabel(lbl) === account || lbl.startsWith('reauth-macmini ')) {
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
