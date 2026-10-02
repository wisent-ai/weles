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
//   6. The outcome is the answer Discord gives its own UI to the relationship
//      request the click sends: 204 means sent; any other status carries
//      Discord's reason in its body. Persist outcome.
//   7. Append to metadata.friend_requests_sent array on social_accounts.

import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { updateAccountMetadata } from '../../_shared/skarbiec/accounts.mjs';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { pageSettled, responseAfterAction } from '../../_shared/page/settled.mjs';
import { checkReachable } from '../../_shared/action-runner.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const TARGET = process.env.DISCORD_TARGET_HANDLE;
if (!TARGET) { console.log('FAIL: DISCORD_TARGET_HANDLE env required'); process.exit(1); }

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
if (!acct.id) throw new Error('Discord account has no stable Skarbiec id');
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_send_friend_request', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[friend_request] account=${acct.username} target=${TARGET}`);


try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto('https://discord.com/channels/@me');
  await pageSettled(s.page);
  checkReachable(s, 'discord');

  const addTab = s.page.locator('div, button').filter({ hasText: /^Add Friend$/ }).filter({ visible: true }).first();
  await addTab.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, addTab);

  const input = s.page.locator('input[placeholder*="username"], input[placeholder*="Username"]').filter({ visible: true }).first();
  await input.waitFor({ state: 'visible' });
  await humanFill(s.page, input, TARGET);
  await s.page.keyboard.press('Tab');
  const observedTarget = await input.inputValue();
  if (observedTarget !== TARGET) throw Object.assign(new Error('Friend-request input does not match the requested handle'),
    { code: 'DISCORD_FRIEND_TARGET_MISMATCH', expectedTarget: TARGET, observedTarget });

  const sendBtn = s.page.locator('button').filter({ hasText: 'Send Friend Request' }).filter({ visible: true }).first();
  await sendBtn.waitFor({ state: 'visible' });
  if (!await sendBtn.isEnabled()) throw Object.assign(new Error('Send Friend Request button is disabled after target entry'),
    { code: 'DISCORD_FRIEND_REQUEST_NOT_ENABLED', pageUrl: s.page.url() });
  const response = await responseAfterAction(s.page,
    (request) => request.method() === 'POST'
      && /\/users\/@me\/relationships$/.test(new globalThis.URL(request.url()).pathname),
    () => humanClickLocator(s.page, sendBtn));
  const success = response.status() === 204;
  const outcome = success ? 'sent' : `refused with HTTP ${response.status()}: ${(await response.text())}`;
  console.log(`[friend_request] outcome=${outcome}`);

  const list = Array.isArray(acct.metadata?.friend_requests_sent)
    ? [...acct.metadata.friend_requests_sent]
    : [];
  list.push({ target: TARGET, at: new Date().toISOString(), success, outcome: outcome });
  updateAccountMetadata(acct.id, { friend_requests_sent: list });
  console.log('[friend_request] persisted metadata.friend_requests_sent[] in Skarbiec');
  if (!success) { console.log(`FAIL: ${outcome}`); process.exitCode = 1; }
  else console.log(`PASS: ${acct.username} sent friend request to ${TARGET}`);
} catch (e) {
  console.error('DISCORD_FRIEND_REQUEST_FAILED:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
