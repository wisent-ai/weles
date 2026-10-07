// Discord view-profile trajectory. PASSIVE tier per lifecycle.ts.
// Opens another user's profile via the SPA popout and dumps visible
// data (display name, bio, avatar URL, banner URL, connected accounts).
//
// Env vars:
//   DISCORD_TARGET_USER_ID — numeric Discord user id (snowflake).
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /users/<id> (Discord redirects to the profile modal).
//   3. Observe a visible profile root and its rendered identity text.
//   4. Scrape display_name + username + bio + avatar + banner +
//      connected_accounts through read-only evaluation of the visible element.
//   5. Write JSON under runOutputPath('discord_view_profile') for the requested id.

import { runOutputPath } from '#run-output';
import fs from 'node:fs';
import path from 'node:path';
import { WSession } from '../../../../../dist/session/wsession.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';
import { pageSettled } from '../../../_shared/page/settled.mjs';
import { checkReachable } from '../../../_shared/action-runner.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const TARGET_ID = process.env.DISCORD_TARGET_USER_ID;
if (!TARGET_ID) { console.log('FAIL: DISCORD_TARGET_USER_ID required'); process.exit(1); }
if (!/^\d+$/.test(TARGET_ID)) {
  console.error(`DISCORD_PROFILE_TARGET_INVALID: DISCORD_TARGET_USER_ID must be numeric; observed ${JSON.stringify(TARGET_ID)}`);
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_view_profile', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[view_profile] account=${acct.username} target_id=${TARGET_ID}`);

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto('https://discord.com/channels/@me');
  await pageSettled(s.page);
  checkReachable(s, 'discord');
  await s.goto(`https://discord.com/users/${TARGET_ID}`);
  await pageSettled(s.page);
  checkReachable(s, 'discord');
  const profileRoot = s.page.locator('[class*="userPopout"], [class*="profileModal"], [class*="userProfile"]').filter({ visible: true }).first();
  await profileRoot.waitFor({ state: 'visible' });
  await profileRoot.locator('[class*="displayName"], [class*="nickname"], [class*="username"], [class*="discriminator"]')
    .filter({ visible: true, hasText: /\S/ }).first().waitFor({ state: 'visible' });

  const profile = await profileRoot.evaluate((root) => { // allow-raw-playwright: read-only scrape of the observed visible profile element
    const get = (sel) => { const e = root.querySelector(sel); return e ? (e.textContent || '').trim() : null; };
    const imgs = Array.from(root.querySelectorAll('img'));
    const avatar = imgs.find(i => /\/avatars\//.test(i.src || ''));
    const banner = imgs.find(i => /\/banners\//.test(i.src || ''));
    const bioEl = root.querySelector('[class*="bio"], [class*="aboutMe"]');
    const display = get('[class*="displayName"], [class*="nickname"]');
    const username = get('[class*="username"], [class*="discriminator"]');
    const connected = Array.from(root.querySelectorAll('[class*="connectedAccount"]')).map(e => (e.textContent || '').trim());
    return { display, username, bio: bioEl ? (bioEl.textContent || '').trim() : null, avatar: avatar ? avatar.src : null, banner: banner ? banner.src : null, connected };
  });
  if (!profile.display && !profile.username) throw Object.assign(new Error('DISCORD_PROFILE_CONTENT_UNCONFIRMED: the observed profile lost its rendered identity text'),
    { targetId: TARGET_ID, pageUrl: s.page.url(), observedProfile: profile });
  console.log(`[view_profile] dump=${JSON.stringify(profile)}`);

  const outDir = runOutputPath('discord_view_profile');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${TARGET_ID}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ...profile, id: TARGET_ID, fetched_at: new Date().toISOString(), fetched_by: acct.username }, null, 2));
  console.log(`PASS: wrote ${outPath}`);
} catch (e) {
  console.error('DISCORD_PROFILE_READ_FAILED:', e, { targetId: TARGET_ID, pageUrl: s.page.url() });
  process.exitCode = 1;
} finally {
  await s.close();
}
