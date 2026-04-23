import { WSession } from '../../../dist/session/wsession.js';
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { injectPHCookies, loginViaTwitter } from './_session.mjs';

// Fill a Product Hunt user profile (headline, about, location, website).

const EDIT_URL = 'https://www.producthunt.com/my/details/edit';
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

const HEADLINE = process.env.PH_HEADLINE || 'Indie hacker exploring product-led growth';
const ABOUT = process.env.PH_BIO || 'Building, breaking, and shipping side projects. Always curious about what makes products spread.';
const LOCATION = process.env.PH_LOCATION || 'Remote';
const WEBSITE = process.env.PH_WEBSITE || '';

async function fillProfile(s, acct) {
  const cookies = acct.metadata?.cookies ?? [];
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
const s = await WSession.start({ label: 'producthunt_profile', ...sessionOpts });
try {
  await fillProfile(s, acct);
  console.log(`PASS: ${acct.username} profile saved`);
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
