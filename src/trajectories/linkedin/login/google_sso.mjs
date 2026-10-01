import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { pageSettled } from '../../_shared/page/settled.mjs';

/** The Google SSO credentials for one email, or false when the vault holds none. */
async function ssoCredentials(email) {
  try {
    return await getGoogleSsoCreds(email);
  } catch (e) {
    console.log(`[linkedin_login] no Google SSO credentials for ${email ?? 'the default account'}: ${e.message?.slice(0, 120)}`);
    return false;
  }
}

/** The largest visible "Sign in with Google" button among the gsi frames of the settled page, or false. */
async function findGoogleButton(page) {
  await pageSettled(page);
  const candidates = [];
  for (const frame of page.frames().filter((f) => /accounts\.google\.com\/gsi\/button|\/gsi\/button/.test(f.url()))) {
    const btn = frame.locator('div[role="button"], button').filter({ visible: true }).first();
    if (!(await btn.isVisible())) continue;
    const box = await btn.boundingBox();
    if (box && box.width >= 20 && box.height >= 20) candidates.push({ frame, btn, area: box.width * box.height });
  }
  candidates.sort((a, b) => b.area - a.area);
  return candidates[0] ?? false;
}

/** Keep the page text and a screenshot beside the run when the SSO surface is missing. */
async function keepEvidence(page, dir, name) {
  writeFileSync(join(dir, `${name}.txt`), await page.evaluate(() => document.body?.innerText || '').catch((e) => `unreadable: ${e.message}`));
  try {
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  } catch (e) {
    console.log(`[linkedin_login] ${name} screenshot not captured: ${e.message?.slice(0, 120)}`);
  }
}

/**
 * Sign in through LinkedIn's "Continue with Google" button: find the gsi
 * frame button, open the OAuth surface it spawns, run the shared Google SSO
 * flow on it, then wait for li_at or a feed URL.
 */
export async function loginWithGoogleSso(s, acct) {
  const requestedGoogleEmail = process.env.LINKEDIN_GOOGLE_SSO_EMAIL || process.env.SVC_EMAIL || acct.metadata?.email || acct.username;
  let login = await ssoCredentials(requestedGoogleEmail);
  if (!login) login = await ssoCredentials();
  if (!login) throw new Error(`google_sso_creds_missing:${requestedGoogleEmail}`);
  console.log(`[linkedin_login] using Google SSO account ${login.email}`);

  const dir = runRecordingsDir('linkedin_login');
  mkdirSync(dir, { recursive: true });
  const best = await findGoogleButton(s.page);
  if (!best) {
    await keepEvidence(s.page, dir, 'google_sso_missing_button');
    throw new Error('google_sso_button_not_found');
  }
  await keepEvidence(s.page, dir, 'google_sso_before_click');
  try { writeFileSync(join(dir, 'google_sso_frame.html'), await best.frame.content()); } catch {}

  // The Google surface is the popup or new tab the click opens; the sign-in
  // is over when LinkedIn sets li_at or shows a signed-in page.
  const opened = Promise.any([s.page.waitForEvent('popup'), s.page.context().waitForEvent('page')]);
  try {
    await humanClickLocator(s.page, best.btn);
  } catch (e) {
    console.log(`[linkedin_login] frame button click failed, clicking it once more: ${e.message?.slice(0, 120)}`);
    await humanClickLocator(s.page, best.btn);
  }
  const oauthPage = await opened;
  await oauthPage.waitForURL((url) => /accounts\.google\.com/.test(String(url)));

  const ok = await googleSso(s, login, { originHost: 'linkedin.com', page: oauthPage });
  if (!ok) throw new Error('google_sso_flow_failed');

  await s.page.waitForURL((url) => /\/feed|\/in\/|\/m\/feed|\/onboarding/.test(String(url)));
}
