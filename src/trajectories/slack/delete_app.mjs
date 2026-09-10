// Slack-delete trajectory. Drive Google-SSO into wisent-workspace.slack.com,
// then POST the delete form for SLACK_APP_ID via steps/delete_bot_app.mjs.
//
// Env: SLACK_EMAIL, SLACK_PASS, SLACK_APP_ID, HEADLESS (optional).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..', '..');

const SLACK_EMAIL = process.env.SLACK_EMAIL || '';
const SLACK_PASS = process.env.SLACK_PASS || '';
const APP_ID = process.env.SLACK_APP_ID || '';
if (!SLACK_EMAIL || !SLACK_PASS) {
  console.error('SLACK_EMAIL / SLACK_PASS env required');
  process.exit(2);
}
if (!APP_ID) {
  console.error('SLACK_APP_ID env required (e.g. A0B5SUJ9JTB)');
  process.exit(2);
}

const { WSession } = await import(`${WELES}/dist/session/wsession.js`);
const { humanFill } = await import(`${WELES}/dist/human/keyboard.js`);
const { humanClickLocator, humanIdlePause } = await import(`${WELES}/dist/human/mouse.js`);

const headless = process.env.HEADLESS === '1';
const s = await WSession.start({ label: 'slack-delete', headless });
console.log('[slack-delete] WSession started');

const SHOT_DIR = join(WELES, '.work', 'slack-delete');
mkdirSync(SHOT_DIR, { recursive: true });
async function shot(label) {
  const fp = join(SHOT_DIR, `${label}_${Date.now()}.png`);
  try { await s.page.screenshot({ path: fp, fullPage: true }); console.log(`[slack-delete] shot=${fp}`); }
  catch (e) { console.log(`[slack-delete] screenshot WARN ${label}: ${e.message?.slice(0, 80)}`); }
}

async function safeShutdown() {
  if (!s.shutdown) return;
  try { await s.shutdown(); } catch (e) { console.log(`[slack-delete] shutdown WARN: ${e.message?.slice(0, 80)}`); }
}

// --- Step 1: Google SSO ----------------------------------------------------
console.log(`[slack-delete] step 1: Google SSO as ${SLACK_EMAIL}`);
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
console.log(`[slack-delete] post-signin url=${s.page.url()}`);

// --- Step 2: seat workspace handoff cookie on api.slack.com ----------------
// api.slack.com auth is per-workspace; visiting /apps/manage on the
// workspace host triggers the redirect that plants the api.slack.com
// session for this workspace.
console.log('[slack-delete] step 2: seat api.slack.com workspace auth');
await s.page.goto('https://wisent-workspace.slack.com/apps/manage', { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');

// --- Step 3: delete the app ------------------------------------------------
console.log(`[slack-delete] step 3: deleting app ${APP_ID}`);
const { deleteBotApp } = await import('./steps/delete_bot_app.mjs');
try {
  await deleteBotApp({ page: s.page, appId: APP_ID });
  console.log(`[slack-delete] ✓ app ${APP_ID} deleted`);
  await shot('99-deleted');
} catch (e) {
  console.error(`[slack-delete] DELETE FAILED: ${e.message?.slice(0, 200)}`);
  await shot('99-failed');
  await safeShutdown();
  process.exit(7);
}

await safeShutdown();
console.log('[slack-delete] done');
