// Activate a Google Authenticator setup key for the Google Ads account.
// Uses Weles browser automation only; password and MFA material come from the dedicated Google Ads Skarbiec item.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { generateTotp, googleSso } from '../../_shared/services/google_sso.mjs';
import { assertGoogleAdsProfileNotAlreadyOpen, closeAllowedByEnv } from './_profile_guard.mjs';
import { readScopedLogin } from '../../../_shared/scoped-secrets.mjs';

const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
const EMAIL = GOOGLE_ADS_LOGIN.email;
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
const DIAG_DIR = process.env.GOOGLE_TOTP_ACTIVATION_DIAG_DIR || '.work/google-totp-activation';
const RESULT_FILE = process.env.GOOGLE_TOTP_ACTIVATION_RESULT_FILE || join(DIAG_DIR, 'result.json');
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60_000);

process.env.WELES_VIEWPORT ??= '1440x1000';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
process.env.GOOGLE_SSO_NO_SCREENSHOTS ??= '1';
mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });


function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function extractTotpSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^otpauth:\/\//i.test(text)) {
    try { return new URL(text).searchParams.get('secret') || ''; } catch { return ''; }
  }
  return text;
}

function normalizeSecret(secret) {
  return extractTotpSecret(secret).toUpperCase().replace(/[\s=-]/g, '');
}

function redact(value, secret = '') {
  const normalized = normalizeSecret(secret);
  const escaped = normalized ? normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  let text = String(value || '');
  if (escaped) text = text.replace(new RegExp(escaped, 'gi'), '<redacted-totp-secret>');
  text = text
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/"login_password"\s*:\s*"[^"]+"/g, '"login_password":"<redacted>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
  return text;
}

function visibleTextSelector() {
  return 'button, [role="button"], a, [role="link"], li, div[role="option"]';
}

async function diag(page, label, secret = '') {
  const data = await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], li, div[role="option"]'))
      .map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        text: norm(el.innerText || el.textContent || '').slice(0, 240),
        aria: el.getAttribute('aria-label') || '',
        href: el.href || '',
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      }))
      .filter((item) => item.text || item.aria || item.href)
      .slice(0, 160);
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((el) => ({
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        aria: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        valueLength: String(el.value || '').length,
      }))
      .slice(0, 80);
    return {
      url: location.href,
      title: document.title,
      text: norm(document.body?.innerText || '').slice(0, 5000),
      controls,
      inputs,
    };
  }).catch((error) => ({ url: page.url?.() || '', error: String(error?.message || error) }));
  const redacted = JSON.parse(redact(JSON.stringify(data), secret));
  const jsonPath = join(DIAG_DIR, `${label}.json`);
  writeFileSync(jsonPath, JSON.stringify(redacted, null, 2));
  console.log(`[google-totp-activate] ${label} json=${jsonPath}`);
  console.log(JSON.stringify({
    url: redacted.url,
    title: redacted.title,
    text: redacted.text?.slice?.(0, 1400),
    controls: redacted.controls?.slice?.(0, 30),
    inputs: redacted.inputs?.filter?.((input) => input.visible).slice(0, 20),
  }, null, 2));
  return data;
}

async function clickByText(page, pattern, label) {
  const role = page.getByRole('button', { name: pattern, exact: false })
    .or(page.getByRole('link', { name: pattern, exact: false }))
    .or(page.getByRole('option', { name: pattern, exact: false }))
    .filter({ visible: true })
    .first();
  if (await role.isVisible().catch(() => false)) {
    console.log(`[google-totp-activate] clicking ${label} via role`);
    await role.click({ force: true }).catch(() => humanClickLocator(page, role));
    await humanIdlePause('deliberate');
    return true;
  }

  const textual = page.locator(visibleTextSelector()).filter({ hasText: pattern }).filter({ visible: true }).first();
  if (await textual.isVisible().catch(() => false)) {
    console.log(`[google-totp-activate] clicking ${label} via text`);
    await textual.click({ force: true }).catch(() => humanClickLocator(page, textual));
    await humanIdlePause('deliberate');
    return true;
  }

  const fallback = page.locator('button, [role="button"], a, [role="link"], li, [role="option"]').filter({ hasText: pattern }).filter({ visible: true }).first();
  const clickedByJs = await humanClickLocator(page, fallback).then(() => true).catch(() => false);
  if (clickedByJs) {
    console.log(`[google-totp-activate] clicking ${label} via JS`);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function currentBodyText(page) {
  return await page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function navigateIdentifier(page, email, continueUrl = 'https://myaccount.google.com/security') {
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

async function currentGoogleAccountEmail(page) {
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

async function switchToCorrectGoogleAccount(s, creds, continueUrl = 'https://myaccount.google.com/security') {
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

async function ensureSignedIn(s, creds) {
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

async function classifyGoogleAuthBlock(page, secret = '') {
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

async function gotoAuthenticatorSettingsLink(s) {
  const href = await s.page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const link = links.find((el) => /\/two-step-verification\/authenticator/i.test(el.href || ''));
    return link?.href || '';
  }).catch(() => '');
  if (!href) return false;
  console.log(`[google-totp-activate] navigating authenticator settings href=${href.split('?')[0]}`);
  await s.page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
    console.log(`[google-totp-activate] WARN authenticator href navigation failed ${String(error?.message || error).slice(0, 240)}`);
  });
  await s.wait(6);
  return /two-step-verification\/authenticator/i.test(s.page.url?.() || '');
}

async function openAuthenticatorSetup(s, creds) {
  const urls = [
    'https://myaccount.google.com/u/1/two-step-verification/authenticator',
    'https://myaccount.google.com/u/1/signinoptions/two-step-verification',
    'https://myaccount.google.com/u/1/security',
    'https://myaccount.google.com/two-step-verification/authenticator',
    'https://myaccount.google.com/signinoptions/two-step-verification',
    'https://myaccount.google.com/security',
  ];
  for (const url of urls) {
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-totp-activate] WARN navigation failed ${url} ${String(error?.message || error).slice(0, 240)}`);
    });
    await s.wait(6);
    if (!await ensureSignedIn(s, creds)) return { ok: false, blocked: 'google_login_required_or_second_factor_required' };
    const text = await currentBodyText(s.page);
    const current = s.page.url?.() || '';
    if (!current.includes('myaccount.google.com/u/1/') && !await switchToCorrectGoogleAccount(s, creds, url)) return { ok: false, ...await classifyGoogleAuthBlock(s.page, creds.totpSecret) };
    if (/404\. That.?s an error|requested URL .* was not found/i.test(text)) continue;
    if (current.includes('myaccount.google.com') && /\/security(?:[?#]|$)/.test(current)) {
      if (await gotoAuthenticatorSettingsLink(s)) {
        const nextText = await currentBodyText(s.page);
        return { ok: true, url: s.page.url?.() || '', text: nextText };
      }
      if (await clickByText(s.page, /2-Step Verification|2-step verification/i, '2-Step Verification')) {
        await s.wait(6);
        const nextText = await currentBodyText(s.page);
        const nextUrl = s.page.url?.() || '';
        if (/Authenticator|verification app|2-Step Verification|2-step verification/i.test(nextText)) {
          return { ok: true, url: nextUrl, text: nextText };
        }
      }
      continue;
    }
    if (/two-step-verification\/authenticator|signinoptions\/two-step-verification/i.test(current)
      || /Change authenticator app|Your authenticator|Authenticator app/i.test(text)) {
      return { ok: true, url: current, text };
    }
  }
  return { ok: false, blocked: 'authenticator_setup_page_not_reached', url: s.page.url?.() || '', text: await currentBodyText(s.page) };
}

async function waitForCodeInput(page) {
  for (let i = 0; i < 40; i++) {
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!/Enter code|verification code|Authenticator app|scan/i.test(text)) {
      await humanIdlePause('short');
      continue;
    }
    const input = page.locator([
      'input[name="totpPin"]',
      'input[name="Pin"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      'input[type="tel"]',
      'input[type="number"]',
    ].join(', ')).filter({ visible: true }).first();
    if (await input.isVisible().catch(() => false)) return input;
    const textInput = page.locator('input[type="text"]').filter({ visible: true }).filter({ hasNotText: /Search/i }).first();
    if (await textInput.isVisible().catch(async () => false)) {
      const isSearch = await textInput.evaluate((el) => /search/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('autocomplete') || ''}`)).catch(() => true);
      if (!isSearch) return textInput;
    }
    await humanIdlePause('short');
  }
  return null;
}

async function waitForNewTotpCode(secret, previous = '') {
  let code = generateTotp(secret);
  if (!previous || code !== previous) return code;
  for (let i = 0; i < 35; i++) {
    await humanIdlePause('short');
    code = generateTotp(secret);
    if (code !== previous) return code;
  }
  return code;
}

async function activateAuthenticator(s, creds) {
  const secret = normalizeSecret(creds.totpSecret || creds.totp_secret || creds.google_totp_secret || '');
  if (!secret) return { ok: false, blocked: 'missing_totp_secret' };

  if (/Remove anyway/i.test(await currentBodyText(s.page))) {
    await clickByText(s.page, /^Cancel$/i, 'cancel remove authenticator warning');
    await s.wait(2);
  }


  await diag(s.page, 'setup_page_initial', secret);

  const actionPatterns = [
    /Change authenticator app/i,
    /Change Authenticator app/i,
    /Set up authenticator/i,
    /Set up Authenticator/i,
    /Add authenticator/i,
    /Add Authenticator/i,
    /Get started/i,
  ];
  for (const pattern of actionPatterns) {
    const before = s.page.url?.() || '';
    if (await clickByText(s.page, pattern, pattern.source)) {
      await s.wait(4);
      const text = await currentBodyText(s.page);
      if (/QR code|setup key|secret key|Enter the code|verification code|Authenticator/i.test(text) || (s.page.url?.() || '') !== before) break;
    }
  }

  await diag(s.page, 'after_setup_action', secret);

  for (const pattern of [/Can.?t scan it/i, /setup key/i, /Enter a setup key/i, /Next/i]) {
    const text = await currentBodyText(s.page);
    if (/Enter the code|verification code|code from/i.test(text)) break;
    await clickByText(s.page, pattern, pattern.source);
    await s.wait(3);
  }

  await diag(s.page, 'before_code_entry', secret);

  const input = await waitForCodeInput(s.page);
  if (!input) {
    return {
      ok: false,
      blocked: 'totp_activation_code_input_not_found',
      url: s.page.url?.() || '',
      textPreview: redact((await currentBodyText(s.page)).slice(0, 1600), secret),
    };
  }

  let lastCode = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await waitForNewTotpCode(secret, lastCode);
    lastCode = code;
    await humanFill(s.page, input, '').catch(() => {});
    await humanFill(s.page, input, code);
    console.log(`[google-totp-activate] filled activation code attempt=${attempt}`);
    await clickByText(s.page, /^(Next|Verify|Turn on|Done)$/i, 'submit activation code');
    await s.wait(8);
    const text = await currentBodyText(s.page);
    const url = s.page.url?.() || '';
    await diag(s.page, `after_code_submit_${attempt}`, secret);
    if (/Wrong code|Try again|Invalid code|Couldn't verify/i.test(text)) continue;
    if (/Authenticator app.*(added|set up|turned on)|2-Step Verification is on|You’re protected|Authenticator/i.test(text) && !/Enter the code|Wrong code|Try again|Invalid code/i.test(text)) {
      return { ok: true, activated: true, url };
    }
    if (!/accounts\.google\.com|myaccount\.google\.com/.test(url)) return { ok: true, activated: true, url };
  }

  return {
    ok: false,
    blocked: 'totp_activation_code_rejected',
    url: s.page.url?.() || '',
    textPreview: redact((await currentBodyText(s.page)).slice(0, 1600), secret),
  };
}

async function main() {

  const creds = GOOGLE_ADS_LOGIN;
  if (!creds?.password || !creds?.totpSecret) {
    const report = {
      ok: false,
      blocked: 'missing_google_ads_password_or_totp_secret',
      email: EMAIL,
      hasPassword: Boolean(creds?.password),
      hasTotpSecret: Boolean(creds?.totpSecret),
    };
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  assertGoogleAdsProfileNotAlreadyOpen(USER_DATA_DIR, 'google_totp_activate');
  const s = await WSession.start({
    label: 'google_totp_activate',
    browser: process.env.BROWSER || 'chromium',
    proxy: process.env.PROXY_URL || 'direct',
    persona: stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
    pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
  });

  try {
    const opened = await openAuthenticatorSetup(s, creds);
    if (!opened.ok) {
      await diag(s.page, 'open_failed', creds.totpSecret);
      const report = { ok: false, email: EMAIL, ...opened };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(3);
    }
    const activation = await activateAuthenticator(s, creds);
    const report = { email: EMAIL, ...activation, resultFile: RESULT_FILE };
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!activation.ok) process.exit(4);
    console.log('PASS: Google Authenticator TOTP setup activated');
  } finally {
    if (closeAllowedByEnv('GOOGLE_TOTP_ACTIVATION_CLOSE_AFTER')) await s.close().catch(() => {});
    else console.log('[google-totp-activate] leaving Google Ads profile open');
  }
}

main().catch((error) => {
  const report = {
    ok: false,
    blocked: 'google_totp_activation_error',
    email: EMAIL,
    error: redact(String(error?.message || error)),
  };
  writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
});
