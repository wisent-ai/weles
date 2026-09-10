// Slack-post trajectory. TWO paths:
//   TOKEN (default): post directly via chat.postMessage with a stored bot token
//     (the Oko app already exists — Member ID U0B5SU2CULS, team Wisent).
//     No browser, no Google SSO, no app re-creation. This is what runs on the
//     mac-mini worker.
//   BROWSER (no token): Google-SSO into wisent-workspace.slack.com, create the
//     app via manifest, scrape a fresh xoxb, post. Only used when no bot token
//     is configured.
// Token source: SLACK_BOT_TOKEN env, else ~/.oko/bot-token, else ~/.oko/slack.json.
// IMPORTANT: do NOT re-create the app when a token exists — that spawns a
// duplicate (logo-less) "Oko" and posts from the wrong identity.
// Env: SLACK_BOT_TOKEN, MESSAGE_TEXT | MESSAGE_FILE,
//      SLACK_TARGET_CHANNEL (id) | SLACK_TARGET_CHANNEL_NAME | SLACK_TARGET_USER_ID,
//      SLACK_TARGET_USER_MATCHERS (csv, default jakub,kuba,towarek),
//      SLACK_ENABLE_TAGGING=0 | SLACK_MENTION_USER_IDS | SLACK_MENTION_USER_MATCHERS,
//      SLACK_EMAIL/SLACK_PASS (browser path only).

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slackPost, storedBotToken, workspaceApi } from './post_message/api.mjs';
import { applyMentions, listMembers, mentionIdsForTarget, parseCsv, resolveTargets, resolveUsersFromMembers } from './post_message/recipients.mjs';
import { readClientToken, signInThroughGoogle } from './post_message/browser_signin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..', '..');
const TARGET_NAME = (process.env.SLACK_TARGET_CHANNEL_NAME || 'jakub').toLowerCase();
const TARGET_CHAN = process.env.SLACK_TARGET_CHANNEL || '';

// Message source: inline MESSAGE_TEXT (machine-independent — survives being
// enqueued on one host and run on another) takes precedence over MESSAGE_FILE
// (a path, only valid on the enqueuing machine's filesystem).
const INLINE_MESSAGE = process.env.MESSAGE_TEXT || '';
const MESSAGE_FILE = process.env.MESSAGE_FILE || '';
if (!INLINE_MESSAGE && !(MESSAGE_FILE && existsSync(MESSAGE_FILE))) {
  console.error(`no MESSAGE_TEXT and no readable MESSAGE_FILE: ${MESSAGE_FILE || '(unset)'}`);
  process.exit(2);
}
const MESSAGE_BODY = INLINE_MESSAGE || readFileSync(MESSAGE_FILE, 'utf8');

// ---- TOKEN PATH: stored bot token -> chat.postMessage (no browser) ----------
const BOT_TOKEN = storedBotToken();
if (BOT_TOKEN) {
  const who = await slackPost('auth.test', {}, BOT_TOKEN);
  console.log(`[slack] token path: bot=${who.user} user_id=${who.user_id} team=${who.team}`);
  const targets = await resolveTargets(BOT_TOKEN);
  let memberCache = false;
  const loadMembers = async () => {
    if (!memberCache) memberCache = await listMembers(BOT_TOKEN);
    return memberCache;
  };
  const plans = [];
  for (const target of targets) {
    const mentionIds = await mentionIdsForTarget(target, loadMembers);
    plans.push({ target, mentionIds, text: applyMentions(MESSAGE_BODY, mentionIds) });
  }
  let posted = 0;
  for (const plan of plans) {
    try {
      const post = await slackPost('chat.postMessage', { channel: plan.target, text: plan.text, mrkdwn: true }, BOT_TOKEN);
      console.log(`[slack] ✓ posted to ${plan.target} ts=${post.ts}`);
      posted++;
    } catch (e) { console.error(`[slack] post to ${plan.target} failed: ${e.message}`); }
  }
  if (!posted) { console.error('[slack] all posts failed'); process.exit(5); }
  console.log(`[slack] ✓ delivered to ${posted}/${targets.length} recipient(s)`);
  process.exit(0);
}
console.log('[slack] no stored bot token — signing in through the browser and creating the app');

// ---- BROWSER PATH -----------------------------------------------------------
const { WSession } = await import(`${WELES}/dist/session/wsession.js`);
const { humanFill } = await import(`${WELES}/dist/human/keyboard.js`);
const { humanClickLocator, humanIdlePause } = await import(`${WELES}/dist/human/mouse.js`);
const { runRecordingsDir } = await import(`${WELES}/dist/session/run-recordings.js`);
const atoms = { humanFill, humanClickLocator, humanIdlePause };

const headless = process.env.HEADLESS === '1';
const s = await WSession.start({ label: 'slack-post', headless });
console.log('[slack] WSession started');

const SHOT_DIR = runRecordingsDir('slack_post');
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

async function fail(code, message) {
  console.error(message);
  await safeShutdown();
  process.exit(code);
}

const SLACK_EMAIL = process.env.SLACK_EMAIL || '';
const SLACK_PASS = process.env.SLACK_PASS || '';
if (!SLACK_EMAIL || !SLACK_PASS) await fail(2, 'SLACK_EMAIL / SLACK_PASS env required');

await signInThroughGoogle(s, { email: SLACK_EMAIL, password: SLACK_PASS, shot, atoms });

// --- Step 2: extract xoxc- + create the Swiatowid bot app + post as bot ---
// The user wants messages from a "Swiatowid" bot, not from their account.
// First extract xoxc- (for users.list before posting). Then navigate to
// api.slack.com/apps → create app via manifest → install + Authorize →
// scrape xoxb-, post as the bot. api.slack.com auth is per-workspace; we
// go via wisent-workspace.slack.com/apps/manage to trigger the handoff.
const xoxc = await readClientToken(s, atoms);
if (!xoxc) await fail(6, `[slack] no xoxc- in boot_data or localStorage; screenshots in ${SHOT_DIR}`);
console.log(`[slack] xoxc=${xoxc.slice(0, 24)}… len=${xoxc.length}`);

console.log('[slack] step 2b: api.slack.com app creation');
const { createBotApp } = await import('./steps/create_bot_app.mjs');
const xoxb = await createBotApp({ page: s.page, weles: WELES, shot });
if (!xoxb) await fail(7, '[slack] bot created but no xoxb on OAuth page — failing rather than posting as user');
console.log(`[slack] ✓ xoxb=${xoxb.slice(0, 18)}… len=${xoxb.length}`);

// --- Step 3: resolve channel + post via Slack API using browser cookies ----
const slackApi = workspaceApi(s.page.context().request);
const workspaceMembers = async () => {
  const ul = await slackApi('users.list', { token: xoxc, limit: '1000' });
  return (ul.members || []).filter((u) => !u.deleted && !u.is_bot);
};

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
// Still no channel: open a DM with the first user the matchers name.
if (!channelId) {
  const matchers = parseCsv((process.env.SLACK_TARGET_USER_MATCHERS || 'jakub,kuba,towarek').toLowerCase());
  console.log(`[slack] users.list to find ${matchers.join('/')}`);
  const members = await workspaceMembers();
  const hit = resolveUsersFromMembers(members, [matchers])[0];
  if (!hit) await fail(4, `[slack] no user matched ${matchers.join('/')} in ${members.length} workspace members`);
  console.log(`[slack] opening DM with user ${hit.id} (${hit.real_name || hit.name})`);
  const dm = await slackApi('conversations.open', { token: xoxc, users: hit.id });
  channelId = dm.channel.id;
}
if (!channelId) await fail(4, '[slack] no channel id');

const mentionIds = await mentionIdsForTarget(channelId, workspaceMembers);
const finalMessageText = applyMentions(MESSAGE_BODY, mentionIds);
const post = await slackApi('chat.postMessage', { token: xoxb, channel: channelId, text: finalMessageText, mrkdwn: true });
console.log(`[slack] ✓ posted as Swiatowid bot ts=${post.ts} channel=${channelId}`);

await safeShutdown();
console.log('[slack] done');
