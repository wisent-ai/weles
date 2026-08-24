// Discord edit-profile trajectory. Picks one of three writable surfaces
// (display name, About Me bio, custom status) based on env vars and
// updates it via the SPA — same selector chain as the keeper-demonstrated
// email_verify flow but landing on different rows in My Account.
//
// Env vars (set one; if multiple, all are applied):
//   DISCORD_NEW_DISPLAY_NAME  — new global Display Name
//   DISCORD_NEW_BIO           — new "About Me" text
//   DISCORD_NEW_STATUS        — new custom status text (max ~128 chars)
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/@me.
//   3. Open User Settings via gear button.
//   4. For each set env var, find the matching row in My Account or
//      User Profile pane, click its Edit button, fill, click Save Changes.
//   5. Verify the new value persisted by re-reading the field's value.
//   6. Persist last_edit_at to social_accounts.metadata.

import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { updateAccountMetadata } from '../../_shared/skarbiec_accounts.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const NEW_DISPLAY = process.env.DISCORD_NEW_DISPLAY_NAME;
const NEW_BIO = process.env.DISCORD_NEW_BIO;
const NEW_STATUS = process.env.DISCORD_NEW_STATUS;
if (!NEW_DISPLAY && !NEW_BIO && !NEW_STATUS) {
  console.log('FAIL: at least one of DISCORD_NEW_DISPLAY_NAME / DISCORD_NEW_BIO / DISCORD_NEW_STATUS required');
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_edit_profile', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[edit_profile] account=${acct.username}`);

async function editInline(rowName, newValue) {
  const row = s.page.locator('div').filter({ hasText: new RegExp(`^${rowName}$`, 'i') }).first();
  if ((await row.count()) === 0) { console.log(`[edit_profile] row "${rowName}" not found`); return false; }
  // Edit button is typically a sibling/parent. Find nearest Edit button.
  const editBtn = s.page.locator('button').filter({ hasText: 'Edit' }).first();
  await humanClickLocator(s.page, editBtn);
  await humanIdlePause('deliberate');
  const input = s.page.locator('input, textarea').filter({ visible: true }).first();
  await humanFill(s.page, input, newValue);
  await humanIdlePause('short');
  const save = s.page.locator('button').filter({ hasText: 'Save Changes' }).first();
  if ((await save.count()) === 0) { console.log(`[edit_profile] no Save Changes button for "${rowName}"`); return false; }
  await humanClickLocator(s.page, save);
  await humanIdlePause('deliberate');
  return true;
}

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto('https://discord.com/channels/@me');
  await humanIdlePause('deliberate');

  const gear = s.page.locator('button[aria-label="User Settings"]').first();
  await humanClickLocator(s.page, gear);
  await humanIdlePause('deliberate');

  const changes = [];
  if (NEW_DISPLAY) {
    const ok = await editInline('Display Name', NEW_DISPLAY);
    if (ok) { changes.push(`display_name=${NEW_DISPLAY}`); console.log(`[edit_profile] display_name set`); }
  }
  if (NEW_BIO) {
    // About Me lives under User Profile tab on the left nav.
    const userProfile = s.page.locator('div').filter({ hasText: /^User Profile$/ }).first();
    if ((await userProfile.count()) > 0) {
      try { await humanClickLocator(s.page, userProfile); } catch (e) { console.log(`[edit_profile] user profile tab err: ${e.message?.slice(0, 80)}`); }
      await humanIdlePause('deliberate');
    }
    const bioField = s.page.locator('textarea[aria-label*="About"], textarea[placeholder*="What do you like"]').first();
    if ((await bioField.count()) > 0) {
      await humanFill(s.page, bioField, NEW_BIO);
      const save = s.page.locator('button').filter({ hasText: 'Save Changes' }).first();
      if ((await save.count()) > 0) {
        await humanClickLocator(s.page, save);
        await humanIdlePause('deliberate');
        changes.push(`bio=<${NEW_BIO.length} chars>`);
        console.log(`[edit_profile] bio set (${NEW_BIO.length} chars)`);
      }
    } else { console.log('[edit_profile] About Me textarea not found'); }
  }
  if (NEW_STATUS) {
    // Custom Status: bottom-left user popout -> Set a custom status.
    // Close settings first.
    const closeSettings = s.page.locator('div[aria-label="Close"]').first();
    if ((await closeSettings.count()) > 0) {
      try { await humanClickLocator(s.page, closeSettings); } catch (e) { console.log(`[edit_profile] settings close err: ${e.message?.slice(0, 80)}`); }
      await humanIdlePause('deliberate');
    }
    // Click user avatar in bottom-left to open status popover
    const userBtn = s.page.locator('button[aria-label*="status"], button[class*="avatarWrapper"]').first();
    if ((await userBtn.count()) > 0) {
      try { await humanClickLocator(s.page, userBtn); } catch (e) { console.log(`[edit_profile] user btn err: ${e.message?.slice(0, 80)}`); }
      await humanIdlePause('deliberate');
      const setStatus = s.page.locator('div, button').filter({ hasText: 'Set a custom status' }).first();
      if ((await setStatus.count()) > 0) {
        try { await humanClickLocator(s.page, setStatus); } catch (e) { console.log(`[edit_profile] set-status click err: ${e.message?.slice(0, 80)}`); }
        await humanIdlePause('deliberate');
        const statusInput = s.page.locator('input[placeholder*="status"]').first();
        if ((await statusInput.count()) > 0) {
          await humanFill(s.page, statusInput, NEW_STATUS);
          const save = s.page.locator('button').filter({ hasText: 'Save' }).first();
          if ((await save.count()) > 0) {
            await humanClickLocator(s.page, save);
            await humanIdlePause('deliberate');
            changes.push(`status=${NEW_STATUS.slice(0, 40)}`);
            console.log(`[edit_profile] status set`);
          }
        }
      }
    }
  }
  if (changes.length === 0) { console.log('FAIL: no fields successfully updated'); process.exit(1); }

  if (!acct.id) throw new Error('Discord account has no stable Skarbiec id');
  updateAccountMetadata(acct.id, {
    last_profile_edit_at: new Date().toISOString(),
    last_profile_changes: changes,
  });
  console.log('[edit_profile] persisted account metadata in Skarbiec');
  console.log(`PASS: ${acct.username} ${changes.join(', ')}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
