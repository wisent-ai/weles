// Discord create-forum-post trajectory. ORIGINAL_POST tier per
// lifecycle.ts. Forum channels are Discord's per-thread-is-a-post surface
// (every post is a top-level thread within the forum). Distinct from
// create_thread.mjs which threads off an existing message in a regular
// channel.
//
// Env vars:
//   FORUM_CHANNEL_PATH — '<guild_id>/<forum_channel_id>'.
//   POST_TITLE         — required.
//   POST_BODY          — required, the post content.
//   POST_TAGS          — optional, comma-separated tag names.
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/<guild>/<forum-channel>.
//   3. Click the "New Post" button (top-right in the forum view).
//   4. humanFill POST_TITLE in the title input.
//   5. For each POST_TAGS entry, click the corresponding tag chip.
//   6. humanFill POST_BODY in the body composer.
//   7. Click Post.

import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import {
  getSocialAccount,
  resolveAccountSession,
} from '../../../../../dist/utils/credentials.js';
import {
  pageSettled,
  responseAfterAction,
} from '../../../_shared/page/settled.mjs';
import { checkReachable } from '../../../_shared/action-runner.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const CHANNEL = process.env.FORUM_CHANNEL_PATH;
const TITLE = process.env.POST_TITLE;
const BODY = process.env.POST_BODY;
const TAGS = process.env.POST_TAGS
  ? process.env.POST_TAGS.split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  : [];
if (!CHANNEL || !TITLE || !BODY) {
  console.log('FAIL: FORUM_CHANNEL_PATH + POST_TITLE + POST_BODY all required');
  process.exit(1);
}
const channel = /^(\d+)\/(\d+)$/.exec(CHANNEL);
if (!channel) {
  console.error(
    `DISCORD_FORUM_CHANNEL_INVALID: FORUM_CHANNEL_PATH must be guild_id/forum_channel_id; observed ${JSON.stringify(CHANNEL)}`,
  );
  process.exit(1);
}
const createPath = new RegExp(`^/api/v\\d+/channels/${channel[2]}/threads$`);

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) {
  console.log('FAIL: no discord account');
  process.exit(1);
}
const token = acct.metadata?.discord_token;
if (!token) {
  console.log(`FAIL: ${acct.username} metadata.discord_token missing`);
  process.exit(1);
}

const opts = await resolveAccountSession(acct);
const s = await WSession.start({
  label: 'discord_create_forum_post',
  proxy: opts.proxyUrl,
  persona: opts.persona,
  targetHost: 'discord.com',
});
console.log(
  `[forum_post] account=${acct.username} channel=${CHANNEL} title=${TITLE}`,
);

try {
  await s.ctx.addInitScript(
    `(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`,
  );
  await s.goto(`https://discord.com/channels/${CHANNEL}`);
  await pageSettled(s.page);
  checkReachable(s, 'discord');

  // "New Post" button at top-right of the forum view.
  const newPostBtn = s.page
    .locator('button')
    .filter({ hasText: /^New Post$/ })
    .filter({ visible: true })
    .first();
  await newPostBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, newPostBtn);

  const titleInput = s.page
    .locator(
      'input[placeholder*="title"], input[placeholder*="Title"], input[maxlength="100"]',
    )
    .filter({ visible: true })
    .first();
  await titleInput.waitFor({ state: 'visible' });
  await humanFill(s.page, titleInput, TITLE);
  await s.page.keyboard.press('Tab');
  const enteredTitle = await titleInput.inputValue();
  if (enteredTitle !== TITLE)
    throw Object.assign(new Error('DISCORD_FORUM_TITLE_MISMATCH'), {
      expectedLength: TITLE.length,
      observedLength: enteredTitle.length,
      pageUrl: s.page.url(),
    });

  for (const tag of TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chip = s.page
      .locator('div, button')
      .filter({ hasText: new RegExp(`^${escaped}$`, 'i') })
      .filter({ visible: true })
      .first();
    await chip.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, chip);
    console.log(`[forum_post] clicked tag control ${tag}`);
  }

  const bodyComposer = s.page
    .locator('[role="textbox"][data-slate-editor], div[role="textbox"]')
    .filter({ visible: true })
    .first();
  await bodyComposer.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, bodyComposer);
  await humanFill(s.page, bodyComposer, BODY);

  const postBtn = s.page
    .locator('button')
    .filter({ hasText: /^Post$/ })
    .filter({ visible: true })
    .first();
  await postBtn.waitFor({ state: 'visible' });
  const response = await responseAfterAction(
    s.page,
    (request) => {
      const url = new URL(request.url());
      return (
        request.method() === 'POST' &&
        url.origin === 'https://discord.com' &&
        createPath.test(url.pathname)
      );
    },
    () => humanClickLocator(s.page, postBtn),
  );
  const details = {
    operation: 'create_forum_post',
    requestUrl: response.url(),
    httpStatus: response.status(),
  };
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw Object.assign(
      new Error('DISCORD_FORUM_RESPONSE_READ_FAILED', { cause }),
      details,
    );
  }
  if (!response.ok())
    throw Object.assign(
      new Error(
        `DISCORD_FORUM_POST_REFUSED: HTTP ${response.status()}: ${text}`,
      ),
      details,
    );
  let thread;
  try {
    thread = JSON.parse(text);
  } catch (cause) {
    throw Object.assign(
      new Error('DISCORD_FORUM_RESPONSE_INVALID', { cause }),
      details,
      { responseBody: text },
    );
  }
  if (
    typeof thread?.id !== 'string' ||
    !/^\d+$/.test(thread.id) ||
    thread.parent_id !== channel[2] ||
    thread.type !== 11 ||
    thread.name !== TITLE ||
    typeof thread.message?.id !== 'string' ||
    !/^\d+$/.test(thread.message.id) ||
    thread.message.channel_id !== thread.id ||
    thread.message.content !== BODY
  ) {
    throw Object.assign(
      new Error(
        'DISCORD_FORUM_POST_UNCONFIRMED: the response does not confirm the requested forum post; reconcile it before another attempt',
      ),
      details,
      { responseBody: text },
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      operation: 'create_forum_post',
      acknowledgement: 'provider_response',
      guild_id: channel[1],
      parent_id: thread.parent_id,
      thread_id: thread.id,
      message_id: thread.message.id,
      url: `https://discord.com/channels/${channel[1]}/${thread.id}`,
    }),
  );
} catch (e) {
  console.error('DISCORD_FORUM_POST_FAILED:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
