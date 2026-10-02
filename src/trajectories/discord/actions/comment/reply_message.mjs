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
//   6. Observe the provider's message response and verify its parent reference.

import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';
import { pageSettled, responseAfterAction } from '../../../_shared/page/settled.mjs';
import { checkReachable } from '../../../_shared/action-runner.mjs';
import { findDiscordMessage } from '../../../_shared/discord/message-target.mjs';
import { readDiscordReply } from '../../../_shared/discord/response.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const CHANNEL = process.env.SERVER_CHANNEL_PATH;
const TARGET = process.env.TARGET_MESSAGE_SUBSTRING;
const REPLY = process.env.REPLY_TEXT;
if (!CHANNEL || !TARGET || !REPLY) {
  console.log('FAIL: SERVER_CHANNEL_PATH + TARGET_MESSAGE_SUBSTRING + REPLY_TEXT all required');
  process.exit(1);
}
const channel = /^(\d+)\/(\d+)$/.exec(CHANNEL);
if (!channel) {
  console.error(`DISCORD_REPLY_CHANNEL_INVALID: SERVER_CHANNEL_PATH must be guild_id/channel_id; observed ${JSON.stringify(CHANNEL)}`);
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_reply_message', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[reply] account=${acct.username} channel=${CHANNEL}`);

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto(`https://discord.com/channels/${CHANNEL}`);
  await pageSettled(s.page);
  checkReachable(s, 'discord');

  const { target: targetMsg, messageId: parentMessageId } = await findDiscordMessage(s.page, CHANNEL, channel[2], TARGET, 'DISCORD_REPLY');
  console.log(`[reply] target message found`);

  // Hover to surface the action toolbar.
  await targetMsg.hover();
  // Click the Reply button (Discord's action button uses aria-label="Reply").
  const replyBtn = s.page.locator('button[aria-label="Reply"]').first();
  await replyBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, replyBtn);

  // Composer now should show the "Replying to" pill. Fill the reply.
  const composer = s.page.locator('[role="textbox"][data-slate-editor], div[role="textbox"]').filter({ visible: true }).first();
  await composer.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, composer);
  await humanFill(s.page, composer, REPLY);
  const messagePath = new RegExp(`^/api/v\\d+/channels/${channel[2]}/messages$`);
  const response = await responseAfterAction(s.page, (request) => {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.origin === 'https://discord.com' && messagePath.test(url.pathname);
  }, () => s.page.keyboard.press('Enter'));
  const message = await readDiscordReply(response, 'reply_message', 'DISCORD_REPLY');
  if (typeof message?.id !== 'string' || !/^\d+$/.test(message.id)
      || message.channel_id !== channel[2] || message.content !== REPLY || message.type !== 19
      || message.message_reference?.message_id !== parentMessageId) {
    throw Object.assign(new Error('DISCORD_REPLY_UNCONFIRMED: reconcile the provider response before another attempt'),
      { operation: 'reply_message', parentMessageId, responseBody: message, requestUrl: response.url(), httpStatus: response.status() });
  }
  console.log(JSON.stringify({
    ok: true, operation: 'reply_message', acknowledgement: 'provider_response',
    guild_id: channel[1], channel_id: message.channel_id, message_id: message.id, reply_to: parentMessageId,
    url: `https://discord.com/channels/${channel[1]}/${message.channel_id}/${message.id}`,
  }));
} catch (e) {
  console.error('DISCORD_REPLY_FAILED:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
