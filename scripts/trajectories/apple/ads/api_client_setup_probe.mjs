// Apple Ads API client setup probe.
//
// Opens Apple Ads Account Settings/API, using the stored Apple social account
// when a fresh login is required. The first pass is diagnostic/read-mostly:
// it reports whether the API client form is reachable and captures page state.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { completeAppleNativeTwoFactorChallenge, DEFAULT_APPLE_2FA_CODE_FILE } from '../native_2fa/native_2fa.mjs';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'apple_ads');
const PUBLIC_KEY_PATH = process.env.ASC_ADS_PUBLIC_KEY_PATH || join(homedir(), '.apple-ads', 'public-key.pem');
const PRIVATE_KEY_PATH = process.env.ASC_ADS_PRIVATE_KEY_PATH || join(homedir(), '.apple-ads', 'private-key.pem');
const DIAG_DIR = process.env.APPLE_ADS_DIAG_DIR || '.work/apple-ads-api-setup';
const KEEP_OPEN_AFTER_LOGIN_MS = Number(process.env.APPLE_ADS_KEEP_OPEN_AFTER_LOGIN_MS || 0);
const CLOSE_AFTER_PROBE = process.env.APPLE_ADS_CLOSE_AFTER_PROBE === '1';
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

async function pageDiag(page, label) {
  const frameStates = await Promise.all(page.frames().map(async (frame) => {
    return await frame.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 5000);
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .map((b) => (b.innerText || b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 80);
      const inputs = Array.from(document.querySelectorAll('input, textarea'))
        .map((el) => ({
          tag: el.tagName,
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
          visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        }))
        .slice(0, 80);
      return { url: location.href, title: document.title, text, buttons, inputs };
    }).catch((e) => ({ error: e.message, url: frame.url?.() ?? '' }));
  }));
  const data = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 5000);
    const links = Array.from(document.querySelectorAll('a'))
      .map((a) => ({ text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(), href: a.href }))
      .filter((a) => a.text || a.href)
      .slice(0, 80);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((b) => (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 80);
    const inputs = Array.from(document.querySelectorAll('input, textarea'))
      .map((el) => ({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      }))
      .slice(0, 80);
    return { url: location.href, title: document.title, text, links, buttons, inputs };
  }).catch((e) => ({ error: e.message, url: page.url?.() ?? '' }));
  data.frames = frameStates;
  const outPath = join(DIAG_DIR, `${label}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`[apple-ads-api-setup] ${label} json=${outPath}`);
  console.log(JSON.stringify({
    url: data.url,
    title: data.title,
    buttons: data.buttons?.slice?.(0, 20),
    inputLabels: data.inputs?.filter?.((i) => i.visible).slice(0, 20),
    frames: data.frames?.map?.((frame) => ({
      url: frame.url,
      title: frame.title,
      buttons: frame.buttons?.slice?.(0, 10),
      inputLabels: frame.inputs?.filter?.((i) => i.visible).slice(0, 10),
      text: frame.text?.slice?.(0, 500),
    })).slice?.(0, 5),
    text: data.text?.slice?.(0, 1200),
  }, null, 2));
  return data;
}

async function clickText(page, pattern, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loc = page.getByText(pattern).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      await humanClickLocator(page, loc);
      console.log(`[apple-ads-api-setup] clicked ${label}`);
      await humanIdlePause('deliberate');
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

function extractValuesNearLabels(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const patterns = {
    clientId: /Client ID\s*[:\-]?\s*([A-Za-z0-9._-]{6,})/i,
    teamId: /Team ID\s*[:\-]?\s*([A-Z0-9]{6,})/i,
    keyId: /Key ID\s*[:\-]?\s*([A-Z0-9]{6,})/i,
  };
  const out = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = compact.match(pattern);
    if (match?.[1]) out[key] = match[1];
  }
  return out;
}

function summarizeAppleArtifacts(pageState, localState) {
  const frames = Array.isArray(pageState?.frames) ? pageState.frames : [];
  const frameText = frames.map((frame) => frame.text || '').join('\n');
  const text = [pageState?.text || '', frameText].join('\n');
  const values = extractValuesNearLabels(text);
  const buttons = [
    ...(pageState?.buttons || []),
    ...frames.flatMap((frame) => frame.buttons || []),
  ].filter(Boolean);

  const hasCredentialLabels = /Client ID|Team ID|Key ID/i.test(text);
  const hasApiSurface = /API|Public Key|Generate API client|Campaign Management API/i.test(text);
  const hasCreateButton = buttons.some((button) => /Generate API client|Create API client|Add API client|Generate/i.test(button));

  return {
    hasExistingAppleAdsApiClient: hasCredentialLabels,
    hasAppleAdsApiSurface: hasApiSurface,
    canGenerateApiClient: hasCreateButton || /Public Key/i.test(text),
    extracted: values,
    local: localState,
    matchedButtons: buttons.filter((button) => /API|Client|Key|Generate|Create|Public Key/i.test(button)).slice(0, 40),
    textMatches: {
      clientId: /Client ID/i.test(text),
      teamId: /Team ID/i.test(text),
      keyId: /Key ID/i.test(text),
      publicKey: /Public Key/i.test(text),
      generateApiClient: /Generate API client|Create API client|Add API client/i.test(text),
    },
  };
}

async function inspectExistingAppleAdsApi(page, pageState) {
  const localState = {
    publicKeyPath: PUBLIC_KEY_PATH,
    hasPublicKey: existsSync(PUBLIC_KEY_PATH),
    privateKeyPath: PRIVATE_KEY_PATH,
    hasPrivateKey: existsSync(PRIVATE_KEY_PATH),
    env: {
      hasClientId: Boolean(process.env.ASC_ADS_CLIENT_ID),
      hasTeamId: Boolean(process.env.ASC_ADS_TEAM_ID),
      hasKeyId: Boolean(process.env.ASC_ADS_KEY_ID),
      hasOrgId: Boolean(process.env.ASC_ADS_ORG_ID),
      hasPrivateKeyPath: Boolean(process.env.ASC_ADS_PRIVATE_KEY_PATH),
    },
  };

  const domState = await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const rows = Array.from(document.querySelectorAll('tr, [role="row"], li, section, article'))
      .filter(visible)
      .map((el) => norm(el.innerText || el.textContent))
      .filter((text) => /API|Client|Team ID|Key ID|Public Key|Generate|Create/i.test(text))
      .slice(0, 120);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter(visible)
      .map((el) => ({
        text: norm(el.innerText || el.textContent || el.getAttribute('aria-label')),
        href: el.href || '',
      }))
      .filter((item) => /API|Client|Key|Generate|Create|Public Key/i.test(`${item.text} ${item.href}`))
      .slice(0, 120);
    return { rows, controls };
  }).catch((error) => ({ error: error.message, rows: [], controls: [] }));

  const summary = {
    ...summarizeAppleArtifacts(pageState, localState),
    dom: domState,
    url: pageState?.url || page.url?.() || '',
    title: pageState?.title || '',
  };
  const outPath = join(DIAG_DIR, 'apple_ads_api_existing.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`[apple-ads-api-setup] existing_api json=${outPath}`);
  console.log(`[apple-ads-api-setup] existing_api ${JSON.stringify({
    hasExistingAppleAdsApiClient: summary.hasExistingAppleAdsApiClient,
    hasAppleAdsApiSurface: summary.hasAppleAdsApiSurface,
    canGenerateApiClient: summary.canGenerateApiClient,
    extracted: summary.extracted,
    local: summary.local,
  }, null, 2)}`);
  return summary;
}

async function keepOpen(session, loggedIn) {
  if (!loggedIn || CLOSE_AFTER_PROBE) {
    await session.close().catch(() => {});
    return;
  }

  if (KEEP_OPEN_AFTER_LOGIN_MS > 0) {
    console.log(`[apple-ads-api-setup] logged in; keeping browser open for ${KEEP_OPEN_AFTER_LOGIN_MS}ms`);
    await session.wait(Math.ceil(KEEP_OPEN_AFTER_LOGIN_MS / 1000)).catch(() => {});
    return;
  }

  console.log('[apple-ads-api-setup] logged in; keeping browser open; set APPLE_ADS_CLOSE_AFTER_PROBE=1 to close automatically');
  await new Promise(() => {});
}

async function loginIfNeeded(s, acct) {
  if (!/idmsa\.apple\.com|appleid\.apple\.com|signin|login/i.test(s.page.url?.() ?? '')) return true;
  const email = acct?.metadata?.email;
  const password = acct?.metadata?.password;
  if (!email || !password) {
    console.log('FAIL: Apple account is not logged in and stored email/password are missing');
    return false;
  }

  const frameHandle = await s.page.waitForSelector('iframe[src*="idmsa.apple.com"], iframe[src*="appleid.apple.com"]', { timeout: 15000 }).catch(() => null);
  const frame = frameHandle ? await frameHandle.contentFrame() : s.page;
  const emailInput = frame.locator([
    '#account_name_text_field',
    'input[type="email"]',
    'input[type="text"][placeholder*="Email" i]',
    'input[aria-label*="Email" i]',
    'input[name="accountName"]',
    'input[name="email"]',
  ].join(', ')).filter({ visible: true }).first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
    await frame.locator('#sign-in, button[type="submit"], button:has-text("Continue")').filter({ visible: true }).first().click();
    await humanIdlePause('deliberate');
  } else {
    await pageDiag(s.page, 'apple_email_input_not_found');
  }

  const continuePassword = frame.locator('#continue-password, button:has-text("Continue with Password")').filter({ visible: true }).first();
  if (await continuePassword.isVisible().catch(() => false)) {
    await continuePassword.click();
    await humanIdlePause('short');
  }

  let passwordSubmitted = false;
  const passwordInput = frame.locator('#password_text_field, input[type="password"], input[name="password"]').filter({ visible: true }).first();
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(password);
    await frame.locator('#sign-in, button[type="submit"], button:has-text("Sign In")').filter({ visible: true }).first().click();
    passwordSubmitted = true;
    await humanIdlePause('deliberate');
  }

  const twoFaVisible = await frame.locator('input[aria-label*="digit"], input[type="tel"][maxlength="1"]').first().isVisible().catch(() => false)
    || await s.page.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().isVisible().catch(() => false);
  if (twoFaVisible || passwordSubmitted) {
    const twoFa = await completeAppleNativeTwoFactorChallenge(s, frame, {
      logPrefix: '[apple-ads-api-setup]',
    });
    if (!twoFa.ok) {
      console.log(`APPLE_2FA_REQUIRED: ${twoFa.codeFile || process.env.APPLE_2FA_CODE_FILE || DEFAULT_APPLE_2FA_CODE_FILE}`);
      await pageDiag(s.page, 'apple_2fa_required');
      return false;
    }
    await humanIdlePause('short');
  }

  for (let i = 0; i < 30; i += 1) {
    if (!/idmsa\.apple\.com|appleid\.apple\.com|signin|login/i.test(s.page.url?.() ?? '')) return true;
    await s.wait(1);
  }
  await pageDiag(s.page, 'apple_login_not_completed');
  return !/idmsa\.apple\.com|appleid\.apple\.com|signin|login/i.test(s.page.url?.() ?? '');
}

async function main() {
  const acct = await getSocialAccount('apple');
  if (!acct) {
    console.log('FAIL: no active apple account in DB');
    process.exit(1);
  }
  const { proxyUrl, persona } = await resolveAccountSession(acct);
  const s = await WSession.start({
    label: 'apple_ads_api_setup',
    browser: 'chromium',
    proxy: proxyUrl ?? (process.env.PROXY_URL || 'direct'),
    persona: persona || stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
  });

  let loggedIn = false;
  let exitCode = 0;
  try {
    console.log(JSON.stringify({
      publicKeyPath: PUBLIC_KEY_PATH,
      hasPublicKey: existsSync(PUBLIC_KEY_PATH),
      privateKeyPath: PRIVATE_KEY_PATH,
      hasPrivateKey: existsSync(PRIVATE_KEY_PATH),
    }, null, 2));

    await s.goto('https://app-ads.apple.com/cm/app/');
    await s.wait(8);
    loggedIn = await loginIfNeeded(s, acct);
    if (!loggedIn) {
      exitCode = 2;
      return;
    }
    await s.wait(5);
    await pageDiag(s.page, 'home');

    for (const url of [
      'https://app-ads.apple.com/cm/app/account/settings/api',
      'https://app-ads.apple.com/cm/app/settings/api',
      'https://app-ads.apple.com/cm/app/account/settings',
      'https://app-ads.apple.com/cm/app/',
    ]) {
      await s.goto(url);
      await s.wait(8);
      await pageDiag(s.page, `url_${Buffer.from(url).toString('hex').slice(0, 16)}`);
      const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/API|Public Key|Generate API client|Client ID|Team ID|Key ID/i.test(text)) break;
    }

    await clickText(s.page, /Account Settings|Settings/i, 'settings', 6000).catch(() => false);
    await clickText(s.page, /^API$|API Access|Campaign Management API|Public Key/i, 'api', 6000).catch(() => false);
    const finalState = await pageDiag(s.page, 'final');
    const existing = await inspectExistingAppleAdsApi(s.page, finalState);

    if (existing.hasExistingAppleAdsApiClient) {
      console.log('PASS: Apple Ads API credential page reached');
    } else if (existing.canGenerateApiClient || existing.hasAppleAdsApiSurface) {
      console.log('PASS: Apple Ads API setup form reached');
    } else {
      console.log('FAIL: Apple Ads API setup page not reached');
      exitCode = 3;
      return;
    }
  } finally {
    process.exitCode = exitCode;
    await keepOpen(s, loggedIn);
  }
}

main().catch((e) => {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
});
