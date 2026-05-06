import { WSession } from '../../../dist/session/wsession.js';
import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { injectPHCookies, loginViaTwitter } from './_session.mjs';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

// Fill a Product Hunt user profile (headline, about, location, website).

const EDIT_URL = 'https://www.producthunt.com/my/details/edit';
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

const HEADLINE = process.env.PH_HEADLINE || 'Indie hacker exploring product-led growth';
const ABOUT = process.env.PH_BIO || 'Building, breaking, and shipping side projects. Always curious about what makes products spread.';
const LOCATION = process.env.PH_LOCATION || 'Remote';
const WEBSITE = process.env.PH_WEBSITE || '';

async function fillProfile(s, acct, sessionMeta) {
  // Cookie-jar freshness gate — see _shared/cookie-freshness.mjs. Skip
  // injection on stale; loginViaTwitter recovers below.
  let cookies = [];
  try {
    cookies = loadFreshCookieJarOrFail(acct, { platform: 'producthunt', label: 'producthunt_profile', currentProxyUrl: sessionMeta.proxyUrl, currentPersona: sessionMeta.persona });
  } catch (jarErr) {
    if (!(jarErr instanceof CookieJarStaleError)) throw jarErr;
    console.log(`[ph-profile] ${jarErr.message} — falling through to SSO recovery`);
    cookies = [];
  }
  if (cookies.length) {
    const inj = await injectPHCookies(s, cookies);
    console.log(`[ph-profile] injected ${inj} saved producthunt cookies`);
  }

  await s.goto(EDIT_URL);
  await sleep(4);

  let cur = s.page.url();
  console.log(`[ph-profile] initial nav: ${cur}`);
  if (cur.includes('/login') || cur.includes('/captcha_verification')) {
    await loginViaTwitter(s);
    await s.goto(EDIT_URL);
    await sleep(4);
    cur = s.page.url();
    if (cur.includes('/login') || cur.includes('/captcha_verification')) throw new Error('still_blocked_after_relogin');
  }

  // Positive auth probe — refuses to fill the profile form on a logged-out shell.
  try { await assertAuthed('producthunt', s, { label: 'producthunt_profile' }); }
  catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      try { await markCookiesStale(acct.id); } catch {}
      throw new Error(`auth_probe_failed: ${probeErr.message}`);
    }
    throw probeErr;
  }

  await s.page.waitForSelector('input[type="text"], textarea').catch(() => {});
  await sleep(3);

  // Use WSession's s.fill — humanType + smart target matching; drives one
  // field at a time against its name/placeholder/aria-label. No need for a
  // custom probe+fill when weles already has it.
  const tries = [
    ['headline', HEADLINE],
    ['about', ABOUT],
    ['bio', ABOUT],
    ['location', LOCATION],
    ...(WEBSITE ? [['website', WEBSITE]] : []),
  ];
  for (const [target, value] of tries) {
    const r = await s.fill(target, value).catch((e) => `err: ${e.message?.slice(0, 60)}`);
    console.log(`[ph-profile] fill ${target}: ${r}`);
    await sleep(1);
  }

  // Save — weles has no generic "submit form" method; use a vision click
  // on the save button.
  await s.click('Save').catch(() => {});
  await s.click('Save changes').catch(() => {});
  await sleep(5);
  return true;
}

const acct = await getSocialAccount('producthunt');
if (!acct) { console.log('FAIL: no_producthunt_account_in_db'); process.exit(1); }
console.log(`[ph-profile] using account: ${acct.username}`);

const sessionOpts = await resolveAccountSession(acct);
// Force chromium — see weles 8c7c20b / 2026-05-06 upvote run for the
// Firefox NS_ERROR_ABORT failure mode the PH action flow hits.
const s = await WSession.start({ label: 'producthunt_profile', ...sessionOpts, browser: 'chromium' });
try {
  await fillProfile(s, acct, sessionOpts);
  console.log(`PASS: ${acct.username} profile saved`);
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
