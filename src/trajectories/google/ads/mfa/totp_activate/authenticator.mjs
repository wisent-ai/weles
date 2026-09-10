// The authenticator setup on the Google security page, through to the first accepted code.
import { humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { generateTotp } from '../../../../_shared/services/google_sso.mjs';
import { NAV_TIMEOUT_MS, normalizeSecret, redact } from './settings.mjs';
import { clickByText, currentBodyText, diag } from './page.mjs';
import { classifyGoogleAuthBlock, ensureSignedIn, switchToCorrectGoogleAccount } from './account.mjs';

export async function gotoAuthenticatorSettingsLink(s) {
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

export async function openAuthenticatorSetup(s, creds) {
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

export async function waitForCodeInput(page) {
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

export async function waitForNewTotpCode(secret, previous = '') {
  let code = generateTotp(secret);
  if (!previous || code !== previous) return code;
  for (let i = 0; i < 35; i++) {
    await humanIdlePause('short');
    code = generateTotp(secret);
    if (code !== previous) return code;
  }
  return code;
}

export async function activateAuthenticator(s, creds) {
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
