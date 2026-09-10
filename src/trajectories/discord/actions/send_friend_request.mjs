// Discord send-friend-request trajectory. PROMOTE tier per lifecycle.ts.
//
// Env vars:
//   DISCORD_TARGET_HANDLE — username or username#discriminator of the
//     account to friend. Discord migrated to global names so the
//     handle format is bare username (no #disc) for most accounts.
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/@me (Friends panel is the default view).
//   3. Click "Add Friend" tab at the top.
//   4. humanFill the username input with DISCORD_TARGET_HANDLE.
//   5. Click "Send Friend Request" button.
//   6. Watch for the toast / inline message that signals success vs error
//      ("Friend request sent" vs "You need to enter a valid Username" or
//      "You are blocked" or "Hm, didn't work."). Persist outcome.
//   7. Append to metadata.friend_requests_sent array on social_accounts.

import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { updateAccountMetadata } from '../../_shared/skarbiec_accounts.mjs';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const TARGET = process.env.DISCORD_TARGET_HANDLE;
if (!TARGET) { console.log('FAIL: DISCORD_TARGET_HANDLE env required'); process.exit(1); }

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_send_friend_request', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[friend_request] account=${acct.username} target=${TARGET}`);

async function detectOutcome() {
  const toastHits = ['Friend request sent', 'is already your friend', 'Hm, didn', 'find a user with that username'];
  for (const phrase of toastHits) {
    const loc = s.page.locator(`text=${phrase}`).first();
    if ((await loc.count()) > 0) {
      try { return await loc.textContent(); }
      catch (e) { console.log(`[friend_request] toast read err: ${e.message?.slice(0, 80)}`); }
    }
  }
  return null;
}

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto('https://discord.com/channels/@me');
  await humanIdlePause('deliberate');

  const addTab = s.page.locator('div, button').filter({ hasText: /^Add Friend$/ }).first();
  if ((await addTab.count()) === 0) { console.log('FAIL: Add Friend tab not found on Friends panel'); process.exit(1); }
  await humanClickLocator(s.page, addTab);
  await humanIdlePause('deliberate');

  const input = s.page.locator('input[placeholder*="username"], input[placeholder*="Username"]').first();
  if ((await input.count()) === 0) { console.log('FAIL: username input not found on Add Friend panel'); process.exit(1); }
  await humanFill(s.page, input, TARGET);
  await humanIdlePause('short');

  const sendBtn = s.page.locator('button').filter({ hasText: 'Send Friend Request' }).first();
  if ((await sendBtn.count()) === 0) { console.log('FAIL: Send Friend Request button not found'); process.exit(1); }
  await humanClickLocator(s.page, sendBtn);
  await humanIdlePause('deliberate');

  const outcome = await detectOutcome();
  if (!outcome) { console.log('FAIL: no recognizable post-send outcome message'); process.exit(1); }
  const success = outcome.includes('sent');
  console.log(`[friend_request] outcome=${outcome.slice(0, 120)}`);

  if (!acct.id) throw new Error('Discord account has no stable Skarbiec id');
  const list = Array.isArray(acct.metadata?.friend_requests_sent)
    ? [...acct.metadata.friend_requests_sent]
    : [];
  list.push({ target: TARGET, at: new Date().toISOString(), success, outcome: outcome.slice(0, 200) });
  updateAccountMetadata(acct.id, { friend_requests_sent: list });
  console.log('[friend_request] persisted metadata.friend_requests_sent[] in Skarbiec');
  if (!success) { console.log(`FAIL: ${outcome.slice(0, 80)}`); process.exit(1); }
  console.log(`PASS: ${acct.username} sent friend request to ${TARGET}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
