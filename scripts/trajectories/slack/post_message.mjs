// scripts/trajectories/slack/post_message.mjs
//
// Drive Google-SSO login into wisent.slack.com, create a workspace app via
// the manifest flow, extract the bot token, post the Jakub status message.
// Per the per-trajectory CLAUDE.md, all invariants (workspace url, scope
// list, credential source) are recorded there.
//
// Env required:
//   SSO_EMAIL                — sourced from weles/.work/_sso.env
//   SSO_PASS                 — sourced from weles/.work/_sso.env
//   MESSAGE_FILE             — defaults to swiatowid/.work/jakub-status.txt
//   TARGET_CHANNEL or NAME   — defaults to "jakub"; "general" if not found
//   SWT_CLI                  — path to swt-cli binary
//
// Run:
//   set -a; . weles/.work/_sso.env; set +a
//   node weles/scripts/trajectories/slack/post_message.mjs

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..', '..');
const SWIATOWID = join(WELES, '..', 'swiatowid');
const MESSAGE_FILE = process.env.MESSAGE_FILE
  || join(SWIATOWID, '.work', 'jakub-status.txt');
const SWT_CLI = process.env.SWT_CLI
  || join(SWIATOWID, '.build', 'debug', 'swt-cli');
const SETTINGS = join(process.env.HOME, '.claude', 'settings.json');
const TARGET_NAME = (process.env.SLACK_TARGET_CHANNEL_NAME || 'jakub').toLowerCase();
const TARGET_CHAN = process.env.SLACK_TARGET_CHANNEL || '';

if (!process.env.SSO_EMAIL || !process.env.SSO_PASS) {
  console.error('SSO_EMAIL / SSO_PASS missing — source weles/.work/_sso.env first');
  process.exit(2);
}
if (!existsSync(MESSAGE_FILE)) {
  console.error(`MESSAGE_FILE not found: ${MESSAGE_FILE}`);
  process.exit(2);
}

// 12-scope app manifest matching M58/M59 swiatowid/scripts/slack-bootstrap.sh.
const MANIFEST_YAML = `display_information:
  name: Claude Code
  description: Claude Code (Anthropic CLI) — posts status updates and reads channel context.
  background_color: "#1f1f1f"
features:
  bot_user:
    display_name: Claude Code
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - im:history
      - mpim:history
      - users:read
      - users:read.email
      - reactions:read
      - reactions:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

const { WSession } = await import(`${WELES}/dist/session/wsession.js`);
const { humanFill } = await import(`${WELES}/dist/human/keyboard.js`);
const { humanClickLocator, humanIdlePause } = await import(`${WELES}/dist/human/mouse.js`);

const headless = process.env.HEADLESS === '1';
const s = await WSession.start({ label: 'slack-post', headless });
console.log('[slack] WSession started');

const SHOT_DIR = join(WELES, '.work', 'slack-post');
mkdirSync(SHOT_DIR, { recursive: true });
async function shot(label) {
  const fp = join(SHOT_DIR, `${label}_${Date.now()}.png`);
  try { await s.page.screenshot({ path: fp, fullPage: true }); console.log(`[slack] shot=${fp}`); }
  catch (e) { console.log(`[slack] screenshot WARN ${label}: ${e.message?.slice(0, 80)}`); }
}

async function safeShutdown() {
  if (!s.shutdown) return;
  try { await s.shutdown(); } catch (e) { console.log(`[slack] shutdown WARN: ${e.message?.slice(0, 80)}`); }
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

// --- Step 1: Google SSO into wisent.slack.com -------------------------------
console.log('[slack] step 1: log into wisent.slack.com via Google SSO');
await s.page.goto('https://wisent.slack.com', { waitUntil: 'domcontentloaded' });
await humanIdlePause('deliberate');
await shot('01-slack-landing');

// Slack's button label is literally "Google" (with the G icon). Try the
// strict-match variant first, then variants seen on enterprise / SSO pages.
const googleBtn = s.page.getByRole('button', { name: /^\s*google\s*$/i })
  .or(s.page.getByRole('link', { name: /^\s*google\s*$/i }))
  .or(s.page.getByRole('button', { name: /sign in with google/i }))
  .or(s.page.getByRole('link', { name: /sign in with google/i }));
let popup = null;
try {
  const popupPromise = s.page.context().waitForEvent('page');
  await humanClickLocator(s.page, googleBtn.first(), { timeoutMs: 15000 });
  popup = await popupPromise;
} catch (e) {
  console.log(`[slack] no popup: ${e.message?.slice(0, 80)} — continuing on main page`);
}
if (popup) {
  console.log(`[slack] Google SSO opened in popup ${popup.url()}`);
  s.page = popup;
}
await humanIdlePause('deliberate');
await shot('02-google-email');

await humanFill(s.page, s.page.locator('input[type="email"]'), process.env.SSO_EMAIL);
await s.page.keyboard.press('Enter');
await humanIdlePause('long');
await shot('03-google-postemail');

// Google may show password OR a passkey/2FA challenge directly. Handle both.
const pwdInput = s.page.locator('input[type="password"]');
const pwdCount = await pwdInput.count();
if (pwdCount > 0) {
  await humanFill(s.page, pwdInput, process.env.SSO_PASS);
  await s.page.keyboard.press('Enter');
  await humanIdlePause('long');
  await shot('04-after-password');
} else {
  console.log('[slack] no password field; landed on a 2FA/passkey challenge');
  await shot('04a-2fa-challenge');
  // Click "Try another way" to enumerate alternate options.
  const tryOther = s.page.getByRole('button', { name: /try another way/i })
    .or(s.page.getByRole('link', { name: /try another way/i }));
  if (await tryOther.count() > 0) {
    await humanClickLocator(s.page, tryOther.first(), { timeoutMs: 10000 });
    await humanIdlePause('long');
    await shot('04b-other-options');
  } else {
    console.log('[slack] no "Try another way" button visible — Google likely demands the primary challenge');
  }
}

console.log(`[slack] post-sso url=${s.page.url()}`);

// --- Step 2: create app from manifest --------------------------------------
console.log('[slack] step 2: api.slack.com/apps?new_app=1');
await s.page.goto('https://api.slack.com/apps?new_app=1', { waitUntil: 'domcontentloaded' });
await humanIdlePause('deliberate');
await shot('05-new-app-dialog');

await humanClickLocator(s.page, s.page.getByText(/from a manifest/i).first(),
                        { timeoutMs: 10000 });
await humanIdlePause('deliberate');

// Workspace picker may auto-select if there's only one — count visible options.
const wisentLocator = s.page.getByText(/wisent/i).first();
if (await wisentLocator.count() > 0) {
  await humanClickLocator(s.page, wisentLocator, { timeoutMs: 10000 });
} else {
  console.log('[slack] workspace picker: no explicit wisent option visible; assuming auto-select');
}
await humanClickLocator(s.page, s.page.getByRole('button', { name: /^next$/i }).first(),
                        { timeoutMs: 10000 });
await humanIdlePause('deliberate');

// Paste manifest via OS pasteboard so we drive only humanized inputs.
spawnSync('/usr/bin/pbcopy', [], { input: MANIFEST_YAML });
const aceEditor = s.page.locator('.ace_editor, .ace_content, textarea').first();
await humanClickLocator(s.page, aceEditor, { timeoutMs: 10000 });
await humanIdlePause('short');
await s.page.keyboard.press('Meta+A');
await s.page.keyboard.press('Backspace');
await humanIdlePause('short');
await s.page.keyboard.press('Meta+V');
await humanIdlePause('deliberate');
await shot('06-manifest-pasted');

await humanClickLocator(s.page, s.page.getByRole('button', { name: /^next$/i }).first(),
                        { timeoutMs: 10000 });
await humanIdlePause('deliberate');
await humanClickLocator(s.page, s.page.getByRole('button', { name: /^create$/i }).first(),
                        { timeoutMs: 10000 });
await s.page.waitForLoadState('domcontentloaded');
await humanIdlePause('long');
await shot('07-app-created');

// --- Step 3: install + authorize -------------------------------------------
console.log('[slack] step 3: install + authorize');
await humanClickLocator(
  s.page, s.page.getByRole('button', { name: /install to workspace/i }).first(),
  { timeoutMs: 15000 }
);
await s.page.waitForLoadState('domcontentloaded');
await humanIdlePause('deliberate');
await humanClickLocator(
  s.page, s.page.getByRole('button', { name: /^allow$/i }).first(),
  { timeoutMs: 15000 }
);
await s.page.waitForLoadState('domcontentloaded');
await humanIdlePause('long');
await shot('08-authorized');

// --- Step 4: scrape xoxb from OAuth & Permissions --------------------------
console.log('[slack] step 4: read xoxb from OAuth & Permissions');
await humanClickLocator(
  s.page, s.page.locator('a[href*="/oauth"]').first(), { timeoutMs: 10000 }
);
await s.page.waitForLoadState('domcontentloaded');
await humanIdlePause('deliberate');
await shot('09-oauth-page');

const tokenStr = await s.page.evaluate(() => {
  const txt = document.body.innerText || '';
  const m = txt.match(/xoxb-\d+-\d+-[A-Za-z0-9]+/);
  return m ? m[0] : '';
});
if (!tokenStr) {
  console.error('[slack] FAILED to extract xoxb token; screenshots in .work/slack-post/');
  await safeShutdown();
  process.exit(3);
}
console.log(`[slack] captured token=${tokenStr.slice(0, 18)}… len=${tokenStr.length}`);

// --- Step 5: inject token + team_id into ~/.claude/settings.json -----------
console.log('[slack] step 5: write token into ~/.claude/settings.json');
const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
settings.mcpServers = settings.mcpServers || {};
settings.mcpServers.slack = settings.mcpServers.slack || {
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: {},
};
settings.mcpServers.slack.env.SLACK_BOT_TOKEN = tokenStr;

let teamId = '';
try {
  const auth = await fetchJSON('https://slack.com/api/auth.test', {
    method: 'POST', headers: { Authorization: `Bearer ${tokenStr}` },
  });
  if (auth.team_id) {
    teamId = auth.team_id;
    settings.mcpServers.slack.env.SLACK_TEAM_ID = teamId;
  } else {
    console.log(`[slack] auth.test returned no team_id (error=${auth.error || 'unknown'})`);
  }
} catch (e) {
  console.log(`[slack] auth.test failed: ${e.message?.slice(0, 80)}`);
}
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
console.log(`[slack] settings.json updated. team_id=${teamId || '(unresolved)'}`);

// --- Step 6: resolve channel + post via swt-cli ----------------------------
console.log('[slack] step 6: resolve channel + post');
let channelId = TARGET_CHAN;
if (!channelId) {
  let channels = [];
  try {
    const list = await fetchJSON(
      'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=1000',
      { headers: { Authorization: `Bearer ${tokenStr}` } }
    );
    channels = list.channels || [];
  } catch (e) {
    console.error(`[slack] conversations.list failed: ${e.message?.slice(0, 80)}`);
    await safeShutdown();
    process.exit(4);
  }
  const named = channels.find((c) => (c.name || '').toLowerCase() === TARGET_NAME);
  const general = channels.find((c) => (c.name || '').toLowerCase() === 'general');
  channelId = (named || general || {}).id || '';
}
if (!channelId) {
  console.error('[slack] could not resolve a channel id; aborting');
  await safeShutdown();
  process.exit(4);
}

const post = spawnSync(SWT_CLI, [
  'slack', 'post', '--channel', channelId, '--text-file', MESSAGE_FILE,
], { env: { ...process.env, SLACK_BOT_TOKEN: tokenStr }, stdio: 'inherit' });
if (post.status !== 0) {
  console.error('[slack] swt-cli slack post exited non-zero');
  await safeShutdown();
  process.exit(post.status || 5);
}
console.log(`[slack] ✓ posted to channel=${channelId}`);

await safeShutdown();
console.log('[slack] done');
