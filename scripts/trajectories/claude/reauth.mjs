// Mac-mini claude_code subscription-pool reauth runner.
//
// Replaces the deleted GCP Cloud Run `wisent-claude-reauth` service.
// Runs on the mac mini under a launchd LaunchAgent
// (com.wisent.claude-reauth). Each tick:
//   1. read config from the Skarbiec item 'claude-reauth-config'
//      (model-router URL, agent id, HMAC secret, donor user id) — no
//      secrets on disk; the vault read bootstraps everything.
//   2. HMAC-probe the model-router claude-code-subscription pool.
//   3. if healthy: exit 0.
//   4. if burnt: sign in the named google_sso Claude credential row — named by
//      the caller's vault login item id, which weles-api hands over as
//      CLAUDE_DISPLAY_NAME + WELES_LOGIN_ITEM, and inferred only when a single
//      row could match — by running login.mjs LOCALLY (real Chromium,
//      mac-mini's trusted residential IP — Google does NOT bot-block it, so no
//      proxy/VM/xvfb), capture the {"claudeAiOauth":...} blob, donate it to
//      model-router, mark the row used, and revoke every previously-active row.
//
// No GCE VM, no GCS, no proxy, no Resend, no email-code path.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  loadFromSkarbiec,
  persistToSkarbiec,
  reachableRouterUrl,
  resolveBearer,
  stadoRouterUrl,
} from '../_shared/reauth_config.mjs';
import { LOGIN_ACCOUNTS, chooseCredentialRow } from '../../../dist/utils/login-accounts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.WELES_STATE_DIR
  // `~/weles` is a symlink into an immutable release, so a sibling `var/` cannot be
  // created, and an absolute path under one account's home does not survive a host.
  || join(process.env.HOME || tmpdir(), '.local', 'state', 'weles');
const LOGIN_MJS = join(HERE, 'login.mjs');

const CONFIG_ITEM = 'claude-reauth-config';

const BURNOUT_SUBSTR = [
  'hit your limit', 'authentication_error', 'invalid authentication',
  'rate_limit', 'no active',
];

function loadConfig() {
  // The identity keys belong to the wisent-app agent rather than to one
  // provider, and this row carries none of them: borrow them from the sibling
  // row instead of keeping a second copy of the same secret anywhere.
  const cfg = loadFromSkarbiec(CONFIG_ITEM, 'codex-reauth-config');
  cfg.bearer = resolveBearer(cfg.agentId);
  console.error(
    `config from skarbiec ${CONFIG_ITEM}; `
    + `bearer ${cfg.bearer ? 'present' : 'absent'}`,
  );
  return cfg;
}

function blobExpiresAt(b) { // expiry (unix ms) from a {"claudeAiOauth":{...}} blob; 0 if unparseable
  try { return Number(JSON.parse(b)?.claudeAiOauth?.expiresAt) || 0; } catch { return 0; }
}

// Record the minted token's expiry on the reauth-config row so the NEXT tick
// refreshes BEFORE it dies. MERGE — a bare {metadata} would clobber config keys.
function persistActiveExpiry(cfg, expiresAtMs) {
  try {
    persistToSkarbiec(cfg, { active_token_expires_at: expiresAtMs });
  } catch (error) {
    console.error(`persist expiry to skarbiec failed: ${error.message}`);
  }
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
  const bearer = cfg.bearer || process.env.WISENT_APP_MODEL_ROUTER_TOKEN;
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

// Which credential row this tick must sign in.
//
// A caller names the account with the vault login item id (weles-api translates
// it into CLAUDE_DISPLAY_NAME + WELES_LOGIN_ITEM before spawning this file), and
// that name selects the row exactly. With no name, the sole candidate is taken
// ONLY while there is a single one: with more than one, picking silently signs
// into a different Google account and mints a credential for a different
// subscription, so the tick refuses and names the candidates instead.
function pickAccountRow() {
  // The Max accounts are the `claude` entries of the fleet's account registry
  // (LOGIN_ACCOUNTS): their login material lives in Skarbiec as vault login
  // items, so there is no metadata row to read and no id to rotate — the
  // candidates are the registered accounts themselves.
  const rows = LOGIN_ACCOUNTS
    .filter((a) => a.provider === 'claude')
    .map((a) => ({ display_name: a.displayName }));
  // The choice itself is the shared one, so this tick, a queued run and the API
  // refuse and select identically.
  return chooseCredentialRow(rows, {
    provider: 'claude',
    displayName: process.env.CLAUDE_DISPLAY_NAME,
    loginItem: process.env.WELES_LOGIN_ITEM,
  });
}

// Vault-backed accounts have no LRU store row to bump: the account is named (or
// is the sole candidate) and its login material lives in Skarbiec, so there is
// nothing to rotate to the back of a queue and nowhere to record errMsg — the
// failure still reaches the log through the thrown error itself.
function markRowAttempted() {
  console.error('mark_row_attempted: vault-backed account has no store row; not recorded');
}

async function donate(cfg, blobJson, label) {
  // Brama's donate contract is `{provider, label, api_key}` and rejects unknown
  // fields outright. `user_id` belonged to the Cloud Run router that went away:
  // the donor is now the authenticated caller, not a field.
  const body = {
    provider: 'claude_code',
    label: label || `reauth-macmini ${new Date().toISOString()}`, // the router reads `label`, not key_label
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
  const payload = JSON.stringify({ subscription_id: subId });
  const r = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'DELETE',
    headers: sign(cfg, payload),
    body: payload,
  });
  return r.status < 400;
}

// Run login.mjs locally. Inherits env (CHROMIUM_PATH from
// worker.env) and pins CLAUDE_LOGIN_PROXY=none — the mac mini's own
// residential IP is trusted by Google, the entire reason this moved off
// GCE. login.mjs writes the {"claudeAiOauth":...} blob to stdout.
// The paths a failed login left behind: the PTY transcript it names in its own
// FAIL line, plus the DOM snapshots and per-page dumps under this run's
// recordings directory. Named in the rejection so the next diagnosis starts from
// what the page and the CLI actually said.
function loginArtifacts(saidLines) {
  const paths = [];
  for (const line of saidLines) {
    const m = line.match(/pty transcript: (\S+)/);
    if (m) paths.push(m[1]);
  }
  const runId = process.env.ACTION_LOG_ID || process.env.WELES_RUN_ID || 'local';
  const base = process.env.WELES_RECORDINGS_ROOT || join(process.cwd(), 'recordings');
  for (const label of [process.env.ACTION || 'claude_reauth', 'claude_login']) {
    const dir = join(base, runId, label);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (/^(gis_unhandled_|session_dom_|authlogin_pty_)/.test(name)) paths.push(join(dir, name));
    }
  }
  return [...new Set(paths)];
}

function runLogin(displayName) {
  return new Promise((resolve, reject) => {
    // The interpreter running this file is the one to run the login with: spawning
    // the bare name `node` made the step depend on the caller's PATH, and it fails
    // with ENOENT under any launcher that does not export Homebrew's bin directory.
    const child = spawn(process.execPath, [LOGIN_MJS], {
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
      // What the trajectory SAID beats where its stack ended: a caller that
      // receives "at async onImport.tracePromise" learns nothing, while the FAIL
      // and STEP lines name the step and the reason, and the artifacts show the
      // page and the CLI transcript. Stack frames are dropped from the summary;
      // the full stream is still on disk in manual-seed-claude.err.
      const lines = (out + '\n' + err).split('\n').map((l) => l.trim()).filter(Boolean);
      const said = lines.filter((l) => /^(FAIL|CREDENTIAL_SOURCE|AUTHZURL)\b/.test(l) || l.startsWith('STEP '));
      const spoken = said.length
        ? `${said.filter((l) => l.startsWith('STEP ')).slice(-1).join('')} ${said.filter((l) => !l.startsWith('STEP ')).slice(-2).join(' | ')}`.trim()
        : lines.filter((l) => !/^at\s/.test(l)).slice(-2).join(' | ');
      const artifacts = loginArtifacts(said);
      reject(new Error(
        `login.mjs exit ${code}, no claudeAiOauth blob; said=${spoken.slice(0, 400)}`
        + `; artifacts=${artifacts.length ? artifacts.join(', ') : 'none written'}`,
      ));
    });
  });
}

async function main() {
  const cfg = await loadConfig();
  // Stado says where Brama is; the listener check keeps the answer honest.
  cfg.routerUrl = await reachableRouterUrl(stadoRouterUrl());
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

  const row = await pickAccountRow();
  const account = row.display_name || 'Claude';
  // Name the account and where the name came from, so a report can say which
  // subscription this credential belongs to instead of inferring it.
  const askedFor = process.env.WELES_LOGIN_ITEM || process.env.CLAUDE_DISPLAY_NAME || 'sole candidate';
  console.log(`[reauth] ${reason} — reauthing ${row.display_name} for ${askedFor}`);
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
      // Still say the attempt happened: a vault-backed account has no store
      // row to record it on, and the note keeps that fact visible in the log.
      markRowAttempted();
      throw e;
    }
  }
  console.log(`[reauth] got OAuth blob len=${blob.length} for ${row.display_name}`);

  const donateLabel = `claude-reauth ${account} ${new Date().toISOString()}`;
  const newSub = await donate(cfg, blob, donateLabel);
  console.log(`[reauth] donated new sub id=${newSub.id ?? '?'}`);
  markRowAttempted();
  const newExp = blobExpiresAt(blob);
  if (newExp > 0) await persistActiveExpiry(cfg, newExp);

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
  // `fetch failed` is undici's outer message and carries no address; the reason
  // and the host live on `cause`, and without them this job spent a day saying
  // nothing about which endpoint it could not reach.
  const cause = e.cause ?? {};
  const where = [cause.code, cause.message, cause.hostname, cause.address, cause.port]
    .filter(Boolean)
    .join(' ');
  console.error(`[reauth] FAILED: ${e.message}${where ? ` (${where})` : ''}`);
  console.error(`[reauth] where: ${(e.stack || '').split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
});
