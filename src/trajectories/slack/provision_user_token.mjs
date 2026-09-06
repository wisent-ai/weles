#!/usr/bin/env node
// Provision a Slack User OAuth Token (xoxp) through the logged-in workspace flow.
//
// Required env:
//   WELES_SECRET_RESULT_FILE     JSON output path for the raw token; stdout stays redacted
// Optional env:
//   SLACK_EMAIL, SLACK_PASS      login through Google SSO; otherwise reuse existing Slack session
//   SLACK_APP_ID                 reuse an existing app and scrape its User OAuth Token
//   SLACK_USER_TOKEN_SCOPES      comma/space list; default is chat:write + read scopes

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..', '..');
process.env.WELES_ROOT = WELES;

const SLACK_EMAIL = process.env.SLACK_EMAIL || '';
const SLACK_PASS = process.env.SLACK_PASS || '';
const RESULT_FILE = process.env.WELES_SECRET_RESULT_FILE || '';

function tokenSummary(token) {
  return { prefix: token.slice(0, 5), length: token.length };
}

function writeSecretResult(result) {
  if (!RESULT_FILE) {
    console.log('[slack-user-token] WELES_SECRET_RESULT_FILE unset; raw token not written');
    return;
  }
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  console.log(`[slack-user-token] wrote secret result to ${RESULT_FILE}`);
}

function persistSlackUserTokenResult(result) {
  const tokenPath = process.env.SLACK_TOKENS_FILE || join(homedir(), '.oko', 'slack_tokens.json');
  let existing = {};
  try {
    if (existsSync(tokenPath)) existing = JSON.parse(readFileSync(tokenPath, 'utf8'));
  } catch {
    existing = {};
  }
  const updated = {
    ...existing,
    slack_user_token: result.token,
    slack_user_token_app_id: result.app_id,
    slack_user_token_team: result.team,
    slack_user_token_team_id: result.team_id,
    slack_user_token_user: result.user,
    slack_user_token_user_id: result.user_id,
    slack_user_token_scopes: result.scopes,
    slack_user_token_created_at: result.created_at,
  };
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(updated, null, 2));
  try { chmodSync(tokenPath, 0o600); } catch {}
  console.log(`[slack-user-token] persisted xoxp metadata to ${tokenPath}`);
}

if (!RESULT_FILE) {
  console.error('WELES_SECRET_RESULT_FILE env required');
  process.exit(2);
}

const { WSession } = await import(`${WELES}/dist/session/wsession.js`);
const { humanFill } = await import(`${WELES}/dist/human/keyboard.js`);
const { humanClickLocator, humanIdlePause } = await import(`${WELES}/dist/human/mouse.js`);

const headless = process.env.HEADLESS === '1';
const s = await WSession.start({ label: 'slack-user-token', headless, browser: 'chromium' });
console.log('[slack-user-token] WSession started');

const SHOT_DIR = join(WELES, '.work', 'slack-user-token');
mkdirSync(SHOT_DIR, { recursive: true });
async function shot(label) {
  const fp = join(SHOT_DIR, `${label}_${Date.now()}.png`);
  try { await s.page.screenshot({ path: fp, fullPage: true }); console.log(`[slack-user-token] shot=${fp}`); }
  catch (e) { console.log(`[slack-user-token] screenshot WARN ${label}: ${e.message?.slice(0, 80)}`); }
}

async function safeShutdown() {
  if (!s.shutdown) return;
  try { await s.shutdown(); } catch (e) { console.log(`[slack-user-token] shutdown WARN: ${e.message?.slice(0, 80)}`); }
}

async function fillPasswordWhenAvailable() {
  const pwd = s.page.locator('input[type="password"]:not([aria-hidden="true"])').first();
  if (await pwd.count() === 0) return false;
  await pwd.waitFor({ state: 'visible', timeout: 10000 });
  await pwd.click({ timeout: 10000 });
  await s.page.keyboard.type(SLACK_PASS, { delay: 12 });
  await s.page.keyboard.press('Enter');
  await humanIdlePause('long');
  return true;
}

try {
  if (SLACK_EMAIL && SLACK_PASS) {
    console.log(`[slack-user-token] step 1: Google SSO as ${SLACK_EMAIL}`);
    await s.page.goto('https://wisent-workspace.slack.com', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
    await shot('01-slack-landing');

    const googleBtn = s.page.getByRole('button', { name: /^\s*google\s*$/i })
      .or(s.page.getByRole('link', { name: /^\s*google\s*$/i }));
    await humanClickLocator(s.page, googleBtn.first(), { timeoutMs: 15000 });
    await humanIdlePause('long');

    const emailInput = s.page.locator('input[type="email"]').first();
    if (await emailInput.count() > 0) {
      await humanFill(s.page, emailInput, SLACK_EMAIL);
      await s.page.keyboard.press('Enter');
      await humanIdlePause('long');
    }

    if (!await fillPasswordWhenAvailable()) {
      const tryOther = s.page.getByRole('button', { name: /try another way/i })
        .or(s.page.getByRole('link', { name: /try another way/i }));
      if (await tryOther.count() > 0) {
        await humanClickLocator(s.page, tryOther.first(), { timeoutMs: 10000 });
        await humanIdlePause('long');
        const enterPwd = s.page.getByText(/enter your password/i).first();
        if (await enterPwd.count() > 0) {
          await humanClickLocator(s.page, enterPwd, { timeoutMs: 10000 });
          await humanIdlePause('long');
          await fillPasswordWhenAvailable();
        }
      }
    }

    const continueBtn = s.page.getByRole('button', { name: /^\s*continue\s*$/i });
    if (await continueBtn.count() > 0) {
      await humanClickLocator(s.page, continueBtn.first(), { timeoutMs: 10000 });
      await humanIdlePause('long');
    }
  } else {
    console.log('[slack-user-token] step 1: using existing Slack browser session; SLACK_EMAIL/SLACK_PASS unset');
    await s.page.goto('https://wisent-workspace.slack.com/messages', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
  }
  console.log(`[slack-user-token] post-signin url=${s.page.url()}`);

  console.log('[slack-user-token] step 2: seat api.slack.com workspace auth');
  await s.page.goto('https://wisent-workspace.slack.com/apps/manage', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  console.log('[slack-user-token] step 3: app install/token extraction');
  const { createUserTokenApp } = await import('./steps/create_user_token_app.mjs');
  const provisioned = await createUserTokenApp({ page: s.page, shot, appId: process.env.SLACK_APP_ID || '' });
  if (!provisioned.token?.startsWith('xoxp-')) throw new Error('[slack-user-token] expected xoxp token from OAuth page');

  const authRes = await s.page.context().request.post('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${provisioned.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    data: '',
  });
  const auth = await authRes.json();
  if (!auth.ok) throw new Error(`[slack-user-token] auth.test rejected token: ${auth.error}`);

  const result = {
    ok: true,
    token: provisioned.token,
    token_prefix: 'xoxp-',
    token_length: provisioned.token.length,
    app_id: provisioned.appId,
    app_created: provisioned.created,
    scopes: provisioned.scopes,
    team: auth.team,
    team_id: auth.team_id,
    user: auth.user,
    user_id: auth.user_id,
    url: auth.url,
    created_at: new Date().toISOString(),
  };
  writeSecretResult(result);
  persistSlackUserTokenResult(result);
  console.log(`[slack-user-token] ready ${JSON.stringify({ ...tokenSummary(provisioned.token), app_id: provisioned.appId, team: auth.team, user: auth.user })}`);
  await safeShutdown();
  process.exit(0);
} catch (e) {
  console.error(`[slack-user-token] failed: ${e.message?.slice(0, 300)}`);
  await safeShutdown();
  process.exit(7);
}
