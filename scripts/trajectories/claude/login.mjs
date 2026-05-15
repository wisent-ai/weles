// Claude Code OAuth login trajectory.
//
// Drives the public claude-code OAuth client through the
// authorization-code-with-PKCE grant against the same login surface
// that the `claude` CLI uses: https://claude.ai/oauth/authorize and
// https://claude.ai/v1/oauth/token. Produces the access+refresh blob
// that claude-code persists in macOS Keychain at "Claude Code-credentials",
// printed to stdout so the operator decides what to do with it.
//
// Credentials: reads service_credentials display_name='Claude' (email +
// password) like every other login.mjs in this repo. The trajectory has
// NO side effects beyond stdout — it does not write to any keychain,
// secret manager, model-router, or supabase row.
//
// 2FA: Anthropic's login page may prompt for a TOTP after password.
// Pass it via CLAUDE_2FA_CODE env var (mirrors apple/login.mjs).
//
// Run: node scripts/trajectories/claude/login.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_TOKEN_URL,
  CLAUDE_OAUTH_SCOPES,
} from './oauth_config.mjs';
import { pageDiag, startWatchdog } from './diag.mjs';
import { doGoogleSso } from './google_sso.mjs';

const DISPLAY_NAME = process.env.CLAUDE_DISPLAY_NAME || 'Claude';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function genPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function startCallbackListener() {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        const code = reqUrl.searchParams.get('code');
        const err = reqUrl.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(`oauth error: ${err}`);
          rejectCode(new Error(`oauth error from authorize: ${err}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('no code');
          rejectCode(new Error('no code in callback'));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>OAuth code received. You can close this window.</body></html>');
        resolveCode(code);
      } catch (e) {
        rejectCode(e);
      }
    });
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveServer({ port, url: `http://127.0.0.1:${port}/callback`, codePromise, server });
    });
  });
}

async function exchangeCodeForToken(code, verifier, redirectUri) {
  const body = {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: CLAUDE_CLIENT_ID,
  };
  const r = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`token exchange HTTP ${r.status}: ${txt.slice(0, 400)}`);
  return JSON.parse(txt);
}

function buildBlob(tokenResponse) {
  const expiresMs = Date.now() + (tokenResponse.expires_in || 0) * 1000;
  return {
    claudeAiOauth: {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: expiresMs,
      scopes: (tokenResponse.scope || '').split(/\s+/).filter(Boolean),
      subscriptionType: tokenResponse.account?.subscription_type || null,
      tokenUuid: tokenResponse.token_uuid,
      organizationUuid: tokenResponse.organization?.uuid,
      accountEmail: tokenResponse.account?.email_address,
    },
  };
}

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log(`FAIL: no '${DISPLAY_NAME}' row in service_credentials`); process.exit(1); }
console.log(`[claude-login] using service login: ${login.email}`);

const { verifier, challenge } = genPkce();
const listener = await startCallbackListener();
console.log(`[claude-login] callback listener on ${listener.url}`);

const params = new URLSearchParams({
  client_id: CLAUDE_CLIENT_ID,
  response_type: 'code',
  redirect_uri: listener.url,
  scope: CLAUDE_OAUTH_SCOPES.join(' '),
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: b64url(crypto.randomBytes(16)),
});
const authorizeUrl = `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`;

// Google/Anthropic SSO from a datacenter IP gets hard-blocked. Route
// through a residential exit (resolveProxy picks the highest-balance
// residential provider whose *_USERNAME/*_PASSWORD env vars are set).
// CLAUDE_LOGIN_PROXY overrides the selector ('none' to force direct).
const proxySel = process.env.CLAUDE_LOGIN_PROXY ?? 'residential us';
const s = await WSession.start({
  label: 'claude_login',
  browser: 'chromium',
  proxy: proxySel === 'none' ? undefined : proxySel,
});

// Overall watchdog. The per-step playwright waits have 30s defaults, but
// humanIdlePause / humanClickLocator / weles goto-hooks can stall without
// a deadline, leaving the process hung, the VM never self-deleting, and
// no blob written. STEP tracks the last entered phase; on the deadline we
// dump STEP + live page state so the EXACT stuck line lands in the blob.
let STEP = 'init';
const mark = (n) => { STEP = n; console.log(`[step] ${n}`); };
const overallSec = Number(process.env.CLAUDE_LOGIN_OVERALL_SEC || 300);
const wd = startWatchdog(() => s.page, () => STEP, overallSec);

try {
  mark('goto_authorize');
  await s.goto(authorizeUrl);
  await humanIdlePause('deliberate');

  if (login.loginMethod === 'google_sso') {
    mark('find_google_button');
    // claude.ai/oauth/authorize redirects to a login SPA that renders the
    // provider buttons client-side, so an instant isVisible() races the
    // render. Wait for it; on miss dump live HTML so the real markup (and
    // correct selector) lands in the blob.
    const googleBtn = s.page.getByRole('button', { name: /google/i })
      .or(s.page.getByRole('link', { name: /google/i }))
      .or(s.page.locator('button:has-text("Google"), a:has-text("Google"), [data-provider="google" i], button[aria-label*="Google" i]'))
      .first();
    try {
      await googleBtn.waitFor({ state: 'visible' });
    } catch (e) {
      console.log(`FAIL: google button not visible (${e.message}). ${await pageDiag(s.page, { html: true })}`);
      process.exit(1);
    }
    await doGoogleSso({
      page: s.page,
      context: s.page.context(),
      googleBtn,
      login,
      mark,
      humanFill,
      humanClickLocator,
      humanIdlePause,
    });
    mark('wait_back_to_claude');
    await s.page.waitForURL(/claude\.ai/);
    await humanIdlePause('deliberate');
  } else {
    const emailIn = s.page.locator('input[type="email"], input[name="email"], input[autocomplete="email"], input[id*="email" i]').filter({ visible: true }).first();
    if (!(await emailIn.isVisible().catch(() => false))) {
      console.log('FAIL: email input not visible on claude.ai login');
      process.exit(1);
    }
    await humanFill(s.page, emailIn, login.email);
    await humanIdlePause('short');

    const continueBtn = s.page.locator('button:has-text("Continue"), button[type="submit"]').filter({ visible: true }).first();
    await humanClickLocator(s.page, continueBtn);
    await humanIdlePause('deliberate');

    const pwIn = s.page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').filter({ visible: true }).first();
    await pwIn.waitFor({ state: 'visible' });
    await humanFill(s.page, pwIn, login.password);
    await humanIdlePause('short');
    const signinBtn = s.page.locator('button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]').filter({ visible: true }).first();
    await humanClickLocator(s.page, signinBtn);
    await humanIdlePause('long');

    const otpIn = s.page.locator('input[autocomplete="one-time-code"], input[name="code"], input[id*="otp" i], input[inputmode="numeric"]').filter({ visible: true }).first();
    if (await otpIn.isVisible().catch(() => false)) {
      const otp = process.env.CLAUDE_2FA_CODE;
      if (!otp) {
        console.log('FAIL: 2FA prompt visible but CLAUDE_2FA_CODE env not set');
        process.exit(1);
      }
      await humanFill(s.page, otpIn, otp);
      const otpSubmit = s.page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Continue")').filter({ visible: true }).first();
      await humanClickLocator(s.page, otpSubmit);
      await humanIdlePause('long');
    }
  }

  mark('oauth_consent');
  const authorizeBtn = s.page.locator('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Continue")').filter({ visible: true }).first();
  if (await authorizeBtn.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, authorizeBtn);
    await humanIdlePause('long');
  }
  mark('await_callback');

  // Step 5 — wait for callback listener to receive the code. The OAuth
  // redirect can silently never fire (unhandled challenge, consent DOM
  // changed, redirect blocked). Without a deadline the process hangs
  // forever, the VM never self-deletes, and no blob is ever written —
  // an unobservable stall. Race the code against a deadline that dumps
  // the live page state so the EXACT cause is captured in the blob.
  const deadlineSec = Number(process.env.CLAUDE_LOGIN_DEADLINE_SEC || 180);
  const deadline = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`callback not received within ${deadlineSec}s`)), deadlineSec * 1000));
  let code;
  try {
    code = await Promise.race([listener.codePromise, deadline]);
  } catch (e) {
    throw new Error(`${e.message}. ${await pageDiag(s.page)}`);
  }
  clearTimeout(wd);
  console.log(`[claude-login] received code (len=${code.length})`);

  const tokenResp = await exchangeCodeForToken(code, verifier, listener.url);
  const blob = buildBlob(tokenResp);
  console.log('[claude-login] token exchange succeeded');
  process.stdout.write(JSON.stringify(blob) + '\n');
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  listener.server.close();
  await s.close();
}
