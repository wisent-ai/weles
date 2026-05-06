// Write the linked character's persona content (name + bio) onto the
// X/Twitter profile via the profile-edit modal.
//
// Companion to instagram/tiktok/linkedin edit_profile.

import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
console.log(`[tw-profile] using account: ${acct.username}`);

const linkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,niche)`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
).then(r => r.ok ? r.json() : []);
const character = linkRes?.[0]?.characters;
if (!character) { console.log(`FAIL: no character linked to twitter/${acct.username}`); process.exit(1); }
console.log(`[tw-profile] character: ${character.name} (niche=${character.niche})`);

const targetName = character.name || '';
const targetBio = (character.bio || '').slice(0, 160);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_edit_profile', proxy: proxyUrl, persona, browser: 'chromium' });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'twitter', label: 'twitter_edit_profile', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no x.com/twitter.com cookies', { platform: 'twitter' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  // Land on home first so assertAuthed has a known authed surface, then
  // navigate to the profile and click "Edit profile".
  await s.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(4000);
  if (/\/(i\/flow\/login|login)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('twitter', s, { label: 'twitter_edit_profile' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  await s.page.goto(`https://x.com/${encodeURIComponent(acct.username)}`, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3500);

  // Click the "Edit profile" button. Twitter exposes both an aria-label and
  // a visible-text variant; cohorts vary.
  const editBtn = s.page.locator('a[href="/settings/profile"], a[data-testid="edit_profile"], div[role="button"]:has-text("Edit profile"), button:has-text("Edit profile")').filter({ visible: true }).first();
  await editBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, editBtn);
  await s.page.waitForTimeout(3500);

  // The Edit-profile modal exposes:
  //   Name → input[name="displayName"]
  //   Bio  → textarea[name="description"]
  const nameIn = s.page.locator('input[name="displayName"], input[aria-label="Name"]').filter({ visible: true }).first();
  const bioIn = s.page.locator('textarea[name="description"], textarea[aria-label*="Bio" i]').filter({ visible: true }).first();

  const writes = [];
  if (await nameIn.count()) {
    const cur = await nameIn.inputValue().catch(() => '');
    if (cur.trim() !== targetName.trim()) {
      await humanClickLocator(s.page, nameIn);
      await s.page.keyboard.press('Meta+A').catch(() => {});
      await s.page.keyboard.press('Control+A').catch(() => {});
      await s.page.keyboard.press('Backspace').catch(() => {});
      await humanType(s.page, targetName);
      writes.push(`name "${cur}" -> "${targetName}"`);
    }
  }
  if (await bioIn.count()) {
    const cur = await bioIn.inputValue().catch(() => '');
    if (cur.trim() !== targetBio.trim()) {
      await humanClickLocator(s.page, bioIn);
      await s.page.keyboard.press('Meta+A').catch(() => {});
      await s.page.keyboard.press('Control+A').catch(() => {});
      await s.page.keyboard.press('Backspace').catch(() => {});
      await humanType(s.page, targetBio);
      writes.push(`bio (${cur.length} -> ${targetBio.length} chars)`);
    }
  }

  if (!writes.length) { console.log('PASS: no-op (form values already match character)'); process.exit(0); }
  console.log(`[tw-profile] writes: ${writes.join('; ')}`);

  // Save: button[data-testid="Profile_Save_Button"] in the modal.
  const saveBtn = s.page.locator('button[data-testid="Profile_Save_Button"], button:has-text("Save")').filter({ visible: true }).first();
  await saveBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, saveBtn);
  await s.page.waitForTimeout(4000);
  console.log(`PASS: ${acct.username} profile updated to ${character.name}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
