// Landing on the right Google account: identifier navigation, the account switch and the sign-in.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { googleSso } from '../../../../_shared/services/google_sso.mjs';
import { EMAIL, NAV_TIMEOUT_MS, redact } from './settings.mjs';
import { currentBodyText } from './page.mjs';

export async function navigateIdentifier(page, email, continueUrl = 'https://myaccount.google.com/security') {
  const login = new URL('https://accounts.google.com/signin/v2/identifier');
  login.searchParams.set('continue', continueUrl);
  login.searchParams.set('flowName', 'GlifWebSignIn');
  login.searchParams.set('flowEntry', 'ServiceLogin');
  login.searchParams.set('Email', email);
  await page.goto(login.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
    console.log(`[google-totp-activate] WARN identifier navigation failed ${String(error?.message || error).slice(0, 240)}`);
  });
  await humanIdlePause('deliberate');
}

export async function currentGoogleAccountEmail(page) {
  return await page.evaluate(() => {
    const values = Array.from(document.querySelectorAll('[aria-label], a, button'))
      .map((el) => `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`);
    for (const value of values) {
      const match = value.match(/Google Account:[\\s\\S]*?\\(([^)\\s]+@[^)\\s]+)\\)/i);
      if (match) return match[1];
    }
    return '';
  }).catch(() => '');
}

export async function switchToCorrectGoogleAccount(s, creds, continueUrl = 'https://myaccount.google.com/security') {
  const wanted = (creds.email || EMAIL).toLowerCase();
  const currentEmail = (await currentGoogleAccountEmail(s.page)).toLowerCase();
  if (currentEmail === wanted) return true;
  if ((s.page.url?.() || '').includes('myaccount.google.com/u/1/')) return true;

  console.log(`[google-totp-activate] switching Google account current=${currentEmail || 'unknown'} target=${wanted}`);
  const chooser = new URL('https://accounts.google.com/AccountChooser');
  chooser.searchParams.set('Email', creds.email || EMAIL);
  chooser.searchParams.set('continue', continueUrl);
  await s.page.goto(chooser.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
    console.log(`[google-totp-activate] WARN account chooser navigation failed ${String(error?.message || error).slice(0, 240)}`);
  });
  await s.wait(5);
  const preferred = s.page.getByText(creds.email || EMAIL, { exact: false }).filter({ visible: true }).first();
  if (await preferred.isVisible().catch(() => false)) {
    console.log(`[google-totp-activate] selecting account ${creds.email || EMAIL}`);
    const account = s.page.locator('div[role="link"], li, [data-identifier], [data-email]').filter({ hasText: creds.email || EMAIL }).filter({ visible: true }).first();
    const clicked = await humanClickLocator(s.page, account).then(() => true).catch(() => false);
    if (!clicked) await humanClickLocator(s.page, preferred);
    await humanIdlePause('deliberate');
    for (let i = 0; i < 20; i++) {
      if (!/accountchooser/i.test(s.page.url?.() || '')) break;
      await humanIdlePause('short');
    }
  }
  if (/accountchooser/i.test(s.page.url?.() || '')) {
    const direct = continueUrl.replace('https://myaccount.google.com/', 'https://myaccount.google.com/u/1/');
    await s.page.goto(direct, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-totp-activate] WARN direct u/1 navigation failed ${String(error?.message || error).slice(0, 240)}`);
    });
    await s.wait(5);
  }

  if (/accounts\.google\.com/.test(s.page.url?.() || '')) {
    const ok = await googleSso(s, { ...creds, totpSecret: '' }, { originHost: 'myaccount.google.com' });
    if (!ok) return false;
  }
  if ((s.page.url?.() || '').includes('myaccount.google.com/u/1/')) return true;

  for (let i = 0; i < 20; i++) {
    const afterEmail = (await currentGoogleAccountEmail(s.page)).toLowerCase();
    if (afterEmail === wanted) return true;
    if ((s.page.url?.() || '').includes('myaccount.google.com/u/1/')) return true;
    await humanIdlePause('short');
  }
  return (await currentGoogleAccountEmail(s.page)).toLowerCase() === wanted;
}

export async function ensureSignedIn(s, creds) {
  if (/accounts\.google\.com/.test(s.page.url?.() || '')) {
    await navigateIdentifier(s.page, creds.email || EMAIL);
    if (!/accounts\.google\.com/.test(s.page.url?.() || '')) return true;
    const ok = await googleSso(s, { ...creds, totpSecret: '' }, { originHost: 'myaccount.google.com' });
    return ok;
  }
  const text = await currentBodyText(s.page);
  if (/Sign in|Use your Google Account|Choose an account/i.test(text) && /accounts\.google\.com/.test(s.page.url?.() || '')) {
    await navigateIdentifier(s.page, creds.email || EMAIL);
    if (!/accounts\.google\.com/.test(s.page.url?.() || '')) return true;
    const ok = await googleSso(s, { ...creds, totpSecret: '' }, { originHost: 'myaccount.google.com' });
    return ok;
  }
  return true;
}

export async function classifyGoogleAuthBlock(page, secret = '') {
  const url = page.url?.() || '';
  const text = await currentBodyText(page);
  let blocked = 'google_account_switch_failed';
  if (/signin\/challenge\/totp/i.test(url) && /Wrong code|Try again|Invalid code/i.test(text)) {
    blocked = 'active_google_authenticator_secret_mismatch';
  } else if (/signin\/challenge\/totp/i.test(url)) {
    blocked = 'google_authenticator_challenge_unresolved';
  } else if (/signin\/challenge\/dp/i.test(url)) {
    blocked = 'google_device_prompt_required';
  } else if (/signin\/challenge\/selection/i.test(url)) {
    blocked = 'google_second_factor_required';
  }
  return {
    blocked,
    url,
    activeEmail: await currentGoogleAccountEmail(page),
    textPreview: redact(text.slice(0, 1600), secret),
  };

}
