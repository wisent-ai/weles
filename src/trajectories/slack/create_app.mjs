// Slack-create trajectory. Drive Google-SSO into wisent-workspace.slack.com,
// then create the bot app via steps/create_bot_app.mjs and print the xoxb
// token + app metadata to stdout.
//
// Does NOT touch ~/.claude/settings.json or any MCP config — the caller
// decides what to do with the token (paste into a vault, env var, etc.).
//
// Env: SLACK_EMAIL, SLACK_PASS, HEADLESS (optional).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..', '..');

const SLACK_EMAIL = process.env.SLACK_EMAIL || '';
const SLACK_PASS = process.env.SLACK_PASS || '';
if (!SLACK_EMAIL || !SLACK_PASS) {
  console.error('SLACK_EMAIL / SLACK_PASS env required');
  process.exit(2);
}

const { WSession } = await import(`${WELES}/dist/session/wsession.js`);
const { humanFill } = await import(`${WELES}/dist/human/keyboard.js`);
const { humanClickLocator, humanIdlePause } = await import(`${WELES}/dist/human/mouse.js`);

const headless = process.env.HEADLESS === '1';
// Pin Chromium: the about:blank round-trip + page.context().request OAuth
// POST (in steps/create_bot_app.mjs) depend on Chromium-specific behavior.
// Firefox personas hit "Navigation to about:blank is interrupted" and the
// CDP-attach path errors out. Verified live, 2026-05-22.
const s = await WSession.start({ label: 'slack-create', headless, browser: 'chromium' });
console.log('[slack-create] WSession started');

const SHOT_DIR = join(WELES, '.work', 'slack-create');
mkdirSync(SHOT_DIR, { recursive: true });
async function shot(label) {
  const fp = join(SHOT_DIR, `${label}_${Date.now()}.png`);
  try { await s.page.screenshot({ path: fp, fullPage: true }); console.log(`[slack-create] shot=${fp}`); }
  catch (e) { console.log(`[slack-create] screenshot WARN ${label}: ${e.message?.slice(0, 80)}`); }
}

async function safeShutdown() {
  if (!s.shutdown) return;
  try { await s.shutdown(); } catch (e) { console.log(`[slack-create] shutdown WARN: ${e.message?.slice(0, 80)}`); }
}

// --- Step 1: Google SSO ----------------------------------------------------
console.log(`[slack-create] step 1: Google SSO as ${SLACK_EMAIL}`);
await s.page.goto('https://wisent-workspace.slack.com', { waitUntil: 'domcontentloaded' });
await humanIdlePause('deliberate');
await shot('01-slack-landing');

const googleBtn = s.page.getByRole('button', { name: /^\s*google\s*$/i })
  .or(s.page.getByRole('link', { name: /^\s*google\s*$/i }));
await humanClickLocator(s.page, googleBtn.first(), { timeoutMs: 15000 });
await humanIdlePause('long');

await humanFill(s.page, s.page.locator('input[type="email"]').first(), SLACK_EMAIL);
await s.page.keyboard.press('Enter');
await humanIdlePause('long');

async function fillPasswordWhenAvailable() {
  const pwd = s.page.locator('input[type="password"]');
  if (await pwd.count() === 0) return false;
  await humanFill(s.page, pwd, SLACK_PASS);
  await s.page.keyboard.press('Enter');
  await humanIdlePause('long');
  return true;
}
if (!await fillPasswordWhenAvailable()) {
  // Passkey challenge path: Google presents passkey instead of password
  // input. "Try another way" → "Enter your password" surfaces the field.
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
console.log(`[slack-create] post-signin url=${s.page.url()}`);

// --- Step 2: seat workspace handoff cookie on api.slack.com ----------------
console.log('[slack-create] step 2: seat api.slack.com workspace auth');
await s.page.goto('https://wisent-workspace.slack.com/apps/manage', { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');

// --- Step 3: create the bot app ------------------------------------------------
console.log('[slack-create] step 3: api.slack.com app creation');
const { createBotApp } = await import('./steps/create_bot_app.mjs');
let xoxb = '';
try {
  xoxb = await createBotApp({ page: s.page, weles: WELES, shot });
} catch (e) {
  console.error(`[slack-create] CREATE FAILED: ${e.message?.slice(0, 200)}`);
  await shot('99-failed');
  await safeShutdown();
  process.exit(7);
}
if (!xoxb) {
  console.error('[slack-create] bot created but no xoxb on OAuth page');
  await shot('99-no-token');
  await safeShutdown();
  process.exit(7);
}
await shot('99-created');

// --- Step 4: hit auth.test so the caller has app_id + team_id + identity ---
const ctxReq = s.page.context().request;
const authRes = await ctxReq.post('https://slack.com/api/auth.test', {
  headers: { 'Authorization': `Bearer ${xoxb}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  data: '',
});
const auth = await authRes.json();
if (!auth.ok) {
  console.error(`[slack-create] auth.test rejected token: ${auth.error}`);
  await safeShutdown();
  process.exit(7);
}

console.log('[slack-create] ✓ bot ready');
console.log(`  xoxb     ${xoxb}`);
console.log(`  team     ${auth.team} (${auth.team_id})`);
console.log(`  user     ${auth.user} (${auth.user_id})`);
console.log(`  bot_id   ${auth.bot_id}`);
console.log(`  url      ${auth.url}`);

await safeShutdown();
console.log('[slack-create] done');
