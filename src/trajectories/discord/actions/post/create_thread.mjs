// Discord create-thread trajectory. ORIGINAL_POST tier per lifecycle.ts.
// Creates a new thread off an existing parent message in a regular text
// channel (NOT a forum channel — forum posts live in create_forum_post).
//
// Env vars:
//   SERVER_CHANNEL_PATH      — '<guild_id>/<channel_id>'.
//   TARGET_MESSAGE_SUBSTRING — substring to find the parent message.
//   THREAD_NAME              — required, the new thread's title.
//   THREAD_FIRST_MESSAGE     — optional, posted as the thread's first msg.
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/<guild>/<channel>.
//   3. Find target message via TARGET_MESSAGE_SUBSTRING; hover.
//   4. Click the "# Create Thread" button in the action toolbar.
//   5. Fill THREAD_NAME in the thread-create modal.
//   6. If THREAD_FIRST_MESSAGE set, fill it in the modal's composer.
//   7. Click Create. Verify thread sidebar appears.

import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator, humanScroll, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const CHANNEL = process.env.SERVER_CHANNEL_PATH;
const TARGET = process.env.TARGET_MESSAGE_SUBSTRING;
const NAME = process.env.THREAD_NAME;
const FIRST = process.env.THREAD_FIRST_MESSAGE;
if (!CHANNEL || !TARGET || !NAME) {
  console.log('FAIL: SERVER_CHANNEL_PATH + TARGET_MESSAGE_SUBSTRING + THREAD_NAME all required');
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_create_thread', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[create_thread] account=${acct.username} channel=${CHANNEL} name=${NAME}`);

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto(`https://discord.com/channels/${CHANNEL}`);
  await humanIdlePause('deliberate');

  const targetMsg = s.page.locator('li[id^="chat-messages-"]').filter({ hasText: TARGET }).first();
  // retry-allowed: scroll bounded by 20 iters
  let found = false;
  for (let i = 0; i < 20; i++) {
    if ((await targetMsg.count()) > 0) { found = true; break; }
    await humanScroll(s.page, -800, 2);
    await humanIdlePause('short');
  }
  if (!found) { console.log('FAIL: target message not visible'); process.exit(1); }

  await targetMsg.hover();
  await humanIdlePause('short');
  // The Create Thread button uses aria-label="Create Thread"
  const threadBtn = s.page.locator('button[aria-label="Create Thread"]').first();
  if ((await threadBtn.count()) === 0) { console.log('FAIL: Create Thread button not in action toolbar'); process.exit(1); }
  await humanClickLocator(s.page, threadBtn);
  await humanIdlePause('deliberate');

  // Modal: name input + optional first message composer + Create button.
  const nameInput = s.page.locator('input[placeholder*="thread name"], input[placeholder*="Thread Name"], input[maxlength="100"]').first();
  if ((await nameInput.count()) === 0) { console.log('FAIL: thread-name input not visible'); process.exit(1); }
  await humanFill(s.page, nameInput, NAME);
  await humanIdlePause('short');

  if (FIRST) {
    const firstMsg = s.page.locator('[role="textbox"][data-slate-editor], div[role="textbox"]').filter({ visible: true }).first();
    if ((await firstMsg.count()) > 0) {
      await humanFill(s.page, firstMsg, FIRST);
      await humanIdlePause('short');
    }
  }

  const createBtn = s.page.locator('button').filter({ hasText: /^Create$/ }).first();
  if ((await createBtn.count()) === 0) { console.log('FAIL: Create button not visible on modal'); process.exit(1); }
  await humanClickLocator(s.page, createBtn);
  await humanIdlePause('deliberate');

  // After create, URL should change to include /threads/<id>. Some clients
  // open a sidebar; others navigate. Detect either.
  const newUrl = s.page.url();
  const inThreadUrl = /\/channels\/\d+\/\d+\/\d+/.test(newUrl);
  const sidebarOpen = (await s.page.locator(`text=${NAME.slice(0, 24)}`).count()) > 0;
  if (!inThreadUrl && !sidebarOpen) { console.log(`FAIL: thread did not appear (url=${newUrl})`); process.exit(1); }
  console.log(`PASS: ${acct.username} created thread "${NAME}" in ${CHANNEL}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
