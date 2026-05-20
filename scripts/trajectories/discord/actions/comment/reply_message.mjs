// Discord reply-to-message trajectory. ORGANIC_COMMENT tier per
// lifecycle.ts. Replies to a SPECIFIC parent message (Discord's
// quoted-reply surface) — stronger engagement signal than a fresh
// top-level message (which is what organic_message.mjs does).
//
// Env vars:
//   SERVER_CHANNEL_PATH      — '<guild_id>/<channel_id>' for the channel.
//   TARGET_MESSAGE_SUBSTRING — text substring to find the parent message.
//   REPLY_TEXT               — body to reply with.
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/<guild>/<channel>.
//   3. Scroll the message list until a message containing
//      TARGET_MESSAGE_SUBSTRING is visible.
//   4. Hover the message, click Reply in the action toolbar.
//   5. Composer now shows "Replying to @user" pill. humanFill the reply
//      text into the composer, press Enter to submit.
//   6. Verify the reply appears with the @-mention pill.

import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator, humanScroll, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const CHANNEL = process.env.SERVER_CHANNEL_PATH;
const TARGET = process.env.TARGET_MESSAGE_SUBSTRING;
const REPLY = process.env.REPLY_TEXT;
if (!CHANNEL || !TARGET || !REPLY) {
  console.log('FAIL: SERVER_CHANNEL_PATH + TARGET_MESSAGE_SUBSTRING + REPLY_TEXT all required');
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_reply_message', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com', browser: 'chromium' });
console.log(`[reply] account=${acct.username} channel=${CHANNEL}`);

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto(`https://discord.com/channels/${CHANNEL}`);
  await humanIdlePause('deliberate');

  // Locate the target message by text substring within an [id^="chat-messages-"] li.
  const targetMsg = s.page.locator('li[id^="chat-messages-"]').filter({ hasText: TARGET }).first();
  // retry-allowed: scroll until target appears, bounded.
  let found = false;
  for (let i = 0; i < 20; i++) {
    if ((await targetMsg.count()) > 0) { found = true; break; }
    await humanScroll(s.page, -800, 2);
    await humanIdlePause('short');
  }
  if (!found) { console.log(`FAIL: no message with substring "${TARGET.slice(0, 30)}" found after scrolling`); process.exit(1); }
  console.log(`[reply] target message found`);

  // Hover to surface the action toolbar.
  await targetMsg.hover();
  await humanIdlePause('short');
  // Click the Reply button (Discord's action button uses aria-label="Reply").
  const replyBtn = s.page.locator('button[aria-label="Reply"]').first();
  if ((await replyBtn.count()) === 0) { console.log('FAIL: Reply button not on hovered message toolbar'); process.exit(1); }
  await humanClickLocator(s.page, replyBtn);
  await humanIdlePause('deliberate');

  // Composer now should show the "Replying to" pill. Fill the reply.
  const composer = s.page.locator('[role="textbox"][data-slate-editor], div[role="textbox"]').filter({ visible: true }).first();
  if ((await composer.count()) === 0) { console.log('FAIL: message composer not visible'); process.exit(1); }
  await humanClickLocator(s.page, composer);
  await humanIdlePause('short');
  await humanFill(s.page, composer, REPLY);
  await humanIdlePause('short');
  await s.page.keyboard.press('Enter'); // allow-raw-playwright: Enter-to-send is the canonical Discord submit gesture
  await humanIdlePause('deliberate');

  // Verify the reply appears with @-mention pill referencing parent.
  const replyVisible = s.page.locator('li[id^="chat-messages-"]').filter({ hasText: REPLY }).first();
  if ((await replyVisible.count()) === 0) { console.log('FAIL: reply message not visible in channel after submit'); process.exit(1); }
  console.log(`PASS: ${acct.username} replied in ${CHANNEL}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
