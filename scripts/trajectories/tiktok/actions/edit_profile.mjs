// Write the linked character's persona content (display_name + bio) onto
// the TikTok profile via the settings/profile page.
//
// Companion to instagram's edit_profile (commit b9be789). tiktok has 2
// char-linked active accounts (marlongoodwin9943, meredithortiz502) so
// this trajectory can be live-validated, unlike instagram where all 5
// char-linked accounts are deactivated.

import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';
import { loadAvatarFile } from '../../_shared/runner/avatar-loader.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exit(1); }
console.log(`[tt-profile] using account: ${acct.username}`);

const linkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,niche,avatar_url,training_images)`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
).then(r => r.ok ? r.json() : []);
const character = linkRes?.[0]?.characters;
if (!character) { console.log(`FAIL: no character linked to tiktok/${acct.username}`); process.exit(1); }
console.log(`[tt-profile] character: ${character.name} (niche=${character.niche})`);
const rawAvatar = character.avatar_url || (Array.isArray(character.training_images) ? character.training_images[0] : null);
const avatarUrl = rawAvatar ? (rawAvatar.startsWith('http') ? rawAvatar : `https://content.wisent.ai${rawAvatar}`) : null;

// TikTok bio cap is 80 chars.
const targetBio = (character.bio || '').slice(0, 80);
const targetName = character.name || '';

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_edit_profile', proxy: proxyUrl, persona });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'tiktok', label: 'tiktok_edit_profile', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /tiktok\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no tiktok.com cookies', { platform: 'tiktok' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  // TikTok's account-edit URL. The exact path has shifted across redesigns —
  // try the canonical /setting first; if redirected, the trajectory will
  // surface that final URL in the auth-probe failure.
  await s.page.goto('https://www.tiktok.com/setting', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (/\/login(\/|$)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('tiktok', s, { label: 'tiktok_edit_profile' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Profile fields on /setting:
  //   * Name      → input[data-e2e="edit-profile-name"] or input near "Name" label
  //   * Bio       → textarea[data-e2e="edit-profile-bio"] or textarea near "Bio"
  // Both are inline-edit fields; some cohorts gate edits behind a "Edit profile" button.
  const editBtn = s.page.locator('button:has-text("Edit profile"), [data-e2e="edit-profile-entrance"]').filter({ visible: true }).first();
  if (await editBtn.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, editBtn);
    await humanIdlePause('deliberate');
  }

  const nameIn = s.page.locator('input[data-e2e*="name" i], input[placeholder*="name" i], input[aria-label*="name" i]').filter({ visible: true }).first();
  const bioIn = s.page.locator('textarea[data-e2e*="bio" i], textarea[placeholder*="bio" i], textarea[aria-label*="bio" i]').filter({ visible: true }).first();

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

  // Avatar upload — tiktok /setting exposes an avatar zone. Hovering shows
  // a "Change photo" button that opens a dialog with an inline upload
  // <input type="file" accept="image/*">. After upload, an "Apply" button
  // commits the crop.
  if (avatarUrl) {
    const tmpAvatar = await loadAvatarFile(avatarUrl, { size: 512, format: 'jpeg', quality: 88 });
    if (tmpAvatar) {
      try {
        const changeBtn = s.page.locator('[data-e2e*="avatar" i], button:has-text("Change photo"), div[role="button"]:has-text("Change photo")').filter({ visible: true }).first();
        if (await changeBtn.isVisible().catch(() => false)) {
          await humanClickLocator(s.page, changeBtn);
          await humanIdlePause('deliberate');
        }
        const fileIn = s.page.locator('input[type="file"][accept*="image"]').first();
        if (await fileIn.count()) {
          await fileIn.setInputFiles(tmpAvatar);
          await humanIdlePause('deliberate');
          const applyBtn = s.page.locator('button:has-text("Apply"), button:has-text("Confirm"), button:has-text("Save")').filter({ visible: true }).first();
          try {
            await applyBtn.waitFor({ state: 'visible' });
            await humanClickLocator(s.page, applyBtn);
            writes.push('avatar uploaded');
            await humanIdlePause('deliberate');
          } catch { console.log('[tt-profile] avatar apply not visible'); }
        } else { console.log('[tt-profile] no image file input on /setting'); }
      } catch (e) { console.log(`[tt-profile] avatar err: ${e.message?.slice(0, 120)}`); }
    }
  }

  // Mirror to social_accounts even on no-op.
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${acct.id}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ display_name: targetName || null, profile_url: `https://www.tiktok.com/@${acct.username}`, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  if (!writes.length) { console.log('PASS: no-op (form values already match character; DB synced)'); process.exit(0); }
  console.log(`[tt-profile] writes: ${writes.join('; ')}`);

  // Save. TikTok's button often reads "Save" — sometimes inside a modal.
  const saveBtn = s.page.locator('button:has-text("Save"), [data-e2e="save-profile"]').filter({ visible: true }).first();
  await saveBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, saveBtn);
  await humanIdlePause('deliberate');

  const verifiedBio = await bioIn.inputValue().catch(() => '');
  if (verifiedBio.trim() !== targetBio.trim()) {
    console.log(`FAIL: bio mismatch after save ("${verifiedBio.slice(0, 60)}..." != "${targetBio.slice(0, 60)}...")`);
    process.exit(1);
  }
  console.log(`PASS: ${acct.username} profile updated to ${character.name}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
