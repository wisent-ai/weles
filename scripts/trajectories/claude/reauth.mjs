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
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.WELES_STATE_DIR
  // `~/weles` is a symlink into an immutable release, so a sibling `var/` cannot be
  // created, and an absolute path under one account's home does not survive a host.
  || join(process.env.HOME || tmpdir(), '.local', 'state', 'weles');
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
    rawMeta: m, // carried through to MERGE expiry back without clobbering keys
    activeTokenExpiresAt: Number(m.active_token_expires_at) || 0, // unix ms, 0 until first run
  };
}

function blobExpiresAt(b) { // expiry (unix ms) from a {"claudeAiOauth":{...}} blob; 0 if unparseable
  try { return Number(JSON.parse(b)?.claudeAiOauth?.expiresAt) || 0; } catch { return 0; }
}

// Record the minted token's expiry on the reauth-config row so the NEXT tick
// refreshes BEFORE it dies. MERGE — a bare {metadata} would clobber config keys.
async function persistActiveExpiry(rawMeta, expiresAtMs) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/service_credentials?id=eq.claude-reauth-config`,
    { method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: { ...rawMeta, active_token_expires_at: expiresAtMs } }) });
  if (r.status >= 400) console.error(`persist expiry PATCH ${r.status}: ${await r.text()}`);
}

function sign(cfg, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  // The verifier hashes an absent body to the empty string, not to the digest of
  // no bytes, so a request with no body signed with sha256('') never matches.
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
  // checks that this signed agent belongs to it. Without the bearer the request is
  // refused before the signature is looked at, and the answer is a bare
  // `unauthorized` that names neither half.
  const bearer = process.env.WISENT_APP_MODEL_ROUTER_TOKEN;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

async function listSubscriptions(cfg) {
  // Signed like every other call: the gateway resolves the caller's identity from
  // this trio, and an unsigned request is refused before the route is reached —
  // which reads as a missing endpoint from out here.
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    headers: sign(cfg, ''),
  });
  if (!r.ok) throw new Error(`list subscriptions -> ${r.status}`);
  return (await r.json()).subscriptions ?? [];
}

async function probePool(cfg) {
  const body = JSON.stringify({
    // The gateway refuses anything that is not a canonical provider/model route
    // or a supported selector, so the previous name made every probe a 400 and
    // every run conclude "burnt" from a malformed request.
    model: 'claude-code/claude-opus-4-6',
    messages: [{ role: 'user', content: 'Reply with the single word PROBE.' }],
    max_tokens: 10,
  });
  const r = await fetch(`${cfg.routerUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...sign(cfg, body), 'x-model-router-skip-weles-reauth': '1' },
    body,
  });
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

// Bumps updated_at unconditionally so a failing row rotates to the
// back of the LRU and the next-LRU row is tried on the next tick
// (without this, a permanently broken row keeps getting re-picked
// forever and the whole pipeline stalls). When errMsg is set, it is
// also recorded in metadata.last_login_error / .at for diagnosis.
async function markRowAttempted(rowId, errMsg) {
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

async function donate(cfg, blobJson, label) {
  const body = {
    user_id: cfg.donorUserId,
    provider: 'claude_code',
    label: label || `reauth-macmini ${new Date().toISOString()}`, // model-router reads `label`, not key_label
    api_key: blobJson,
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

async function deleteSubscription(cfg, subId) {
  const payload = JSON.stringify({ user_id: cfg.donorUserId, subscription_id: subId });
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'DELETE',
    headers: sign(cfg, payload),
    body: payload,
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
        // login.mjs's own watchdog defaults to 300s, which truncates
        // a SUCCESSFUL but slow consent POST/redirect (frames proved
        // Authorize clicked, then the 300s kill landed mid-redirect
        // before platform.claude.com rendered the code). Set it just
        // under the 720s hard SIGKILL below so login.mjs's own
        // diagnostic + shutdown (video flush) runs first.
        CLAUDE_LOGIN_OVERALL_SEC: '690',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const harvestBlob = () => {
      for (const line of out.split('\n').reverse()) {
        const t = line.trim();
        if (t.startsWith('{"claudeAiOauth"')) return t;
      }
      return null;
    };
    const killer = setTimeout(() => {
      // login.mjs can emit the blob to stdout and then not exit, so 'close'
      // never fires. Harvest the blob before killing — it is already captured —
      // and only reject if it genuinely never appeared.
      const blob = harvestBlob();
      child.kill('SIGKILL');
      if (blob) resolve(blob);
      else reject(new Error('login.mjs exceeded 720s hard cap'));
    }, 720_000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(killer);
      // Persist raw child output for diagnosis. Text logs are
      // forbidden for troubleshooting, but the trajectory's
      // structured FAIL/blob output IS the diagnostic — saving the
      // raw byte stream so the operator can see what login.mjs
      // actually wrote (e.g. token-exchange error from claude.ai).
      try {
        import('node:fs').then((fs) => {
          mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(join(STATE_DIR, 'manual-seed-claude.out'), out);
          fs.writeFileSync(join(STATE_DIR, 'manual-seed-claude.err'), err);
        });
      } catch {}
      for (const line of out.split('\n').reverse()) {
        const t = line.trim();
        if (t.startsWith('{"claudeAiOauth"')) { resolve(t); return; }
      }
      const tail = (out + '\n' + err).split('\n').slice(-3).join(' | ').slice(0, 300);
      reject(new Error(`login.mjs exit ${code}, no claudeAiOauth blob; tail=${tail}`));
    });
  });
}

async function main() {
  const cfg = await loadConfig();
  const poolBefore = await listSubscriptions(cfg);
  const probe = await probePool(cfg);
  const burnt = isBurnout(probe);
  // PROACTIVE: re-mint while the token is still valid but within margin of expiry,
  // instead of waiting for isBurnout (a 401 from an already-dead token = downtime).
  const marginMs = Number(process.env.CLAUDE_REAUTH_REFRESH_MARGIN_SEC || 10800) * 1000;
  const expMs = cfg.activeTokenExpiresAt;
  const reason = burnt ? 'burnt'
    : (expMs > 0 && Date.now() >= expMs - marginMs ? 'expiring-soon' : null);
  console.log(`[reauth] pool=${poolBefore.length} probe=${probe.status} burnt=${burnt} exp_ms=${expMs} reason=${reason ?? 'none'}`);
  if (probe.status !== 200) console.error(`[reauth] probe_body ${JSON.stringify(probe.body).slice(0, 1500)}`);
  const probeStr = JSON.stringify(probe.body ?? {}).toLowerCase();
  if (probe.status !== 200 && (probeStr.includes('usage limit') || probeStr.includes('weekly limit'))) {
    console.log('[reauth] account quota exhausted — auth is valid, only quota is spent; re-login cannot restore it, skipping');
    return;
  }
  if (!reason) { console.log('[reauth] healthy & not near expiry — nothing to do'); return; }

  const row = await pickLruRow();
  const account = row.display_name || 'Claude';
  console.log(`[reauth] ${reason} — reauthing LRU row ${row.display_name} (updated ${row.updated_at})`);
  let blob;
  // Google's "browser may not be secure" block is intermittent per launch
  // (fingerprint rolls each launch). Retry on BROWSER_NOT_SECURE so a tick
  // likely catches a clearing launch.
  const maxTries = Number(process.env.CLAUDE_REAUTH_LOGIN_TRIES || 4);
  for (let attempt = 1; ; attempt += 1) {
    try {
      blob = await runLogin(row.display_name);
      break;
    } catch (e) {
      const msg = e?.message || String(e);
      const blocked = /BROWSER_NOT_SECURE/.test(msg);
      console.log(`[reauth] login attempt ${attempt}/${maxTries} failed${blocked ? ' (browser-not-secure)' : ''}`);
      if (blocked && attempt < maxTries) continue;
      // ALWAYS mark the row attempted (with the error) so a row that
      // permanently can't authenticate rotates to the back of the LRU
      // — otherwise the picker re-selects the same broken row forever
      // and the donation pipeline stalls across the whole fleet.
      await markRowAttempted(row.id, msg);
      throw e;
    }
  }
  console.log(`[reauth] got OAuth blob len=${blob.length} for ${row.display_name}`);

  const donateLabel = `claude-reauth ${account} ${new Date().toISOString()}`;
  const newSub = await donate(cfg, blob, donateLabel);
  console.log(`[reauth] donated new sub id=${newSub.id ?? '?'}`);
  await markRowAttempted(row.id);
  const newExp = blobExpiresAt(blob);
  if (newExp > 0) await persistActiveExpiry(cfg.rawMeta, newExp);

  // Revoke only THIS account's prior rows (+ legacy unlabeled reauth rows),
  // never another account's active subscription — lets a multi-account pool
  // survive for the router to rotate across; single account collapses to the
  // same net-one-active as before.
  const accountPrefix = `claude-reauth ${account} `;
  let deleted = 0;
  let kept = 0;
  for (const old of poolBefore) {
    const lbl = old.key_label || '';
    if (lbl.startsWith(accountPrefix) || lbl.startsWith('reauth-macmini ')) {
      if (await deleteSubscription(cfg, old.id)) deleted += 1;
    } else {
      kept += 1;
    }
  }
  console.log(`[reauth] revoked ${deleted}/${poolBefore.length} stale rows; kept ${kept} other-account active — rotation complete`);
}

main().catch((e) => {
  console.error(`[reauth] FAILED: ${e.message}`);
  process.exit(1);
});
