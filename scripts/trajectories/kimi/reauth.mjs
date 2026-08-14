// Kimi Code subscription-pool reauth runner.
//
// Mirrors Claude/Codex reauth:
//   1. Load model-router config from Weles service_credentials metadata.
//   2. HMAC-probe kimi-subscription.
//   3. If healthy: exit.
//   4. If auth is missing/burnt: run login.mjs in an isolated HOME, verify
//      `kimi -p`, donate the fresh credentials JSON, and revoke stale rows.
//   5. If the provider reports quota/usage limit, do not re-login: credentials
//      are not the issue.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const VAR = join(REPO, 'var');
const LOGIN_MJS = join(HERE, 'login.mjs');
import {
  loadFromSkarbiec,
  persistToSkarbiec,
  reachableRouterUrl,
  resolveBearer,
  supabaseConfigured,
} from '../_shared/reauth_config.mjs';

// The Supabase project this was written against is not configured on this host,
// and exiting on its absence meant the job never looked at the subscription.
// Skarbiec holds the same configuration row.
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
const CONFIG_ITEM = 'kimi-reauth-config';

const AUTH_BURNOUT_SUBSTR = [
  'no active',
  'auth.login_required',
  'login_required',
  'oauth provider',
  'requires login',
  'invalid_grant',
  'refresh token',
  'empty oauth',
  'credentials',
];

const QUOTA_SUBSTR = [
  'usage limit',
  'quota',
  'billing cycle',
  'rate_limit',
];

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`supabase GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

function configFromSkarbiec(reason) {
  // The identity keys belong to the wisent-app agent, not to one provider, so a
  // row that lacks them borrows from the sibling row rather than keeping a
  // second copy of the same secret. Brama answers the broker and the router
  // surface at one address.
  const cfg = loadFromSkarbiec(CONFIG_ITEM, 'codex-reauth-config');
  cfg.configId = CONFIG_ITEM;
  cfg.brokerUrl = cfg.routerUrl;
  cfg.bearer = resolveBearer(cfg.agentId);
  console.error(
    `config from skarbiec ${CONFIG_ITEM} (${reason}); router ${cfg.routerUrl}; `
    + `bearer ${cfg.bearer ? 'present' : 'absent'}`,
  );
  return cfg;
}

async function loadConfig() {
  if (!supabaseConfigured()) return configFromSkarbiec('no supabase in env');
  const rows = await sbGet(
    "service_credentials?id=in.(kimi-reauth-config,codex-reauth-config,claude-reauth-config)&select=id,metadata",
  );
  const byId = new Map(rows.map((row) => [row.id, row.metadata || {}]));
  const m = byId.get('kimi-reauth-config') || byId.get('codex-reauth-config') || byId.get('claude-reauth-config');
  if (!m) throw new Error('missing kimi/codex/claude reauth config metadata');
  // The broker address is no longer a separate deployment: Brama answers the
  // subscription surface and the chat surface at one place, and a row that
  // still carries the split address points at a host that answers 404 to the
  // subscriptions route. Requiring the key refused to run at all.
  // Identity belongs to the agent, not to a provider row, and this row carries
  // none of it. Rather than fail, take the configuration Skarbiec holds: it has
  // the agent id, the router Brama answers on, and a secret that is current.
  const missing = ['MODEL_ROUTER_URL', 'WISENT_APP_AGENT_ID', 'WISENT_APP_AGENT_AUTH_SECRET', 'WISENT_DONOR_USER_ID']
    .filter((key) => !m[key]);
  if (missing.length) {
    return configFromSkarbiec(`supabase row lacks ${missing.join(', ')}`);
  }
  const routerUrl = String(m.MODEL_ROUTER_URL).replace(/\/+$/, '');
  console.error(`config from supabase; router ${routerUrl}`);
  return {
    store: 'supabase',
    configId: byId.has('kimi-reauth-config') ? 'kimi-reauth-config' : (byId.has('codex-reauth-config') ? 'codex-reauth-config' : 'claude-reauth-config'),
    routerUrl,
    brokerUrl: routerUrl,
    agentId: String(m.WISENT_APP_AGENT_ID),
    hmacSecret: String(m.WISENT_APP_AGENT_AUTH_SECRET),
    donorUserId: String(m.WISENT_DONOR_USER_ID),
    rawMeta: m,
    activeTokenExpiresAt: Number(m.kimi_active_token_expires_at || m.active_kimi_token_expires_at || 0) || 0,
  };
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
  // Without the bearer the gateway refuses before the signature is looked at.
  if (cfg.bearer) headers.authorization = `Bearer ${cfg.bearer}`;
  return headers;
}

async function listSubscriptions(cfg) {
  // Signed and bearing like every other call: an unsigned read is refused
  // before the route is reached, which reads as a missing endpoint from here.
  const r = await fetch(`${cfg.brokerUrl}/v1/subscriptions/${cfg.agentId}`, {
    headers: sign(cfg, ''),
  });
  if (!r.ok) throw new Error(`list subscriptions -> ${r.status} ${await r.text()}`);
  const subs = (await r.json()).subscriptions ?? [];
  return subs.filter((sub) => sub.provider === 'kimi');
}

async function probePool(cfg) {
  const body = JSON.stringify({
    // `kimi-subscription` was a pool alias on the router that went away; Brama
    // takes a canonical `provider/model` route or one of its selectors.
    model: process.env.KIMI_PROBE_MODEL || 'kimi/kimi-for-coding',
    messages: [{ role: 'user', content: 'Reply with exactly PROBE.' }],
    max_tokens: 10,
    temperature: 0,
  });
  const r = await fetch(`${cfg.routerUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: sign(cfg, body),
    body,
  });
  let data;
  try { data = await r.json(); } catch { data = { raw: await r.text() }; }
  return { status: r.status, body: data };
}

function probeText(probe) {
  return JSON.stringify(probe.body ?? {}).toLowerCase();
}

function isAuthBurnout(probe) {
  if (probe.status === 200) return false;
  const s = probeText(probe);
  return AUTH_BURNOUT_SUBSTR.some((sub) => s.includes(sub));
}

function isQuotaLimited(probe) {
  const s = probeText(probe);
  return QUOTA_SUBSTR.some((sub) => s.includes(sub));
}

function credentialExpiresAt(raw) {
  try {
    const parsed = JSON.parse(raw);
    const exp = Number(parsed.expires_at || 0);
    if (!exp) return 0;
    return exp < 1_000_000_000_000 ? exp * 1000 : exp;
  } catch {
    return 0;
  }
}

function credentialHasTokens(raw) {
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.access_token || '').length > 32 && String(parsed.refresh_token || '').length > 32;
  } catch {
    return false;
  }
}

async function persistActiveExpiry(cfg, expiresAtMs) {
  if (!expiresAtMs) return;
  if (cfg.store === 'skarbiec') {
    try {
      persistToSkarbiec(cfg, {
        kimi_active_token_expires_at: expiresAtMs,
        kimi_active_token_expires_at_iso: new Date(expiresAtMs).toISOString(),
      });
    } catch (error) {
      console.error(`persist expiry to skarbiec failed: ${error.message}`);
    }
    return;
  }
  const patch = {
    metadata: {
      ...cfg.rawMeta,
      kimi_active_token_expires_at: expiresAtMs,
      kimi_active_token_expires_at_iso: new Date(expiresAtMs).toISOString(),
    },
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?id=eq.${encodeURIComponent(cfg.configId)}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (r.status >= 400) console.error(`persist expiry PATCH ${r.status}: ${await r.text()}`);
}

async function donate(cfg, credentialsJson) {
  // Brama's donate contract is `{provider, label, api_key}` and rejects unknown
  // fields; `user_id` belonged to the router that went away, and the donation
  // must be signed or it is refused before the credential is looked at.
  const body = {
    provider: 'kimi',
    label: `reauth-macmini kimi credentials-json ${new Date().toISOString()}`,
    api_key: credentialsJson,
  };
  const payload = JSON.stringify(body);
  const r = await fetch(`${cfg.brokerUrl}/v1/subscriptions/${cfg.agentId}`, {
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
  const r = await fetch(`${cfg.brokerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'DELETE',
    headers: sign(cfg, payload),
    body: payload,
  });
  return r.status < 400;
}

function runLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [LOGIN_MJS], {
      env: {
        ...process.env,
        KIMI_LOGIN_PROXY: process.env.KIMI_LOGIN_PROXY || 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('kimi login.mjs exceeded 600s hard cap'));
    }, 600_000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const marker = '__KIMI_CREDENTIALS_JSON_B64__';
      const markerAt = out.lastIndexOf(marker);
      if (markerAt >= 0) {
        const b64 = out.slice(markerAt + marker.length).split(/\s+/)[0] || '';
        try {
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          if (credentialHasTokens(decoded)) {
            resolve(decoded);
            return;
          }
        } catch {}
      }

      const first = out.indexOf('{');
      for (let last = out.length; first >= 0 && (last = out.lastIndexOf('}', last - 1)) > first;) {
        const candidate = out.slice(first, last + 1);
        if (!credentialHasTokens(candidate)) continue;
        resolve(candidate);
        return;
      }
      try {
        mkdirSync(VAR, { recursive: true });
        writeFileSync(join(VAR, 'kimi-login-child-last.log'), [
          `code=${code}`,
          `signal=${signal || ''}`,
          '--- stdout ---',
          out,
          '--- stderr ---',
          err,
        ].join('\n'));
      } catch {}
      const tail = `${out}\n${err}`.split('\n').slice(-8).join(' | ').slice(0, 900);
      reject(new Error(`kimi login.mjs exit code=${code} signal=${signal || ''}, no usable credentials JSON; tail=${tail}`));
    });
  });
}

async function main() {
  const cfg = await loadConfig();
  // The row's address is a memory; the listener is the fact.
  cfg.routerUrl = await reachableRouterUrl(cfg.routerUrl);
  cfg.brokerUrl = await reachableRouterUrl(cfg.brokerUrl);
  const poolBefore = await listSubscriptions(cfg);
  const probe = await probePool(cfg);
  const expMs = cfg.activeTokenExpiresAt;
  const marginMs = Number(process.env.KIMI_REAUTH_REFRESH_MARGIN_SEC || 3600) * 1000;
  const expiring = expMs > 0 && Date.now() >= expMs - marginMs;

  console.log(`[kimi reauth] pool=${poolBefore.length} probe=${probe.status} authBurnout=${isAuthBurnout(probe)} quota=${isQuotaLimited(probe)} exp_ms=${expMs}`);

  if (probe.status === 200) {
    // Kimi's OAuth JSON contains a short-lived access_token expiry
    // (observed expires_in=900). The CLI/runtime can refresh through the
    // refresh_token, so a successful signed probe is authoritative. Do not
    // force a browser login just because the access token is inside the
    // generic refresh margin.
    console.log('[kimi reauth] healthy — nothing to do');
    return;
  }
  if (isQuotaLimited(probe) && !isAuthBurnout(probe)) {
    console.log('[kimi reauth] quota/usage limited — not an auth problem; leaving pool unchanged');
    return;
  }
  if (!isAuthBurnout(probe) && !expiring && poolBefore.length > 0) {
    throw new Error(`kimi probe failed but not recognized as auth burnout: ${JSON.stringify(probe.body).slice(0, 600)}`);
  }

  const credentialsJson = await runLogin();
  const newSub = await donate(cfg, credentialsJson);
  console.log(`[kimi reauth] donated new sub id=${newSub.id ?? '?'}`);
  await persistActiveExpiry(cfg, credentialExpiresAt(credentialsJson));

  let deleted = 0;
  for (const old of poolBefore) {
    if (await deleteSubscription(cfg, old)) deleted += 1;
  }
  console.log(`[kimi reauth] revoked ${deleted}/${poolBefore.length} stale rows — rotation complete`);
}

main().catch((e) => {
  console.error(`[kimi reauth] FAILED: ${e?.stack || e}`);
  process.exit(1);
});
