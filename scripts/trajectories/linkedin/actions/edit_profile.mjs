// Write the linked character's persona content (name + headline + about)
// onto the LinkedIn profile via /in/me/edit-form/intro.
//
// Companion to instagram/tiktok edit_profile (commits b9be789 + b0f0239).

import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account in DB'); process.exit(1); }
console.log(`[li-profile] using account: ${acct.username}`);

const linkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,niche,occupation)`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
).then(r => r.ok ? r.json() : []);
const character = linkRes?.[0]?.characters;
if (!character) { console.log(`FAIL: no character linked to linkedin/${acct.username}`); process.exit(1); }
console.log(`[li-profile] character: ${character.name} (niche=${character.niche})`);

const targetName = character.name || '';
// Headline = occupation if present, else niche. Caps at 220 chars.
const targetHeadline = (character.occupation || character.niche || '').slice(0, 220);
// About is the long bio. Caps at 2600 chars.
const targetAbout = (character.bio || '').slice(0, 2600);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_edit_profile', proxy: proxyUrl, persona, browser: 'chromium' });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'linkedin', label: 'linkedin_edit_profile', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /linkedin\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no linkedin.com cookies', { platform: 'linkedin' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://www.linkedin.com/in/me/edit-form/intro/', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(5000);
  if (/\/(login|checkpoint|uas)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to ${s.page.url()}`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('linkedin', s, { label: 'linkedin_edit_profile' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Edit Intro modal fields:
  //   First name        → input[id*="first-name"]
  //   Last name         → input[id*="last-name"]
  //   Headline          → input[id*="headline"] / textarea[id*="headline"]
  //   About in modal    → textarea[id*="summary"] (sometimes a separate /details/about modal)
  // We split character.name on the first space for first/last.
  const [firstName, ...rest] = targetName.split(/\s+/);
  const lastName = rest.join(' ');
  const fnIn = s.page.locator('input[id*="first-name" i], input[id*="firstName" i]').filter({ visible: true }).first();
  const lnIn = s.page.locator('input[id*="last-name" i], input[id*="lastName" i]').filter({ visible: true }).first();
  const hlIn = s.page.locator('input[id*="headline" i], textarea[id*="headline" i]').filter({ visible: true }).first();

  const writes = [];
  for (const [el, target, label] of [[fnIn, firstName, 'first_name'], [lnIn, lastName, 'last_name'], [hlIn, targetHeadline, 'headline']]) {
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

  if (writes.length) {
    console.log(`[li-profile] writes: ${writes.join('; ')}`);
    const saveBtn = s.page.locator('button:has-text("Save")').filter({ visible: true }).first();
    await saveBtn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, saveBtn);
    await s.page.waitForTimeout(4500);
  } else {
    console.log('[li-profile] intro fields already match — skipping save');
  }

  // About lives in a separate modal at /in/me/edit-form/about — open it
  // and fill if needed. Navigate explicitly so we don't depend on click-
  // through-from-intro flow.
  if (targetAbout) {
    await s.page.goto('https://www.linkedin.com/in/me/edit-form/about/', { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(4000);
    const aboutIn = s.page.locator('textarea[id*="summary" i], textarea[id*="about" i]').filter({ visible: true }).first();
    if (await aboutIn.count()) {
      const cur = await aboutIn.inputValue().catch(() => '');
      if (cur.trim() !== targetAbout.trim()) {
        await humanClickLocator(s.page, aboutIn);
        await s.page.keyboard.press('Meta+A').catch(() => {});
        await s.page.keyboard.press('Control+A').catch(() => {});
        await s.page.keyboard.press('Backspace').catch(() => {});
        await humanType(s.page, targetAbout);
        const saveBtn = s.page.locator('button:has-text("Save")').filter({ visible: true }).first();
        await humanClickLocator(s.page, saveBtn);
        await s.page.waitForTimeout(4500);
        writes.push(`about (${cur.length} -> ${targetAbout.length} chars)`);
      }
    }
  }

  if (!writes.length) { console.log('PASS: no-op (form values already match character)'); process.exit(0); }
  console.log(`PASS: ${acct.username} profile updated to ${character.name}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
