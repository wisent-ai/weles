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
//   7. Click Create. Observe its provider reply and the requested first-message reply.

import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator, humanScroll } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';
import { pageSettled, responseAfterAction } from '../../../_shared/page/settled.mjs';
import { checkReachable } from '../../../_shared/action-runner.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const CHANNEL = process.env.SERVER_CHANNEL_PATH;
const TARGET = process.env.TARGET_MESSAGE_SUBSTRING;
const NAME = process.env.THREAD_NAME;
const FIRST = process.env.THREAD_FIRST_MESSAGE;
if (!CHANNEL || !TARGET || !NAME) {
  console.log('FAIL: SERVER_CHANNEL_PATH + TARGET_MESSAGE_SUBSTRING + THREAD_NAME all required');
  process.exit(1);
}
const channel = /^(\d+)\/(\d+)$/.exec(CHANNEL);
if (!channel) {
  console.error(`DISCORD_THREAD_CHANNEL_INVALID: SERVER_CHANNEL_PATH must be guild_id/channel_id; observed ${JSON.stringify(CHANNEL)}`);
  process.exit(1);
}

async function readThreadReply(response, operation) {
  const details = { operation, requestUrl: response.url(), httpStatus: response.status() };
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw Object.assign(new Error('DISCORD_THREAD_RESPONSE_READ_FAILED', { cause }), details);
  }
  if (!response.ok()) throw Object.assign(new Error(`DISCORD_THREAD_HTTP_REFUSED: HTTP ${response.status()}: ${text}`), details);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw Object.assign(new Error('DISCORD_THREAD_RESPONSE_INVALID', { cause }), details, { responseBody: text });
  }
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
let createdThread;

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto(`https://discord.com/channels/${CHANNEL}`);
  await pageSettled(s.page);
  checkReachable(s, 'discord');

  const targetMsg = s.page.locator('li[id^="chat-messages-"]').filter({ hasText: TARGET }).first();
  // Scroll through rendered history. An unchanged window does not establish
  // that no older messages exist; preserve that uncertainty in the refusal.
  const oldestMessageId = () => s.page.locator('li[id^="chat-messages-"]').first().getAttribute('id');
  while ((await targetMsg.count()) === 0) {
    const before = await oldestMessageId();
    await humanScroll(s.page, -800, 2);
    await pageSettled(s.page);
    const after = await oldestMessageId();
    if (after === before) throw Object.assign(new Error('DISCORD_THREAD_HISTORY_PROGRESS_UNCONFIRMED: the rendered history did not advance; earlier-message availability is unknown'),
      { channel: CHANNEL, oldestMessageBefore: before, oldestMessageAfter: after, pageUrl: s.page.url() });
  }
  const targetElementId = await targetMsg.getAttribute('id');
  const targetId = /^chat-messages-(\d+)-(\d+)$/.exec(targetElementId || '');
  if (!targetId || targetId[1] !== channel[2]) throw Object.assign(new Error('DISCORD_THREAD_PARENT_UNCONFIRMED'),
    { channel: CHANNEL, targetElementId, pageUrl: s.page.url() });
  const createPath = new RegExp(`^/api/v\\d+/channels/${channel[2]}/messages/${targetId[2]}/threads$`);
  const messagePath = new RegExp(`^/api/v\\d+/channels/${targetId[2]}/messages$`);

  await targetMsg.hover();
  // The Create Thread button uses aria-label="Create Thread"
  const threadBtn = s.page.locator('button[aria-label="Create Thread"]').filter({ visible: true }).first();
  await threadBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, threadBtn);

  // Modal: name input + optional first message composer + Create button.
  const nameInput = s.page.locator('input[placeholder*="thread name"], input[placeholder*="Thread Name"], input[maxlength="100"]').filter({ visible: true }).first();
  await nameInput.waitFor({ state: 'visible' });
  await humanFill(s.page, nameInput, NAME);
  await s.page.keyboard.press('Tab');
  const enteredName = await nameInput.inputValue();
  if (enteredName !== NAME) throw Object.assign(new Error('DISCORD_THREAD_NAME_MISMATCH'),
    { expectedLength: NAME.length, observedLength: enteredName.length, pageUrl: s.page.url() });

  if (FIRST) {
    const firstMsg = s.page.locator('[role="textbox"][data-slate-editor], div[role="textbox"]').filter({ visible: true }).first();
    await firstMsg.waitFor({ state: 'visible' });
    await humanFill(s.page, firstMsg, FIRST);
  }

  const createBtn = s.page.locator('button').filter({ hasText: /^Create$/ }).filter({ visible: true }).first();
  await createBtn.waitFor({ state: 'visible' });
  const create = async () => {
    const response = await responseAfterAction(s.page, (request) => {
      const url = new URL(request.url());
      return request.method() === 'POST' && url.origin === 'https://discord.com' && createPath.test(url.pathname);
    }, () => humanClickLocator(s.page, createBtn));
    const thread = await readThreadReply(response, 'create_thread');
    if (thread?.id !== targetId[2] || thread.parent_id !== channel[2] || thread.name !== NAME
        || (thread.type !== 10 && thread.type !== 11)) {
      throw Object.assign(new Error('DISCORD_THREAD_CREATE_UNCONFIRMED: reconcile the provider response before another attempt'),
        { operation: 'create_thread', responseBody: thread, requestUrl: response.url(), httpStatus: response.status() });
    }
    createdThread = thread;
  };
  let firstMessage;
  if (FIRST) {
    const response = await responseAfterAction(s.page, (request) => {
      const url = new URL(request.url());
      return request.method() === 'POST' && url.origin === 'https://discord.com' && messagePath.test(url.pathname);
    }, create);
    firstMessage = await readThreadReply(response, 'thread_first_message');
    if (typeof firstMessage?.id !== 'string' || !/^\d+$/.test(firstMessage.id)
        || firstMessage.channel_id !== createdThread.id || firstMessage.content !== FIRST) {
      throw Object.assign(new Error('DISCORD_THREAD_FIRST_MESSAGE_UNCONFIRMED: the thread was acknowledged, but the requested first message was not confirmed'),
        { operation: 'thread_first_message', threadId: createdThread.id, responseBody: firstMessage });
    }
  } else {
    await create();
  }
  console.log(JSON.stringify({
    ok: true, operation: 'create_thread', acknowledgement: 'provider_response',
    guild_id: channel[1], parent_id: createdThread.parent_id, thread_id: createdThread.id,
    first_message_requested: Boolean(FIRST), first_message_id: firstMessage?.id ?? null,
    url: `https://discord.com/channels/${channel[1]}/${createdThread.id}`,
  }));
} catch (e) {
  console.error('DISCORD_THREAD_FAILED:', e, { acknowledgedThreadId: createdThread?.id ?? null });
  process.exitCode = 1;
} finally {
  await s.close();
}
