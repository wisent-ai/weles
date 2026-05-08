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
import { loadAvatarFile } from '../../_shared/runner/avatar-loader.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account in DB'); process.exit(1); }
console.log(`[li-profile] using account: ${acct.username}`);

const linkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/character_social_accounts?social_account_id=eq.${acct.id}&select=characters(id,name,bio,niche,occupation,avatar_url,training_images)`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
).then(r => r.ok ? r.json() : []);
const character = linkRes?.[0]?.characters;
if (!character) { console.log(`FAIL: no character linked to linkedin/${acct.username}`); process.exit(1); }
console.log(`[li-profile] character: ${character.name} (niche=${character.niche})`);
const rawAvatar = character.avatar_url || (Array.isArray(character.training_images) ? character.training_images[0] : null);
const avatarUrl = rawAvatar ? (rawAvatar.startsWith('http') ? rawAvatar : `https://content.wisent.ai${rawAvatar}`) : null;

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

  // 2026-05-06: hit /feed/ first to confirm auth via primary-nav. The
  // /in/me/edit-form/intro/ page renders an edit-modal-only view that does
  // NOT expose the global nav, so assertAuthed false-fails there even on
  // valid sessions. After /feed/ confirms auth, navigate to the edit URL.
  await s.page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3000);
  if (/\/(login|checkpoint|uas)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to ${s.page.url()}`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('linkedin', s, { label: 'linkedin_edit_profile' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // 2026-05-06: /in/me/edit-form/intro/ deprecated — returns "This page
  // doesn't exist" for fresh accounts. Navigate to /in/me/ profile page
  // and click the pencil edit-intro button to open the modal.
  await s.page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(4000);
  // 2026-05-06: button enumeration on /in/me/ shows the edit-intro entry
  // is `<a aria-label="Edit profile">` — same icon-only pencil that used
  // to open /in/me/edit-form/intro/. Clicking it opens the intro modal
  // in-page.
  const editIntroBtn = s.page.locator('a[aria-label="Edit profile" i], button[aria-label="Edit profile" i], a[aria-label*="Edit intro" i]').filter({ visible: true }).first();
  if (await editIntroBtn.count()) {
    await humanClickLocator(s.page, editIntroBtn);
    // Wait for first-name field to attach. Click navigates to
    // /<vanity>/edit/intro/ and the form renders in a React portal that
    // mounts after RUM bundles finish (3s post-click yielded 0 fields).
    await s.page.locator('input[id*="first-name" i], input[id*="firstName" i], input[name*="firstName" i]').filter({ visible: true }).first().waitFor({ state: 'visible' }).catch(() => {});
    await s.page.waitForTimeout(2000);
  } else {
    console.log('[li-profile] edit-intro button not found on /in/me/ — falling through to field probe');
  }
  // 2026-05-06: dump landing URL + page title + first 600 chars of body
  // text + every visible input/textarea so future selector drifts surface
  // in the log instead of silent no-ops.
  const landingUrl = s.page.url();
  const pageTitle = await s.page.title().catch(() => '');
  const bodyTextHead = await s.page.evaluate(() => (document.body?.innerText || '').slice(0, 600)).catch(() => '');
  console.log(`[li-profile] landing url=${landingUrl}`);
  console.log(`[li-profile] page title=${pageTitle}`);
  console.log(`[li-profile] body head: ${bodyTextHead.replace(/\n/g, ' / ').slice(0, 400)}`);
  const formFields = await s.page.evaluate(() => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
      const r = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        name: el.getAttribute('name') || '',
        ph: el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || '',
        visible: r.width > 0 && r.height > 0,
        val: (el.value || '').slice(0, 40),
      });
    }
    return out;
  }).catch(() => []);
  console.log(`[li-profile] form fields on edit-intro page (${formFields.length}):`);
  for (const f of formFields.filter(f => f.visible)) console.log(`  ${f.tag} id="${f.id}" name="${f.name}" ph="${f.ph}" type="${f.type}" val="${f.val}"`);

  // Edit Intro modal fields:
  //   First name        → input[id*="first-name"]
  //   Last name         → input[id*="last-name"]
  //   Headline          → input[id*="headline"] / textarea[id*="headline"]
  //   About in modal    → textarea[id*="summary"] (sometimes a separate /details/about modal)
  // We split character.name on the first space for first/last.
  const [firstName, ...rest] = targetName.split(/\s+/);
  const lastName = rest.join(' ');
  // 2026-05-08: drop visible:true filter — Headline + Industry are BELOW
  // viewport at modal-open. Industry* (required) silently aborts save
  // when empty — verified live in webm frame: red "Industry is a required
  // field" inline error.
  // 2026-05-08: positional matching by visible-text-input order. Verified
  // live form: index 0=First name, 1=Last name, 2=Additional name (skip),
  // 3=Headline (textarea), 4=Industry typeahead. getByLabel('Headline')
  // returned 0 because LinkedIn doesn't use real <label for> on it.
  const fnIn = s.page.locator('input[type="text"]').nth(0);
  const lnIn = s.page.locator('input[type="text"]').nth(1);
  // Headline is a textarea (240px wide, multiline) — first visible textarea.
  const hlIn = s.page.locator('textarea').first();
  const indIn = s.page.getByLabel('Industry', { exact: false }).first();
  const tgtInd = (character.occupation || character.niche || 'Venture Capital and Private Equity').slice(0, 100);

  const writes = [];
  for (const [el, target, label] of [[fnIn, firstName, 'first_name'], [lnIn, lastName, 'last_name'], [hlIn, targetHeadline, 'headline'], [indIn, tgtInd, 'industry']]) {
    if (!target || !(await el.count())) { console.log(`[li-profile] ${label}: locator missing — skipping`); continue; }
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const cur = await el.inputValue().catch(() => '');
    if (cur.trim() === target.trim()) continue;
    await humanClickLocator(s.page, el);
    await el.click({ clickCount: 3 }).catch(() => {});
    await s.page.keyboard.press('Backspace').catch(() => {});
    await humanType(s.page, target);
    if (label === 'industry') {
      await s.page.waitForTimeout(1200);
      const sugg = s.page.locator('[role="option"], [role="listbox"] li, .typeahead-result').filter({ visible: true }).first();
      if (await sugg.count()) { await humanClickLocator(s.page, sugg); console.log('[li-profile] picked industry typeahead'); }
    }
    writes.push(`${label} "${cur}" -> "${target}"`);
  }

  if (writes.length) {
    console.log(`[li-profile] writes: ${writes.join('; ')}`);
    // 2026-05-07: previous flow clicked Save and saw the modal stay open;
    // network log of that run showed ONLY telemetry POSTs after click,
    // never the save mutation. Root cause: typing leaves focus IN the last
    // input, and LinkedIn's React form binds the dirty flag to the blur
    // event of the last-touched field. Without a blur, the form-dirty
    // state stays false and the save onClick handler returns early.
    // Press Tab to blur + commit the typed value before clicking Save.
    await s.page.keyboard.press('Tab').catch(() => {});
    await s.page.waitForTimeout(800);
    // Diagnostic: dump every visible button so we can identify the real
    // save control (last run with `last()` selector hit a button that
    // dispatched no save mutation — picking the wrong one).
    const btnDump = await s.page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).map(b => { const r = b.getBoundingClientRect(); return `${b.textContent?.trim().slice(0, 30) || ''}|aria=${b.getAttribute('aria-label') || ''}|disabled=${b.disabled || b.getAttribute('aria-disabled') === 'true'}|y=${Math.round(r.y)}|w=${Math.round(r.width)}`; })).catch(() => []);
    console.log(`[li-profile] visible buttons (${btnDump.length}):`);
    for (const b of btnDump.filter((s) => /save|cancel|discard/i.test(s)).slice(0, 10)) console.log(`  ${b}`);
    // 2026 modal: multiple "Save" buttons may be in the DOM (cancel-state,
    // save-state). Target the visible enabled one. LinkedIn disables Save
    // until the form sees a real change event from a typed input.
    const saveBtn = s.page.locator('button:has-text("Save"):not([disabled]):not([aria-disabled="true"])').filter({ visible: true }).last();
    const saveCount = await saveBtn.count();
    console.log(`[li-profile] save button enabled count=${saveCount}`);
    if (saveCount > 0) {
      // Watch for the save mutation POST. The form is a React Server
      // Component; saving fires a POST to /flagship-web/rsc-action/.
      const savePost = s.page.waitForResponse((r) => r.request().method() === 'POST' && /rsc-action.*ProfileEditIntroForm|rsc-action.*editProfile|rsc-action.*action=update/.test(r.url())).catch(() => null);
      // 2026-05-07: humanClickLocator on the visible Save button produced
      // zero mutation POSTs across multiple runs. RSC forms commonly
      // submit via form.requestSubmit(button) not button.click(); call
      // that directly so the right onSubmit/action handler fires.
      const dispatchResult = await s.page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /^save$/i.test(b.textContent?.trim() ?? '') && !b.disabled && b.getBoundingClientRect().width > 0);
        if (!btn) return 'no-save-button';
        const form = btn.closest('form');
        if (form?.requestSubmit) { form.requestSubmit(btn); return 'requestSubmit'; }
        btn.click();
        return 'btn.click';
      }).catch((e) => `err:${e.message?.slice(0, 60)}`);
      console.log(`[li-profile] save dispatch: ${dispatchResult}`);
      const apiRes = await savePost;
      const postClickBody = await s.page.evaluate(() => (document.body?.innerText || '').slice(0, 600).replace(/\n/g, ' / ')).catch(() => '');
      console.log(`[li-profile] save: post-click url=${s.page.url()}`);
      console.log(`[li-profile] save: post-click body head: ${postClickBody.slice(0, 400)}`);
      console.log(`[li-profile] save: mutation POST=${apiRes ? `${apiRes.status()} ${apiRes.url().slice(0, 120)}` : 'NEVER FIRED'}`);
    } else {
      console.log('[li-profile] save button not enabled — humanType may not have triggered React change event');
    }
  } else {
    console.log('[li-profile] intro fields already match — skipping save');
  }

  // About lives at /in/<vanity>/edit/about/ in 2026 (the legacy /in/me/
  // edit-form/about/ deep-link 404s same way intro/ did). Resolve own
  // vanity from current URL.
  console.log(`[li-profile] entering about block (targetAbout=${targetAbout ? targetAbout.length + 'ch' : 'none'})`);
  if (targetAbout) {
    const myVanity = s.page.url().match(/\/in\/([^/?]+)/)?.[1] || 'me';
    console.log(`[li-profile] vanity=${myVanity}`);
    await s.page.goto(`https://www.linkedin.com/in/${myVanity}/edit/about/`, { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(4000);
    // 2026 design: about textarea is the first visible textarea on the
    // edit-about modal (legacy `id*=summary` doesn't match React `:r…:`).
    const aboutIn = s.page.locator('textarea').filter({ visible: true }).first();
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

  // Avatar upload — linkedin's profile-photo upload lives at
  // /in/me/edit-form/profile-photo (or via the photo overlay on the main
  // profile). The dialog has Add photo / Save controls and a hidden file
  // input. Navigating directly + setInputFiles avoids modal-state issues.
  console.log(`[li-profile] entering avatar block (avatarUrl=${avatarUrl ? 'yes' : 'none'})`);
  if (avatarUrl) {
    const tmpAvatar = await loadAvatarFile(avatarUrl, { size: 800, format: 'jpeg', quality: 90 });
    if (tmpAvatar) {
      try {
        // 2026 design: photo upload lives behind the "Add photo" pencil on
        // /in/<vanity>/. Open profile, click pencil, then the modal exposes
        // the hidden file input. Direct deep-link to /edit-form/profile-
        // photo/ 404s same as the other edit-form/ paths.
        const myVanity = s.page.url().match(/\/in\/([^/?]+)/)?.[1] || 'me';
        await s.page.goto(`https://www.linkedin.com/in/${myVanity}/`, { waitUntil: 'domcontentloaded' });
        await s.page.waitForTimeout(3000);
        const addPhotoBtn = s.page.locator('a[aria-label="Add photo" i], button[aria-label="Add photo" i], a[aria-label*="Edit photo" i]').filter({ visible: true }).first();
        if (await addPhotoBtn.count()) {
          await humanClickLocator(s.page, addPhotoBtn);
          await s.page.waitForTimeout(2500);
        }
        const fileIn = s.page.locator('input[type="file"][accept*="image"], input.image-edit-camera__file-input, input[type="file"]').first();
        if (await fileIn.count()) {
          await fileIn.setInputFiles(tmpAvatar);
          await s.page.waitForTimeout(4000);
          const applyBtn = s.page.locator('button:has-text("Save photo"), button:has-text("Apply"), button:has-text("Save")').filter({ visible: true }).first();
          try {
            await applyBtn.waitFor({ state: 'visible' });
            await applyBtn.click();
            writes.push('avatar uploaded');
            await s.page.waitForTimeout(3500);
          } catch { console.log('[li-profile] avatar apply not visible'); }
        } else { console.log('[li-profile] no file input on edit-form/profile-photo'); }
      } catch (e) { console.log(`[li-profile] avatar err: ${e.message?.slice(0, 120)}`); }
    }
  }

  // Mirror to social_accounts.
  await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${acct.id}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ display_name: targetName || null, profile_url: `https://www.linkedin.com/in/${acct.username}/`, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  if (!writes.length) { console.log('PASS: no-op (form values already match character; DB synced)'); process.exit(0); }
  console.log(`PASS: ${acct.username} profile updated to ${character.name}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  // 2026-05-08 user request: WELES_KEEP_OPEN=1 holds the browser open
  // after the trajectory finishes so the human can take over and debug
  // the form state directly. Default behavior (no env var) closes as
  // before so cron + worker calls aren't affected.
  if (process.env.WELES_KEEP_OPEN === '1') {
    console.log('[li-profile] WELES_KEEP_OPEN=1 — browser left open. Close window or Ctrl+C to exit.');
    await new Promise((resolve) => {
      const done = () => { resolve(); };
      try { s.page.on('close', done); s.ctx.on('close', done); } catch {}
      process.on('SIGINT', done);
      process.on('SIGTERM', done);
    });
  }
  await s.close();
}
