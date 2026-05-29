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
//   3. Wait for the profile root to render.
//   4. Scrape display_name + username + bio + avatar + banner +
//      connected_accounts via read-only page.evaluate.
//   5. Write JSON to .work/discord_view_profile/<id>.json.

import fs from 'node:fs';
import path from 'node:path';
import { WSession } from '../../../../../dist/session/wsession.js';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const TARGET_ID = process.env.DISCORD_TARGET_USER_ID;
if (!TARGET_ID) { console.log('FAIL: DISCORD_TARGET_USER_ID required'); process.exit(1); }

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
  await humanIdlePause('deliberate');
  await s.goto(`https://discord.com/users/${TARGET_ID}`);
  await humanIdlePause('deliberate');

  const profile = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM scrape of profile-popout text + img srcs
    const root = document.querySelector('[class*="userPopout"], [class*="profileModal"], [class*="userProfile"]');
    if (!root) return null;
    const get = (sel) => { const e = root.querySelector(sel); return e ? (e.textContent || '').trim() : null; };
    const imgs = Array.from(root.querySelectorAll('img'));
    const avatar = imgs.find(i => /\/avatars\//.test(i.src || ''));
    const banner = imgs.find(i => /\/banners\//.test(i.src || ''));
    const bioEl = root.querySelector('[class*="bio"], [class*="aboutMe"]');
    const display = get('[class*="displayName"], [class*="nickname"]');
    const username = get('[class*="username"], [class*="discriminator"]');
    const connected = Array.from(root.querySelectorAll('[class*="connectedAccount"]')).map(e => (e.textContent || '').trim()).slice(0, 10);
    return { display, username, bio: bioEl ? (bioEl.textContent || '').trim() : null, avatar: avatar ? avatar.src : null, banner: banner ? banner.src : null, connected };
  });
  if (!profile) { console.log('FAIL: profile popout did not render'); process.exit(1); }
  console.log(`[view_profile] dump=${JSON.stringify(profile).slice(0, 200)}`);

  const outDir = path.resolve(process.cwd(), '.work/discord_view_profile');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${TARGET_ID}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ...profile, id: TARGET_ID, fetched_at: new Date().toISOString(), fetched_by: acct.username }, null, 2));
  console.log(`PASS: wrote ${outPath}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
