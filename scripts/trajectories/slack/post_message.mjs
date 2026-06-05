// Slack-post trajectory. TWO paths:
//   FAST (default): post directly via chat.postMessage with a stored bot token
//     (the Swiatowid app already exists — Member ID U0B5SU2CULS, team Wisent).
//     No browser, no Google SSO, no app re-creation. This is what runs on the
//     mac-mini worker.
//   FALLBACK (no token): the original browser flow — Google-SSO into
//     wisent-workspace.slack.com, create the app via manifest, scrape a fresh
//     xoxb, post. Only used when no bot token is configured.
// Token source: SLACK_BOT_TOKEN env, else first line of ~/.swiatowid/bot-token.
// IMPORTANT: do NOT re-create the app when a token exists — that spawns a
// duplicate (logo-less) "Swiatowid" and posts from the wrong identity.
// Env: SLACK_BOT_TOKEN, MESSAGE_TEXT | MESSAGE_FILE,
//      SLACK_TARGET_CHANNEL (id) | SLACK_TARGET_CHANNEL_NAME | SLACK_TARGET_USER_ID,
//      SLACK_TARGET_USER_MATCHERS (csv, default jakub,kuba,towarek),
//      SLACK_EMAIL/SLACK_PASS (fallback browser flow only).

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..', '..');
const SWIATOWID = join(WELES, '..', 'swiatowid');
const MESSAGE_FILE = process.env.MESSAGE_FILE
  || join(SWIATOWID, '.work', 'jakub-status.txt');
const TARGET_NAME = (process.env.SLACK_TARGET_CHANNEL_NAME || 'jakub').toLowerCase();
const TARGET_CHAN = process.env.SLACK_TARGET_CHANNEL || '';

// Message source: inline MESSAGE_TEXT (machine-independent — survives being
// enqueued on one host and run on another) takes precedence over MESSAGE_FILE
// (a path, only valid on the enqueuing machine's filesystem).
const INLINE_MESSAGE = process.env.MESSAGE_TEXT || '';
if (!INLINE_MESSAGE && !existsSync(MESSAGE_FILE)) {
  console.error(`no MESSAGE_TEXT and MESSAGE_FILE not found: ${MESSAGE_FILE}`);
  process.exit(2);
}
const MESSAGE_BODY = INLINE_MESSAGE || readFileSync(MESSAGE_FILE, 'utf8');

// ---- FAST PATH: stored bot token -> chat.postMessage (no browser) -----------
function storedBotToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN.trim();
  const f = join(homedir(), '.swiatowid', 'bot-token');
  try { const t = readFileSync(f, 'utf8').split('\n')[0].trim(); if (t.startsWith('xoxb-')) return t; } catch {}
  return '';
}
async function slackPost(method, form, token) {
  const body = Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}${j.needed ? ` (needed ${j.needed})` : ''}`);
  return j;
}
// Default recipients: one user per matcher-group. We DM BOTH Jakub and Łukasz.
// chat.postMessage to a user id opens/uses the DM, so no im:write needed.
const RECIPIENT_GROUPS = [
  ['jakub', 'towarek', 'kuba'],
  ['lukasz', 'bartoszcze', 'łukasz'],
];
async function resolveTargets(token) {
  if (TARGET_CHAN) return [TARGET_CHAN];                                 // explicit channel id wins
  if (process.env.SLACK_TARGET_USER_IDS)                                 // explicit csv of DM targets
    return process.env.SLACK_TARGET_USER_IDS.split(',').map((x) => x.trim()).filter(Boolean);
  if (process.env.SLACK_TARGET_USER_ID) return [process.env.SLACK_TARGET_USER_ID];
  // a real channel by name only if it actually resolves (the default 'jakub'
  // is a DM, not a channel, so this falls through to the recipient groups).
  if (process.env.SLACK_TARGET_CHANNEL_NAME) {
    try {
      const list = await slackPost('conversations.list', { types: 'public_channel,private_channel', limit: '1000' }, token);
      const c = (list.channels || []).find((x) => (x.name || '').toLowerCase() === TARGET_NAME);
      if (c) return [c.id];
    } catch (e) { console.log(`[slack] conversations.list skipped: ${e.message}`); }
  }
  // DM one user per recipient group, resolved by name/email matcher.
  const groups = process.env.SLACK_TARGET_USER_MATCHERS
    ? [process.env.SLACK_TARGET_USER_MATCHERS.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean)]
    : RECIPIENT_GROUPS;
  const ul = await slackPost('users.list', { limit: '1000' }, token);
  const members = (ul.members || []).filter((u) => !u.deleted && !u.is_bot);
  const ids = [];
  for (const group of groups) {
    const hit = members.find((u) => {
      const fields = [u.name, u.real_name, u.profile && u.profile.email, u.profile && u.profile.display_name]
        .filter(Boolean).map((x) => String(x).toLowerCase());
      return group.some((m) => fields.some((f) => f.includes(m)));
    });
    if (hit && !ids.includes(hit.id)) { ids.push(hit.id); console.log(`[slack] recipient ${hit.real_name || hit.name} -> ${hit.id}`); }
    else if (!hit) console.log(`[slack] WARN no user matched ${group.join('/')}`);
  }
  if (!ids.length) throw new Error(`no channel "${TARGET_NAME}" and no recipients matched`);
  return ids;
}
const BOT_TOKEN = storedBotToken();
if (BOT_TOKEN) {
  const who = await slackPost('auth.test', {}, BOT_TOKEN);
  console.log(`[slack] fast path: bot=${who.user} user_id=${who.user_id} team=${who.team}`);
  const targets = await resolveTargets(BOT_TOKEN);
  let posted = 0;
  for (const target of targets) {
    try {
      const post = await slackPost('chat.postMessage', { channel: target, text: MESSAGE_BODY }, BOT_TOKEN);
      console.log(`[slack] ✓ posted to ${target} ts=${post.ts}`);
      posted++;
    } catch (e) { console.error(`[slack] post to ${target} failed: ${e.message}`); }
  }
  if (!posted) { console.error('[slack] all posts failed'); process.exit(5); }
  console.log(`[slack] ✓ delivered to ${posted}/${targets.length} recipient(s)`);
  process.exit(0);
}
console.log('[slack] no stored bot token — falling back to browser SSO + app creation');

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

// --- Step 1: Google SSO with workspace-member @wisent.ai credentials -------
// User provided lukasz.bartoszcze@wisent.ai + the @wisent.ai Google
// Workspace password. Wisent Slack admits members by Google SSO, so this
// path lands the user as a workspace member (the prior gmail attempt
// failed at membership; this one shouldn't).
const SLACK_EMAIL = process.env.SLACK_EMAIL || '';
const SLACK_PASS = process.env.SLACK_PASS || '';
if (!SLACK_EMAIL || !SLACK_PASS) {
  console.error('SLACK_EMAIL / SLACK_PASS env required');
  await safeShutdown(); process.exit(2);
}

console.log(`[slack] step 1: Google SSO as ${SLACK_EMAIL}`);
await s.page.goto('https://wisent-workspace.slack.com', { waitUntil: 'domcontentloaded' });
await humanIdlePause('deliberate');
await shot('01-slack-landing');

const googleBtn = s.page.getByRole('button', { name: /^\s*google\s*$/i })
  .or(s.page.getByRole('link', { name: /^\s*google\s*$/i }));
await humanClickLocator(s.page, googleBtn.first(), { timeoutMs: 15000 });
await humanIdlePause('long');
await shot('02-google-email');

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
  console.log('[slack] passkey challenge — Try another way → Enter your password');
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

// Google's OAuth consent screen "Continue" button completes the handshake.
const continueBtn = s.page.getByRole('button', { name: /^\s*continue\s*$/i });
if (await continueBtn.count() > 0) {
  console.log('[slack] consent — clicking Continue');
  await humanClickLocator(s.page, continueBtn.first(), { timeoutMs: 10000 });
  await humanIdlePause('long');
  await shot('04d-after-consent');
}
console.log(`[slack] post-signin url=${s.page.url()}`);

// --- Step 2: extract xoxc- + create the Swiatowid bot app + post as bot ---
// The user wants messages from a "Swiatowid" bot, not from their account.
// First extract xoxc- (for users.list before posting). Then navigate to
// api.slack.com/apps → create app via manifest → install + Authorize →
// scrape xoxb-, post as the bot. api.slack.com auth is per-workspace; we
// go via wisent-workspace.slack.com/apps/manage to trigger the handoff.
console.log('[slack] step 2: load Slack web client + extract xoxc-');
await s.page.goto('https://wisent-workspace.slack.com/messages', { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const xoxc = await s.page.evaluate(() => {
  function findInLS() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      if (typeof v !== 'string') continue;
      const m = v.match(/xoxc-[\d]+-[\d]+-[\d]+-[a-f0-9]+/);
      if (m) return m[0];
    }
    return null;
  }
  const bd = (typeof window !== 'undefined') ? window.boot_data : null;
  if (bd && bd.api_token) return bd.api_token;
  return findInLS();
});
if (!xoxc) {
  console.error('[slack] no xoxc- in boot_data or localStorage; screenshots in .work/slack-post/');
  await safeShutdown(); process.exit(6);
}
console.log(`[slack] xoxc=${xoxc.slice(0, 24)}… len=${xoxc.length}`);

// --- Step 2b: create the Swiatowid bot app, scrape xoxb- -------------------
console.log('[slack] step 2b: api.slack.com app creation');
const { createBotApp } = await import('./steps/create_bot_app.mjs');
const xoxb = await createBotApp({ page: s.page, weles: WELES, shot });
if (!xoxb) {
  console.error('[slack] bot created but no xoxb on OAuth page — failing rather than posting as user');
  await safeShutdown(); process.exit(7);
}
console.log(`[slack] ✓ xoxb=${xoxb.slice(0, 18)}… len=${xoxb.length}`);

// --- Step 3: resolve channel + post via Slack API using browser cookies ----
const ctxReq = s.page.context().request;
async function slackApi(method, form) {
  const body = Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await ctxReq.post(`https://wisent-workspace.slack.com/api/${method}?_x_id=${Date.now()}`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error || JSON.stringify(j).slice(0, 80)}`);
  return j;
}

let channelId = TARGET_CHAN;
if (!channelId) {
  const list = await slackApi('conversations.list', {
    token: xoxc, types: 'public_channel,private_channel', limit: '1000',
  });
  const named = list.channels.find((c) => c.name && c.name.toLowerCase() === TARGET_NAME);
  const general = list.channels.find((c) => c.name && c.name.toLowerCase() === 'general');
  if (named) channelId = named.id;
  else if (general) channelId = general.id;
  else {
    console.log(`[slack] ${list.channels.length} channels visible, none match "${TARGET_NAME}" or "general"`);
    console.log(`[slack] sample: ${list.channels.slice(0, 6).map((c) => c.name).join(', ')}`);
  }
}
// If still no channel, open a DM with Jakub by name (xoxc can list users).
if (!channelId) {
  const matchers = (process.env.SLACK_TARGET_USER_MATCHERS || 'jakub,kuba,towarek')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`[slack] users.list to find ${matchers.join('/')}`);
  const ul = await slackApi('users.list', { token: xoxc, limit: '1000' });
  const hit = (ul.members || []).find((u) => {
    if (u.deleted || u.is_bot) return false;
    const fields = [u.name, u.real_name, u.profile && u.profile.email,
                    u.profile && u.profile.display_name].filter(Boolean).map((x) => x.toLowerCase());
    return matchers.some((m) => fields.some((f) => f.includes(m)));
  });
  if (!hit) {
    console.error(`[slack] no user matched ${matchers.join('/')} in ${ul.members?.length || 0} workspace members`);
    await safeShutdown(); process.exit(4);
  }
  console.log(`[slack] opening DM with user ${hit.id} (${hit.real_name || hit.name})`);
  const dm = await slackApi('conversations.open', { token: xoxc, users: hit.id });
  channelId = dm.channel.id;
}
if (!channelId) { console.error('[slack] no channel id'); await safeShutdown(); process.exit(4); }

const messageText = INLINE_MESSAGE || readFileSync(MESSAGE_FILE, 'utf8');
const post = await slackApi('chat.postMessage', { token: xoxb, channel: channelId, text: messageText });
console.log(`[slack] ✓ posted as Swiatowid bot ts=${post.ts} channel=${channelId}`);

await safeShutdown();
console.log('[slack] done');
