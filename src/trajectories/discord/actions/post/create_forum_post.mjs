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
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const CHANNEL = process.env.FORUM_CHANNEL_PATH;
const TITLE = process.env.POST_TITLE;
const BODY = process.env.POST_BODY;
const TAGS = process.env.POST_TAGS ? process.env.POST_TAGS.split(',').map(t => t.trim()).filter(Boolean) : [];
if (!CHANNEL || !TITLE || !BODY) {
  console.log('FAIL: FORUM_CHANNEL_PATH + POST_TITLE + POST_BODY all required');
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_create_forum_post', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[forum_post] account=${acct.username} channel=${CHANNEL} title=${TITLE.slice(0, 40)}`);

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto(`https://discord.com/channels/${CHANNEL}`);
  await humanIdlePause('deliberate');

  // "New Post" button at top-right of the forum view.
  const newPostBtn = s.page.locator('button').filter({ hasText: /^New Post$/ }).first();
  if ((await newPostBtn.count()) === 0) { console.log('FAIL: New Post button not found (is this actually a forum channel?)'); process.exit(1); }
  await humanClickLocator(s.page, newPostBtn);
  await humanIdlePause('deliberate');

  const titleInput = s.page.locator('input[placeholder*="title"], input[placeholder*="Title"], input[maxlength="100"]').first();
  if ((await titleInput.count()) === 0) { console.log('FAIL: title input not visible'); process.exit(1); }
  await humanFill(s.page, titleInput, TITLE);
  await humanIdlePause('short');

  for (const tag of TAGS) {
    const chip = s.page.locator('div, button').filter({ hasText: new RegExp(`^${tag}$`, 'i') }).first();
    if ((await chip.count()) > 0) {
      try { await humanClickLocator(s.page, chip); console.log(`[forum_post] tag=${tag} selected`); }
      catch (e) { console.log(`[forum_post] tag ${tag} click err: ${e.message?.slice(0, 80)}`); }
      await humanIdlePause('short');
    }
  }

  const bodyComposer = s.page.locator('[role="textbox"][data-slate-editor], div[role="textbox"]').filter({ visible: true }).first();
  if ((await bodyComposer.count()) === 0) { console.log('FAIL: body composer not visible'); process.exit(1); }
  await humanClickLocator(s.page, bodyComposer);
  await humanIdlePause('short');
  await humanFill(s.page, bodyComposer, BODY);
  await humanIdlePause('short');

  const postBtn = s.page.locator('button').filter({ hasText: /^Post$/ }).first();
  if ((await postBtn.count()) === 0) { console.log('FAIL: Post button not visible'); process.exit(1); }
  await humanClickLocator(s.page, postBtn);
  await humanIdlePause('deliberate');

  // After post, URL changes to /channels/<guild>/<thread_id>
  const newUrl = s.page.url();
  const inPostUrl = /\/channels\/\d+\/\d+\/\d+/.test(newUrl) || newUrl !== `https://discord.com/channels/${CHANNEL}`;
  if (!inPostUrl) { console.log(`FAIL: forum post did not navigate (url=${newUrl})`); process.exit(1); }
  console.log(`PASS: ${acct.username} posted "${TITLE.slice(0, 40)}" -> ${newUrl}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
