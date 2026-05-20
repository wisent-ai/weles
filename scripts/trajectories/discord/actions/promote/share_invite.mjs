// Discord share-invite trajectory. PROMOTE tier per lifecycle.ts.
// Generates a fresh invite link for a channel the account is a member
// of and optionally DMs the link to listed targets.
//
// Env vars:
//   SERVER_CHANNEL_PATH — '<guild_id>/<channel_id>' to generate from.
//   TARGET_HANDLES      — optional, comma-separated handles to DM the
//     invite to. If unset, only the generation step runs; the invite
//     URL is printed to stdout for downstream consumption.
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/<guild>/<channel>.
//   3. Right-click on the channel name in the left rail; click
//      "Invite People" (or click the channel-header invite icon).
//   4. Read the rendered invite URL (input value or read-only display).
//   5. For each TARGET_HANDLES entry, drive the dm.mjs-style flow to
//      send the invite URL as the DM body.
//   6. Persist invite URL + targets to metadata.invites_sent[].

import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const CHANNEL = process.env.SERVER_CHANNEL_PATH;
const TARGETS = process.env.TARGET_HANDLES ? process.env.TARGET_HANDLES.split(',').map(t => t.trim()).filter(Boolean) : [];
if (!CHANNEL) { console.log('FAIL: SERVER_CHANNEL_PATH required'); process.exit(1); }

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_share_invite', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com', browser: 'chromium' });
console.log(`[share_invite] account=${acct.username} channel=${CHANNEL} dm_targets=${TARGETS.length}`);

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto(`https://discord.com/channels/${CHANNEL}`);
  await humanIdlePause('deliberate');

  // Click the "Invite People" icon in the channel header (right-side icons).
  const inviteIcon = s.page.locator('button[aria-label="Create Invite"], button[aria-label*="Invite"]').first();
  if ((await inviteIcon.count()) === 0) {
    console.log('FAIL: Invite People icon not visible — does this account have Create Invite permission?');
    process.exit(1);
  }
  await humanClickLocator(s.page, inviteIcon);
  await humanIdlePause('deliberate');

  // Read the invite URL from the modal — typically an input with value=https://discord.gg/...
  const inviteUrl = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM scrape for invite URL input value
    const inputs = Array.from(document.querySelectorAll('input'));
    const match = inputs.find(i => /^https:\/\/discord\.gg\//.test(i.value || ''));
    return match ? match.value : null;
  });
  if (!inviteUrl) { console.log('FAIL: invite URL not found in modal'); process.exit(1); }
  console.log(`[share_invite] generated: ${inviteUrl}`);

  const sent = [];
  for (const target of TARGETS) {
    // Open DM with target via Friends panel + new DM flow.
    await s.goto('https://discord.com/channels/@me');
    await humanIdlePause('deliberate');
    const dmAdd = s.page.locator('button[aria-label*="New Direct Message"], button[aria-label*="New DM"]').first();
    if ((await dmAdd.count()) === 0) { console.log(`[share_invite] new-DM button not found for ${target}`); continue; }
    await humanClickLocator(s.page, dmAdd);
    await humanIdlePause('deliberate');
    const userInput = s.page.locator('input[placeholder*="username"], input[placeholder*="add a friend"]').first();
    if ((await userInput.count()) === 0) { console.log(`[share_invite] DM user input not found for ${target}`); continue; }
    await humanFill(s.page, userInput, target);
    await humanIdlePause('short');
    // Click the first autocomplete result.
    const firstResult = s.page.locator('[role="listbox"] [role="option"], [class*="autocomplete"] [role="option"]').first();
    if ((await firstResult.count()) > 0) {
      try { await humanClickLocator(s.page, firstResult); }
      catch (e) { console.log(`[share_invite] result click err: ${e.message?.slice(0, 80)}`); continue; }
      await humanIdlePause('short');
    }
    const createDm = s.page.locator('button').filter({ hasText: /^Create (DM|Group DM)$/ }).first();
    if ((await createDm.count()) > 0) { try { await humanClickLocator(s.page, createDm); } catch (e) { console.log(`[share_invite] create-dm err: ${e.message?.slice(0, 80)}`); } }
    await humanIdlePause('deliberate');
    const composer = s.page.locator('[role="textbox"][data-slate-editor], div[role="textbox"]').filter({ visible: true }).first();
    if ((await composer.count()) === 0) { console.log(`[share_invite] DM composer not visible for ${target}`); continue; }
    await humanClickLocator(s.page, composer);
    await humanFill(s.page, composer, inviteUrl);
    await s.page.keyboard.press('Enter'); // allow-raw-playwright: Enter-to-send is canonical Discord submit gesture
    await humanIdlePause('deliberate');
    sent.push({ target, at: new Date().toISOString() });
    console.log(`[share_invite] DM'd ${target}`);
  }

  const supaUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl && supaKey) {
    const cur = await (await fetch(`${supaUrl}/rest/v1/social_accounts?platform=eq.discord&username=eq.${encodeURIComponent(acct.username)}&select=id,metadata`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })).json();
    if (cur && cur[0]) {
      const prev = cur[0].metadata && typeof cur[0].metadata === 'object' ? cur[0].metadata : {};
      const list = Array.isArray(prev.invites_sent) ? prev.invites_sent : [];
      list.push({ channel: CHANNEL, url: inviteUrl, at: new Date().toISOString(), dm_targets: sent });
      const merged = { ...prev, invites_sent: list };
      await fetch(`${supaUrl}/rest/v1/social_accounts?id=eq.${cur[0].id}`, { method: 'PATCH', headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) });
      console.log('[share_invite] persisted metadata.invites_sent[]');
    }
  }
  console.log(`PASS: ${acct.username} shared invite ${inviteUrl} (DM'd ${sent.length} target(s))`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
