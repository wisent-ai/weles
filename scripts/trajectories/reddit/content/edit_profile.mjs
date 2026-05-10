// Write the linked character's display_name + bio onto the reddit profile
// via /settings/profile (modern shreddit). Companion to the per-platform
// edit_profile chain.

import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';
import { loadAvatarFile } from '../../_shared/runner/avatar-loader.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
console.log(`[rd-profile] using account: ${acct.username}`);

const linkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,niche,avatar_url,training_images)`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
).then(r => r.ok ? r.json() : []);
const character = linkRes?.[0]?.characters;
if (!character) { console.log(`FAIL: no character linked to reddit/${acct.username}`); process.exit(1); }
console.log(`[rd-profile] character: ${character.name} (niche=${character.niche})`);
const rawAvatar = character.avatar_url || (Array.isArray(character.training_images) ? character.training_images[0] : null);
const avatarUrl = rawAvatar ? (rawAvatar.startsWith('http') ? rawAvatar : `https://content.wisent.ai${rawAvatar}`) : null;

const targetName = (character.name || '').slice(0, 30); // reddit display name cap
const targetBio = (character.bio || '').slice(0, 200);  // reddit "about" cap

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_edit_profile', proxy: proxyUrl, persona, browser: 'chromium' });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'reddit', label: 'reddit_edit_profile', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /reddit\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no reddit.com cookies', { platform: 'reddit' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://www.reddit.com/settings/profile', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (/\/login/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('reddit', s, { label: 'reddit_edit_profile' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // shreddit /settings/profile fields. The exact selectors vary across
  // cohorts, so try a wide net.
  const nameIn = s.page.locator('input[name*="display" i], input[id*="displayName" i], input[aria-label*="display name" i]').filter({ visible: true }).first();
  const bioIn = s.page.locator('textarea[name*="about" i], textarea[id*="about" i], textarea[aria-label*="about" i], textarea[placeholder*="about" i]').filter({ visible: true }).first();

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

  // Avatar upload — reddit's avatar-edit affordance lives on the user
  // profile page. Probe-verified 2026-05-07 (.work/rd-probe → weswest9029):
  //   1. nav /user/<u>/
  //   2. click button[aria-label="Edit profile avatar"] → modal opens with
  //      "Select a new image" + Save button
  //   3. click "Select a new image" → fires filechooser
  //   4. setFiles → enables Save in the modal
  //   5. The Save button lives in shadow DOM; pierce + click via evaluate
  //
  // Backend caveat: shreddit's CreateProfileStructuredStylesUploadLease
  // mutation needs the u_<username> subreddit to exist. Brand-new accounts
  // that have never posted see "Unable to resolve profile" — make a
  // throwaway post first if your account is fresh.
  if (avatarUrl) {
    const tmpAvatar = await loadAvatarFile(avatarUrl, { size: 512, format: 'jpeg', quality: 88 });
    if (tmpAvatar) {
      try {
        await s.page.goto(`https://www.reddit.com/user/${acct.username}/`, { waitUntil: 'domcontentloaded' });
        await humanIdlePause('long');
        const editAvatarBtn = s.page.locator('button[aria-label="Edit profile avatar"], [aria-label="Edit profile avatar"]').first();
        if (await editAvatarBtn.count()) {
          await editAvatarBtn.click();
          await humanIdlePause('deliberate');
          const selectBtn = s.page.locator('button:has-text("Select a new image")').first();
          if (await selectBtn.count()) {
            const fcPromise = s.page.waitForEvent('filechooser');
            await selectBtn.click();
            const fc = await fcPromise;
            await fc.setFiles(tmpAvatar);
            await humanIdlePause('long');
            // Save lives in shadow DOM; pierce + click the enabled one
            const saved = await s.page.evaluate(() => {
              function walk(root) {
                for (const el of root.querySelectorAll('button')) {
                  if ((el.textContent || '').trim() === 'Save' && !el.hasAttribute('disabled') && el.getBoundingClientRect().width > 0) {
                    el.click();
                    return true;
                  }
                }
                for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { if (walk(el.shadowRoot)) return true; }
                return false;
              }
              return walk(document);
            });
            if (saved) {
              await humanIdlePause('long');
              writes.push('avatar uploaded');
            } else { console.log('[rd-profile] no enabled Save after setFiles'); }
          } else { console.log('[rd-profile] no Select-a-new-image after Edit-avatar click'); }
        } else { console.log('[rd-profile] Edit-profile-avatar button not visible'); }
      } catch (e) { console.log(`[rd-profile] avatar err: ${e.message?.slice(0, 120)}`); }
    }
  }

  // Mirror to social_accounts.
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${acct.id}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ display_name: targetName || null, profile_url: `https://www.reddit.com/user/${acct.username}/`, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  if (!writes.length) { console.log('PASS: no-op (form values already match character; DB synced)'); process.exit(0); }
  console.log(`[rd-profile] writes: ${writes.join('; ')}`);

  // shreddit's save uses a Save button at the bottom of the form section.
  const saveBtn = s.page.locator('button:has-text("Save"), button[type="submit"]').filter({ visible: true }).first();
  await saveBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, saveBtn);
  await humanIdlePause('deliberate');
  console.log(`PASS: ${acct.username} profile updated to ${character.name}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
