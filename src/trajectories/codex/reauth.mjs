// Mac-mini Codex subscription-pool reauth runner.
//
// Mirrors src/trajectories/claude/reauth.mjs:
//   1. Load config from the Skarbiec item 'codex-reauth-config'.
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
  reachableRouterUrl,
  resolveBearer,
  stadoRouterUrl,
} from '../_shared/reauth_config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGIN_MJS = join(HERE, 'login.mjs');
const CODEX_AUTH_PATH = process.env.CODEX_AUTH_PATH || join(homedir(), '.codex', 'auth.json');

// An expired subscription must still be refreshed -- the accounts are alive,
// only the token is not. Skarbiec holds the configuration row this runner reads.
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

async function loadConfig() {
  const cfg = loadFromSkarbiec(CONFIG_ITEM);
  cfg.bearer = resolveBearer(cfg.agentId);
  console.error(
    `config from skarbiec ${CONFIG_ITEM}; `
    + `bearer ${cfg.bearer ? 'present' : 'absent'}`,
  );
  return cfg;
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

function isFreshCodexAuth(authJson) {
  try {
    const document = JSON.parse(authJson);
    const tokens = document?.tokens;
    return typeof tokens?.access_token === 'string' && tokens.access_token.length > 0
      && typeof tokens?.id_token === 'string' && tokens.id_token.length > 0
      && typeof tokens?.account_id === 'string' && tokens.account_id.length > 0;
  } catch {
    return false;
  }
}

async function persistActiveExpiry(cfg, expiresAtMs) {
  // Recording the new expiry is what makes the NEXT tick refresh before the
  // token dies rather than after.
  try {
    persistToSkarbiec(cfg, { active_token_expires_at: expiresAtMs });
  } catch (error) {
    console.error(`persist expiry to skarbiec failed: ${error.message}`);
  }
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
  // Only a fresh browser login needs a donor row. Automatic Brama renewal
  // always names one account; a standalone untargeted run must not guess.
  throw new Error(
    'a fresh login must name a Codex account through WELES_LOGIN_ITEM or CODEX_DISPLAY_NAME',
  );
}

async function pickNamedRow(displayName) {
  const named = displayName?.trim();
  if (!named) throw new Error('a named Codex login needs a display name');
  // login.mjs resolves this name through Weles's canonical service-login
  // contracts and refuses if the vault does not hold it. Duplicating those
  // credentials or their row registry here was the bug.
  return { display_name: named };
}

async function markRowAttempted() {
  // Skarbiec keeps no per-row attempt bookkeeping; the rotation timestamps and
  // last_login_error notes lived on the credential rows that went away.
  console.error('mark_row_attempted: no credential store configured; not recorded');
}

async function donate(cfg, authJson, label, loginItem) {
  const body = {
    provider: 'codex',
    label: label || `reauth-macmini ${new Date().toISOString()}`,
    api_key: authJson,
    ...(loginItem ? { login_item: loginItem } : {}),
    ...(process.env.BRAMA_SUBSCRIPTION_ID ? { subscription_id: process.env.BRAMA_SUBSCRIPTION_ID } : {}),
  };
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
  const payload = JSON.stringify({ subscription_id: sub.id });
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'DELETE',
    headers: sign(cfg, payload),
    body: payload,
  });
  return r.status < 400;
}

function runLogin(displayName) {
  return new Promise((resolve, reject) => {
    // `process.execPath`, not `'node'`: this runs as a child of the launchd
    // worker, whose unit carries no PATH, so a bare `node` is ENOENT and the
    // whole reauthorization dies before the browser opens. On 2026-09-03 that
    // held every codex and kimi subscription in `awaiting_signin` while Brama
    // recorded "a browser sign-in has already been driven against this exact
    // stored credential" and left them to an operator -- the drive had run and
    // crashed on spawn. `src/secrets/scoped-service.ts` already spawns this
    // way; the node running this file is by definition the node that can run
    // the next one.
    const child = spawn(process.execPath, [LOGIN_MJS], {
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
      if (code === 0) {
        try {
          const authJson = readFileSync(CODEX_AUTH_PATH, 'utf8');
          if (isFreshCodexAuth(authJson)) {
            resolve(authJson);
            return;
          }
        } catch { /* the failure below names the missing fresh auth contract */ }
      }
      // The message is on the FIRST lines of a Node failure and the stack on the
      // last, so keeping only the last five kept the least useful half and hid
      // every real cause behind identical loader frames.
      const said = (out + '\n' + err)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^at\s/.test(line));
      const tail = [...said.slice(0, 4), ...said.slice(-2)].join(' | ').slice(0, 600);
      reject(new Error(`login.mjs exit ${code}, no valid auth.json; tail=${tail}`));
    });
  });
}

async function runLoginWithRetries(row, attempts) {
  const maxTries = attempts ?? Number(process.env.CODEX_REAUTH_LOGIN_TRIES || 3);
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
  // Stado says where Brama is; the listener check keeps the answer honest.
  cfg.routerUrl = await reachableRouterUrl(stadoRouterUrl());
  const requestedDisplayName = process.env.CODEX_DISPLAY_NAME?.trim();
  if (requestedDisplayName) {
    const row = await pickNamedRow(requestedDisplayName);
    console.log(`[codex reauth] requested fresh login for ${row.display_name}`);
    const authJson = await runLoginWithRetries(row, 1);
    console.log(`[codex reauth] got requested auth.json len=${authJson.length}`);
    const loginItem = process.env.WELES_LOGIN_ITEM?.trim() || '';
    const newSub = await donate(
      cfg,
      authJson,
      `codex-reauth ${row.display_name} ${new Date().toISOString()}`,
      loginItem,
    );
    console.log(`[codex reauth] donated requested credential as ${newSub.id ?? '?'}`);
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
  const newSub = await donate(cfg, authJson, donateLabel, '');
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
    if (old.id === newSub.id) {
      kept += 1;
    } else if (accountOfLabel(lbl) === account || lbl.startsWith('reauth-macmini ')) {
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
