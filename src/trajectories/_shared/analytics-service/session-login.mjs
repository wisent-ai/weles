import { readScopedLogin } from '../../../_shared/scoped-secrets.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { googleSso, getGoogleSsoCreds } from '../services/google_sso.mjs';
import { UMAMI_BASE, GA_BASE } from './action-catalog.mjs';
import { clickFirst, fillAny } from './page-interaction.mjs';

async function umamiLogin(s) {
  await s.goto(UMAMI_BASE);
  await humanIdlePause('deliberate');
  if (!/login|signin/i.test(s.page.url()) && !await s.page.locator('input[type="password"]').first().isVisible().catch(() => false)) return true;
  const scopedLogin = readScopedLogin('umamiDashboard');
  const login = { email: scopedLogin.email, password: scopedLogin.password, loginMethod: 'email_password' };
  await fillAny(s.page, login.email, [/email/i, /user/i]);
  await fillAny(s.page, login.password, [/password/i]);
  await clickFirst(s.page, [/^log in$/i, /^login$/i, /^sign in$/i, /^continue$/i]);
  for (let i = 0; i < 20; i++) {
    await humanIdlePause('short');
    if (!/login|signin/i.test(s.page.url())) return true;
  }
  const passwordInput = s.page.locator('input[type="password"], input[name="password"]').filter({ visible: true }).first();
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.press('Enter');
  }
  for (let i = 0; i < 40; i++) {
    await humanIdlePause('short');
    if (!/login|signin/i.test(s.page.url())) return true;
  }
  throw new Error(`Umami login did not leave login page: ${s.page.url()}`);
}

async function clickGoogleAccountIfVisible(page, email) {
  if (!email) return false;
  const tile = page.locator(`div[data-identifier="${email}"], [data-email="${email}"]`)
    .or(page.getByText(email, { exact: true })).filter({ visible: true }).first();
  if (await tile.isVisible().catch(() => false)) {
    await humanClickLocator(page, tile, { timeoutMs: 10000 });
    await humanIdlePause('long');
    return true;
  }
  return false;
}

async function googleAnalyticsLogin(s) {
  await s.goto(GA_BASE);
  await humanIdlePause('deliberate');
  let creds = await getServiceLogin('Google Analytics') ?? await getGoogleSsoCreds();
  if (!/accounts\.google\.com|ServiceLogin|signin/i.test(s.page.url())) {
    const signIn = s.page.getByRole('link', { name: /sign in/i }).or(s.page.getByRole('button', { name: /sign in/i })).first();
    if (await signIn.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, signIn, { timeoutMs: 10000 });
      await humanIdlePause('long');
    }
  }
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(s.page.url())) {
    if (!creds) throw new Error('no Google Analytics credentials: set service_credentials display_name=Google Analytics or shared Google SSO credentials');
    await clickGoogleAccountIfVisible(s.page, creds.email);
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(s.page.url())) {
      const ok = await googleSso(s, creds, { originHost: 'analytics.google.com' });
      if (!ok) throw new Error('Google Analytics SSO did not complete');
    }
  }
  for (let i = 0; i < 40; i++) {
    await humanIdlePause('short');
    if (/analytics\.google\.com/.test(s.page.url()) && !/accounts\.google\.com|signin/i.test(s.page.url())) return true;
  }
  return /analytics\.google\.com/.test(s.page.url());
}

async function ensureLoggedIn(s, cfg) {
  if (cfg.platform === 'umami') return umamiLogin(s);
  return googleAnalyticsLogin(s);
}

export {
  umamiLogin,
  clickGoogleAccountIfVisible,
  googleAnalyticsLogin,
  ensureLoggedIn,
};
