// Probe Google 2-Step Verification setup for the Google Ads account.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { readScopedLogin } from '../../../_shared/scoped-secrets.mjs';
import { assertGoogleAdsProfileNotAlreadyOpen, closeAllowedByEnv } from './_profile_guard.mjs';
const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
const DIAG_DIR = process.env.GOOGLE_MFA_DIAG_DIR || '.work/google-mfa-setup';
mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1440x1000';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

async function diag(page, label) {
  const data = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 5000);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .map((el) => ({
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        href: el.href || '',
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      }))
      .filter((x) => x.text || x.href)
      .slice(0, 120);
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((el) => ({
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      }))
      .slice(0, 80);
    return { url: location.href, title: document.title, text, buttons, inputs };
  }).catch((e) => ({ error: e.message, url: page.url?.() ?? '' }));
  const jsonPath = join(DIAG_DIR, `${label}.json`);
  const shotPath = join(DIAG_DIR, `${label}.png`);
  writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
  console.log(`[google-mfa-setup] ${label} json=${jsonPath} screenshot=${shotPath}`);
  console.log(JSON.stringify({
    url: data.url,
    title: data.title,
    buttons: data.buttons?.slice?.(0, 30),
    inputs: data.inputs?.filter?.((i) => i.visible).slice(0, 20),
    text: data.text?.slice?.(0, 1600),
  }, null, 2));
  return data;
}

async function clickVisible(page, pattern, label) {
  const loc = page.getByText(pattern).filter({ visible: true }).first();
  if (await loc.isVisible().catch(() => false)) {
    await humanClickLocator(page, loc);
    console.log(`[google-mfa-setup] clicked ${label}`);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function clickButton(page, pattern, label) {
  const roleButton = page.getByRole('button', { name: pattern }).filter({ visible: true }).first();
  if (await roleButton.isVisible().catch(() => false)) {
    await humanClickLocator(page, roleButton);
    console.log(`[google-mfa-setup] clicked button ${label}`);
    await humanIdlePause('deliberate');
    return true;
  }
  return clickVisible(page, pattern, label);
}

async function loadPassword() {
  return GOOGLE_ADS_LOGIN.password;
}

async function handleReauth(page) {
  if (await clickVisible(page, /^Try another way$/i, 'try another way')) {
    await humanIdlePause('deliberate');
  }
  if (await clickVisible(page, /^Enter your password$/i, 'enter password')) {
    await humanIdlePause('deliberate');
  }
  const password = await loadPassword();
  const passwordInput = page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).first();
  if (password && await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(password);
    const next = page.locator('#passwordNext button, button:has-text("Next")').filter({ visible: true }).first();
    await humanClickLocator(page, next);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

assertGoogleAdsProfileNotAlreadyOpen(USER_DATA_DIR, 'google_ads_mfa_setup');
const s = await WSession.start({
  label: 'google_ads_mfa_setup',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
});

try {
  await s.goto('https://ads.google.com/nav/multifactorauthalert');
  await s.wait(8);
  const alertState = await diag(s.page, 'ads_mfa_alert');
  const setupHref = alertState.buttons?.find?.((button) => /Set up 2-Step Verification/i.test(button.text || ''))?.href;
  if (setupHref) {
    await s.goto(setupHref);
  } else {
    await clickVisible(s.page, /Set up 2-Step Verification/i, 'set up 2-step');
  }
  await s.wait(8);
  await diag(s.page, 'setup_landing');
  await handleReauth(s.page);
  await s.wait(8);
  await diag(s.page, 'after_reauth');
  await clickButton(s.page, /^Get started$|^Turn on 2-Step Verification$|^Get started with 2-Step Verification$/i, 'turn on 2-step');
  await s.wait(8);
  const state = await diag(s.page, 'after_get_started');
  if (/2-Step Verification is on|turned on|You’re protected|You're protected/i.test(state.text || '')
    || !/Turn on 2-Step Verification/i.test(state.text || '')) {
    console.log('PASS: Google 2-Step Verification enabled or no longer shows the turn-on gate');
  } else if (/Authenticator|verification app|QR code|setup key|secret key/i.test(state.text || '')) {
    console.log('FAIL: Google 2-Step Verification setup page is reachable but the turn-on gate remains visible');
    process.exit(4);
  } else if (/phone|text message|Google prompt|security key|passkey|Try another way|Choose another option/i.test(state.text || '')) {
    console.log('FAIL: Google 2-Step setup requires an external verification method on this account');
    process.exit(2);
  } else {
    console.log('FAIL: Google 2-Step setup state not recognized');
    process.exit(3);
  }
} finally {
  if (closeAllowedByEnv('GOOGLE_MFA_SETUP_CLOSE_AFTER')) await s.close().catch(() => {});
  else console.log('[google-ads-mfa-setup] leaving Google Ads profile open');
}
