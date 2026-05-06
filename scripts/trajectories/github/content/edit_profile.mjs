// Write the linked character's persona content (name + bio) onto the
// GitHub profile via /settings/profile.
//
// Companion to instagram/tiktok/linkedin/twitter edit_profile.
// Lives under github/content/ because github/actions/ is at the 5-file cap.

import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account in DB'); process.exit(1); }
console.log(`[gh-profile] using account: ${acct.username}`);

const linkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,niche,occupation,home_city,home_country,avatar_url,training_images)`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
).then(r => r.ok ? r.json() : []);
const character = linkRes?.[0]?.characters;
if (!character) { console.log(`FAIL: no character linked to github/${acct.username}`); process.exit(1); }
console.log(`[gh-profile] character: ${character.name} (niche=${character.niche})`);

const targetName = character.name || '';
const targetBio = (character.bio || '').slice(0, 160);
const targetLocation = [character.home_city, character.home_country].filter(Boolean).join(', ');
// Avatar source: avatar_url first; fall back to training_images[0] for the
// 74 chars that have training images but the avatar_url backfill migration
// hasn't merged yet. Path is either a /api/gcs-image proxy URL or absolute.
const rawAvatar = character.avatar_url || (Array.isArray(character.training_images) ? character.training_images[0] : null);
const avatarUrl = rawAvatar
  ? (rawAvatar.startsWith('http') ? rawAvatar : `https://content.wisent.ai${rawAvatar}`)
  : null;

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_edit_profile', proxy: proxyUrl, persona, browser: 'chromium' });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'github', label: 'github_edit_profile', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /github\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no github.com cookies', { platform: 'github' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://github.com/settings/profile', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(4500);
  if (/\/login/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('github', s, { label: 'github_edit_profile' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Form fields on /settings/profile (verified 2026-05-06 via
  // .work/gh-probe/dump_form.mjs):
  //   Name     → input#user_display_name (name="user[display_name]")
  //   Bio      → textarea#user_profile_bio
  //   Location → input#user_profile_location
  // Earlier trajectory used input#user_profile_name which doesn't exist —
  // that's why the 22:51Z run wrote bio but skipped name.
  const nameIn = s.page.locator('input#user_display_name, input[name="user\\[display_name\\]"]').filter({ visible: true }).first();
  const bioIn = s.page.locator('textarea#user_profile_bio, textarea[name="user[profile_bio]"]').filter({ visible: true }).first();
  const locIn = s.page.locator('input#user_profile_location, input[name="user[profile_location]"]').filter({ visible: true }).first();

  const writes = [];
  for (const [el, target, label] of [[nameIn, targetName, 'name'], [bioIn, targetBio, 'bio'], [locIn, targetLocation, 'location']]) {
    if (!target || !(await el.count())) continue;
    const cur = await el.inputValue().catch(() => '');
    if (cur.trim() === target.trim()) continue;
    await humanClickLocator(s.page, el);
    await s.page.keyboard.press('Meta+A').catch(() => {});
    await s.page.keyboard.press('Control+A').catch(() => {});
    await s.page.keyboard.press('Backspace').catch(() => {});
    await humanType(s.page, target);
    writes.push(`${label} "${cur}" -> "${target}"`);
  }

  // Avatar upload — github wraps the file input in a <file-attachment>
  // custom element that drives a 3-step alambic upload (POST policy →
  // S3 PUT → form submit). setInputFiles alone doesn't trigger the
  // custom element's change handler reliably. Construct a real File
  // via page.evaluate + dispatch change so file-attachment fires.
  if (avatarUrl) {
    try {
      const editSummary = s.page.locator('form[aria-label="Profile picture"] summary, details summary:has-text("Edit")').filter({ visible: true }).first();
      if (await editSummary.count()) {
        await humanClickLocator(s.page, editSummary);
        await s.page.waitForTimeout(1500);
      }
      const resp = await s.page.context().request.get(avatarUrl);
      if (!resp.ok()) {
        console.log(`[gh-profile] avatar fetch failed: ${resp.status()}`);
      } else {
        const buf = await resp.body();
        const base64 = buf.toString('base64');
        const fileIn = s.page.locator('input#avatar_upload').first();
        if (await fileIn.count()) {
          // Use page.evaluate to construct a real File and assign + dispatch.
          await s.page.evaluate(({ b64, name }) => {
            const input = document.querySelector('#avatar_upload');
            if (!input) return;
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const file = new File([arr], name, { type: 'image/png' });
            const dt = new DataTransfer();
            dt.items.add(file);
            (input).files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }, { b64: base64, name: `${acct.username}_avatar.png` });
          await s.page.waitForTimeout(4000);
          // After file-attachment finishes its upload, "Set new profile
          // picture" appears.
          const setBtn = s.page.locator('button:has-text("Set new profile picture")').filter({ visible: true }).first();
          if (await setBtn.isVisible().catch(() => false)) {
            await humanClickLocator(s.page, setBtn);
            await s.page.waitForTimeout(4000);
            writes.push(`avatar uploaded`);
          } else {
            console.log('[gh-profile] file dispatched but no "Set new profile picture" surfaced');
          }
        } else {
          console.log('[gh-profile] avatar_upload input not found in DOM');
        }
      }
    } catch (e) { console.log(`[gh-profile] avatar upload err: ${e.message?.slice(0, 120)}`); }
  }

  // Mirror to social_accounts even on no-op so the DB row catches up to the
  // platform side regardless of whether this run wrote anything to the form.
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${acct.id}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      display_name: targetName || null,
      profile_url: `https://github.com/${acct.username}`,
      updated_at: new Date().toISOString(),
    }),
  }).catch((e) => console.log(`[gh-profile] db-sync warn: ${e.message?.slice(0, 80)}`));

  if (!writes.length) { console.log('PASS: no-op (form values already match character; DB synced)'); process.exit(0); }
  console.log(`[gh-profile] writes: ${writes.join('; ')}`);

  // Submit: button[type="submit"] reading "Update profile".
  const saveBtn = s.page.locator('button[type="submit"]:has-text("Update profile"), input[value="Update profile"]').filter({ visible: true }).first();
  await saveBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, saveBtn);
  await s.page.waitForTimeout(4000);

  // Verify by reading the form back (the page reloads on save).
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
