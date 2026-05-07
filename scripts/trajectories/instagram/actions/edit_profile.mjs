// Write the linked character's persona content (bio, display_name, optional
// external_url) onto the instagram profile via /accounts/edit/.
//
// 2026-05-06 evidence: 0 of 102 active social_accounts had avatar_url set
// and only 90/102 had display_name; the character rows had rich bio +
// personality but nothing was propagating to the platform UI.
//
// Idempotent: skips writes when the form value already equals the character
// row's value, so re-running is cheap.

import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';
import { loadAvatarFile } from '../../_shared/runner/avatar-loader.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account in DB'); process.exit(1); }
console.log(`[ig-profile] using account: ${acct.username}`);

// Pull the linked character's persona data. Without a link, there's nothing
// to write — exit cleanly so the worker doesn't retry.
const linkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,niche,occupation,home_city,avatar_url,training_images)`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
).then(r => r.ok ? r.json() : []);
const character = linkRes?.[0]?.characters;
if (!character) { console.log(`FAIL: no character linked to instagram/${acct.username}`); process.exit(1); }
console.log(`[ig-profile] character: ${character.name} (niche=${character.niche})`);
const rawAvatar = character.avatar_url || (Array.isArray(character.training_images) ? character.training_images[0] : null);
const avatarUrl = rawAvatar ? (rawAvatar.startsWith('http') ? rawAvatar : `https://content.wisent.ai${rawAvatar}`) : null;

const targetBio = (character.bio || '').slice(0, 150);
const targetName = character.name || '';

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_edit_profile', proxy: proxyUrl, persona, browser: 'chromium' });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'instagram', label: 'instagram_edit_profile', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /instagram\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no instagram.com cookies', { platform: 'instagram' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(5000);
  if (/\/accounts\/login/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('instagram', s, { label: 'instagram_edit_profile' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // The /accounts/edit form has aria-labeled inputs:
  //   * Name      → input with aria-label*="Name"
  //   * Bio       → textarea (the only one on the page) with aria-label*="Bio"
  // Both render as visible focused-on-mount fields. Read current value, only
  // type when it differs from the character target.
  const nameIn = s.page.locator('input[aria-label*="Name" i], input[name="full_name" i]').filter({ visible: true }).first();
  const bioIn = s.page.locator('textarea[aria-label*="Bio" i], textarea[name="biography" i]').filter({ visible: true }).first();

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

  // Avatar upload — instagram /accounts/edit/ exposes a "Change profile
  // photo" overlay that opens a dialog with an Upload Photo button bound
  // to a hidden input[type="file"][accept*="image"]. The Upload-Photo
  // button binding fires a filechooser; we also accept direct setInputFiles
  // on the hidden input when the binding is missing.
  if (avatarUrl) {
    const tmpAvatar = await loadAvatarFile(avatarUrl, { size: 512, format: 'jpeg', quality: 88 });
    if (tmpAvatar) {
      try {
        const changeBtn = s.page.locator('button:has-text("Change profile photo"), div[role="button"]:has-text("Change profile photo")').filter({ visible: true }).first();
        if (await changeBtn.isVisible().catch(() => false)) {
          await humanClickLocator(s.page, changeBtn);
          await s.page.waitForTimeout(2500);
          const upload = s.page.locator('button:has-text("Upload Photo"), button:has-text("Upload photo")').filter({ visible: true }).first();
          if (await upload.isVisible().catch(() => false)) {
            const fileChooserPromise = s.page.waitForEvent('filechooser');
            await upload.click();
            const fc = await fileChooserPromise;
            await fc.setFiles(tmpAvatar);
            await s.page.waitForTimeout(4000);
            writes.push('avatar uploaded');
          } else {
            const fileIn = s.page.locator('input[type="file"][accept*="image"]').first();
            if (await fileIn.count()) {
              await fileIn.setInputFiles(tmpAvatar);
              await s.page.waitForTimeout(4000);
              writes.push('avatar uploaded');
            } else { console.log('[ig-profile] no upload affordance after Change clicked'); }
          }
        } else { console.log('[ig-profile] Change profile photo button not visible'); }
      } catch (e) { console.log(`[ig-profile] avatar err: ${e.message?.slice(0, 120)}`); }
    }
  }

  // Mirror to social_accounts even on no-op so dashboards reflect the
  // platform-side state regardless of whether this run wrote anything.
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${acct.id}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ display_name: targetName || null, profile_url: `https://www.instagram.com/${acct.username}/`, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  if (!writes.length) { console.log('PASS: no-op (form values already match character; DB synced)'); process.exit(0); }
  console.log(`[ig-profile] writes: ${writes.join('; ')}`);

  // Submit. Instagram's submit on this page is a <div role="button"> reading
  // "Submit" or sometimes a localized variant.
  const submitBtn = s.page.locator('div[role="button"]:has-text("Submit"), button[type="submit"]:has-text("Submit")').filter({ visible: true }).first();
  await submitBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submitBtn);
  await s.page.waitForTimeout(4000);

  // Verify the changes stuck by re-reading the form fields.
  const verifiedName = await nameIn.inputValue().catch(() => '');
  const verifiedBio = await bioIn.inputValue().catch(() => '');
  if (targetName && verifiedName.trim() !== targetName.trim()) {
    console.log(`FAIL: name mismatch after submit ("${verifiedName}" != "${targetName}")`);
    process.exit(1);
  }
  if (verifiedBio.trim() !== targetBio.trim()) {
    console.log(`FAIL: bio mismatch after submit ("${verifiedBio.slice(0, 60)}..." != "${targetBio.slice(0, 60)}...")`);
    process.exit(1);
  }
  console.log(`PASS: ${acct.username} profile updated to ${character.name}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
