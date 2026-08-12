// Google SSO driver for service-credential balance trajectories.
// Many proxy/captcha/SMS providers expose only a "Sign in with Google" button.
// Caller must already have clicked the provider's "Sign in with Google" button
// and the page must now be on accounts.google.com (or about to redirect there).
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { readScopedLogin } from '../../../_shared/scoped-secrets.mjs';

async function logGooglePageDiag(page, label) {
  const diag = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el) => ({
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null),
      }))
      .filter((button) => button.text)
      .slice(0, 20);
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((el) => ({
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        valueLength: String(el.value || '').length,
      }))
      .slice(0, 20);
    return { url: location.href, title: document.title, text, buttons, inputs };
  }).catch((e) => ({ error: e.message }));
  console.log(`[google_sso] ${label} diag=${JSON.stringify(diag).slice(0, 3000)}`);

  if (process.env.GOOGLE_SSO_SCREENSHOTS === '1' && process.env.GOOGLE_SSO_NO_SCREENSHOTS !== '1') {
    const dir = process.env.GOOGLE_SSO_DIAG_DIR || '.work/google-sso-diag';
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${label.replace(/[^a-z0-9_-]/gi, '_')}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    console.log(`[google_sso] ${label} screenshot=${file}`);
  }
}

async function collectGoogleAuthMethods(page) {
  return await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('li, div[role="button"], div[role="option"], button, a, [data-challengetype]'))
      .map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        challengeType: el.getAttribute('data-challengetype') || '',
        text: norm(el.innerText || el.textContent || '').slice(0, 300),
        aria: el.getAttribute('aria-label') || '',
      }))
      .filter((item) => /try another way|passkey|authenticator|backup code|verification code|phone|text|call|security key|gmail|prompt|password/i.test(`${item.text} ${item.aria} ${item.challengeType}`))
      .slice(0, 80);
  }).catch(() => []);
}

function extractTotpSecretFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^otpauth:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.searchParams.get('secret') || '';
    } catch {
      return '';
    }
  }
  return text;
}

function findTotpSecret(value, seen = new Set()) {
  if (!value || seen.has(value)) return '';
  if (typeof value === 'string') return extractTotpSecretFromValue(value);
  if (typeof value !== 'object') return '';
  seen.add(value);

  const preferredKeys = [
    'totp_secret',
    'totpSecret',
    'otp_secret',
    'otpSecret',
    'authenticator_secret',
    'authenticatorSecret',
    'google_totp_secret',
    'googleTotpSecret',
    'google_authenticator_secret',
    'googleAuthenticatorSecret',
    'mfa_secret',
    'mfaSecret',
    'two_factor_secret',
    'twoFactorSecret',
  ];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const secret = extractTotpSecretFromValue(value[key]);
      if (secret) return secret;
    }
  }
  for (const nestedKey of ['metadata', 'meta', 'credentials', 'secrets', 'login_metadata']) {
    if (value[nestedKey]) {
      const secret = findTotpSecret(value[nestedKey], seen);
      if (secret) return secret;
    }
  }
  return '';
}

function resolveTotpSecret(creds) {
  return findTotpSecret(creds);
}

function decodeBase32Secret(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = extractTotpSecretFromValue(secret).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean) throw new Error('empty TOTP secret');
  let bits = '';
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error(`invalid TOTP base32 character ${char}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret, options = {}) {
  const digits = Number(options.digits || 6);
  const step = Number(options.step || 30);
  const algorithm = String(options.algorithm || 'sha1').toLowerCase();
  const counter = Math.floor((options.now || Date.now()) / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, decodeBase32Secret(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

async function pageHasGoogleAuthenticatorOption(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return /Google Authenticator|Authenticator app|verification code from the Google Authenticator app/i.test(text);
}

async function clickGoogleAuthenticatorOption(page) {
  const patterns = [
    /Get a verification code from the Google Authenticator app/i,
    /Google Authenticator/i,
    /Authenticator app/i,
  ];
  for (const pattern of patterns) {
    const semantic = page.getByRole('button', { name: pattern, exact: false })
      .or(page.getByRole('link', { name: pattern, exact: false }))
      .or(page.getByRole('option', { name: pattern, exact: false }))
      .filter({ visible: true })
      .first();
    if (await semantic.isVisible().catch(() => false)) {
      console.log(`[google_sso] selecting Google Authenticator option via role (${pattern.source})`);
      await semantic.click({ force: true }).catch(() => humanClickLocator(page, semantic));
      await humanIdlePause('deliberate');
      return true;
    }

    const textual = page.locator('li, div[role="option"], div[role="button"], button, a')
      .filter({ hasText: pattern })
      .filter({ visible: true })
      .first();
    if (await textual.isVisible().catch(() => false)) {
      console.log(`[google_sso] selecting Google Authenticator option via text (${pattern.source})`);
      await textual.click({ force: true }).catch(() => humanClickLocator(page, textual));
      await humanIdlePause('deliberate');
      return true;
    }

    const clickedByJs = await page.evaluate((source) => {
      const re = new RegExp(source, 'i');
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        if (!re.test(node.textContent || '')) continue;
        let el = node.parentElement;
        while (el && el !== document.body) {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          if (tag === 'button' || tag === 'a' || role === 'button' || role === 'option' || tag === 'li') {
            el.click();
            return true;
          }
          el = el.parentElement;
        }
      }
      return false;
    }, pattern.source).catch(() => false);
    if (clickedByJs) {
      console.log(`[google_sso] selected Google Authenticator option via JS ancestor (${pattern.source})`);
      await humanIdlePause('deliberate');
      return true;
    }
  }
  return false;
}

async function navigateGoogleAuthenticatorTotpChallenge(page) {
  const current = page.url();
  if (!/accounts\.google\.com/.test(current) || !/signin\/challenge\/selection/.test(current)) return false;
  if (process.env.GOOGLE_SSO_ALLOW_DIRECT_TOTP !== '1') return false;
  const target = current.replace(/\/signin\/challenge\/selection(?=[?#])/, '/signin/challenge/totp');
  if (target === current) return false;
  const attempts = navigateGoogleAuthenticatorTotpChallenge.attempts || (navigateGoogleAuthenticatorTotpChallenge.attempts = new Set());
  const key = current.replace(/([?&](?:TL|rart|dsh)=)[^&]+/g, '$1');
  if (attempts.has(key)) return false;
  attempts.add(key);
  console.log('[google_sso] opening Google Authenticator TOTP challenge directly');
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await humanIdlePause('deliberate');
  if (await visibleTotpInput(page)) return true;
  await page.goto(current, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await humanIdlePause('short');
  return false;
}

async function visibleTotpInput(page) {
  const candidates = [
    'input[name="totpPin"]',
    'input[name="Pin"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="text"]',
  ];
  for (const selector of candidates) {
    const input = page.locator(selector).filter({ visible: true }).first();
    if (await input.isVisible().catch(() => false)) return input;
  }
  return null;
}

async function submitGoogleSecondFactor(page) {
  await page.keyboard.press('Enter').catch(() => {});
  await humanIdlePause('deliberate');
  const next = page.getByRole('button', { name: /^(Next|Verify|Continue)$/i })
    .or(page.locator('button, [role="button"]').filter({ hasText: /^\s*(Next|Verify|Continue)\s*$/i }))
    .filter({ visible: true })
    .last();
  if (await next.isVisible().catch(() => false)) {
    await next.click({ force: true, timeout: 5000 }).catch(() => humanClickLocator(page, next));
    await humanIdlePause('deliberate');
  }
}


async function fillGoogleAuthenticatorTotp(page, creds) {
  const secret = resolveTotpSecret(creds);
  if (!secret) return false;
  for (let i = 0; i < 20; i++) {
    const input = await visibleTotpInput(page);
    if (input) {
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      const existing = await input.inputValue().catch(() => '');
      let code = generateTotp(secret);
      if (!code) return false;
      if (/Wrong code|Try again/i.test(text) || (/^\d+$/.test(existing) && existing.length === Number('6'))) {
        for (let j = 0; j < 35; j++) {
          code = generateTotp(secret);
          if (code !== existing) break;
          await humanIdlePause('short');
        }
      }
      await input.fill('').catch(() => {});
      await humanFill(page, input, code);
      console.log('[google_sso] filled Google Authenticator TOTP code from the exact scoped secret');
      await submitGoogleSecondFactor(page);
      return true;
    }
    await humanIdlePause('short');
  }
  return false;
}

async function handleGoogleAuthenticatorTotp(page, creds) {
  const secret = resolveTotpSecret(creds);
  if (!secret) return false;
  if (await visibleTotpInput(page)) {
    return await fillGoogleAuthenticatorTotp(page, creds);
  }
  if (await pageHasGoogleAuthenticatorOption(page)) {
    const clicked = await clickGoogleAuthenticatorOption(page);
    if (!clicked) {
      await logGooglePageDiag(page, 'authenticator_option_not_clickable');
      return false;
    }
  }
  const filled = await fillGoogleAuthenticatorTotp(page, creds);
  if (filled) return true;
  if (/signin\/challenge\/(dp|selection)/.test(page.url())) {
    if (await clickTryAnotherWay(page)) {
      if (await visibleTotpInput(page)) return await fillGoogleAuthenticatorTotp(page, creds);
      if (await pageHasGoogleAuthenticatorOption(page)) {
        const clicked = await clickGoogleAuthenticatorOption(page);
        if (clicked && await fillGoogleAuthenticatorTotp(page, creds)) return true;
      }
    }
    if (await navigateGoogleAuthenticatorTotpChallenge(page)) {
      const directFilled = await fillGoogleAuthenticatorTotp(page, creds);
      if (directFilled) return true;
    }
  }
  if (await pageHasGoogleAuthenticatorOption(page)) {
    await logGooglePageDiag(page, 'authenticator_code_input_missing');
  }
  return false;
}

async function clickTryAnotherWay(page) {
  const beforeUrl = page.url();
  const waitForTryAnotherResult = async () => {
    for (let i = 0; i < 20; i++) {
      const currentUrl = page.url();
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (currentUrl !== beforeUrl || /choose another way|choose how|verification code|authenticator|backup code|security key|text message|phone call/i.test(text)) {
        return true;
      }
      await humanIdlePause('short');
    }
    return false;
  };
  const tryAnotherController = page
    .locator('[data-secondary-action-label="Try another way"] [jsaction*="click:"]')
    .filter({ visible: true })
    .first();
  const tryAnotherSemantic = page.getByRole('button', { name: /Try another way/i })
    .or(page.getByRole('link', { name: /Try another way/i }))
    .filter({ visible: true })
    .first();
  const tryAnotherTextual = page.locator('button, [role="button"], a, [role="link"], div, span')
    .filter({ hasText: /^\s*Try another way\s*$/i })
    .filter({ visible: true })
    .first();
  const controllerVisible = await tryAnotherController.isVisible().catch(() => false);
  const tryAnother = controllerVisible
    ? tryAnotherController
    : await tryAnotherSemantic.isVisible().catch(() => false)
      ? tryAnotherSemantic
      : tryAnotherTextual;
  if (await tryAnother.isVisible().catch(() => false)) {
    console.log('[google_sso] clicking "Try another way"');
    if (controllerVisible) {
      await tryAnother.click({ force: true, timeout: 5000 }).catch(() => humanClickLocator(page, tryAnother));
    } else {
      await humanClickLocator(page, tryAnother).catch(() => tryAnother.click({ force: true, timeout: 5000 }));
    }
    await humanIdlePause('deliberate');
  } else {
    const clickedByJs = await page.evaluate(() => {
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], div, span'));
      const target = nodes.find((el) => /^Try another way$/i.test(norm(el.innerText || el.textContent || '')));
      if (!target) return false;
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }).catch(() => false);
    if (!clickedByJs) return false;
    console.log('[google_sso] clicked "Try another way" via JS event dispatch');
    await humanIdlePause('deliberate');
  }
  if (await waitForTryAnotherResult()) return true;
  if (controllerVisible) {
    console.log('[google_sso] retrying Google secondary action controller');
    await tryAnotherController.click({ force: true, timeout: 5000 }).catch(() => {});
    await humanIdlePause('deliberate');
    if (await waitForTryAnotherResult()) return true;
  }
  const clickedByJs = await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], div, span, li'));
    const textNode = nodes.find((el) => /^Try another way$/i.test(norm(el.innerText || el.textContent || '')));
    if (!textNode) return false;
    let target = textNode;
    while (target && target !== document.body) {
      const tag = target.tagName.toLowerCase();
      const role = target.getAttribute('role');
      if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'option' || tag === 'li') break;
      target = target.parentElement;
    }
    if (!target) return false;
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }).catch(() => false);
  if (clickedByJs) {
    console.log('[google_sso] retried "Try another way" via JS ancestor click');
    await humanIdlePause('deliberate');
    return await waitForTryAnotherResult();
  }
  return page.url() !== beforeUrl;
}

/**
 * Drive Google's identifier → password → consent sequence.
 * @param {object} session - WSession instance (we use session.page).
 * @param {{ email: string, password: string, totpSecret?: string, totp_secret?: string, metadata?: object }} creds
 * @param {{ originHost?: string }} opts - originHost (e.g. "dashboard.iproyal.com") for the post-login redirect check.
 * @returns {Promise<boolean>} true on success, false on detectable failure.
 */
export async function googleSso(session, creds, opts = {}) {
  // If caller passes opts.page (e.g. a popup), drive that page; otherwise the
  // session's main page. Caller is responsible for capturing popups before
  // calling this helper since on('page') listeners attach too late if added
  // here.
  let page = opts.page ?? session.page;
  await humanIdlePause('short');

  for (let i = 0; i < 30; i++) {
    if (/accounts\.google\.com/.test(page.url())) break;
    await humanIdlePause('short');
  }
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(`[google_sso] FAIL: never reached accounts.google.com (url=${page.url()})`);
    return false;
  }

  if (/signin\/accountchooser/.test(page.url())) {
    const accountOption = page.locator('[data-identifier]')
      .filter({ hasText: new RegExp(creds.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
      .or(page.getByText(creds.email, { exact: true }))
      .filter({ visible: true })
      .first();
    if (await accountOption.isVisible().catch(() => false)) {
      console.log(`[google_sso] selecting known account (${creds.email})`);
      await humanClickLocator(page, accountOption).catch(() => accountOption.click({ force: true }));
      for (let i = 0; i < 30; i++) {
        await humanIdlePause('short');
        if (!/signin\/accountchooser/.test(page.url())) break;
      }
    }
  }
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(`[google_sso] known account returned to ${page.url()}`);
    return true;
  }
  if (/\/signin\/oauth\/(consent|id)/.test(page.url())) {
    const continueButton = page.getByRole('button', { name: /^(Continue|Allow)$/i })
      .filter({ visible: true })
      .first();
    if (await continueButton.isVisible().catch(() => false)) {
      await humanClickLocator(page, continueButton).catch(() => continueButton.click({ force: true }));
      for (let i = 0; i < 30; i++) {
        await humanIdlePause('short');
        if (!/accounts\.google\.com/.test(page.url())) {
          console.log(`[google_sso] consent returned to ${page.url()}`);
          return true;
        }
      }
    }
  }

  const emailIn = page.locator('input[type="email"], input[name="identifier"], input#identifierId').filter({ visible: true }).first();
  let pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count().catch(() => 0);
  if (!await emailIn.isVisible().catch(() => false) && pwInVisible === 0) {
    for (let i = 0; i < 30; i++) {
      await humanIdlePause('short');
      if (!/accounts\.google\.com/.test(page.url())) {
        console.log(`[google_sso] account selection returned to ${page.url()}`);
        return true;
      }
      if (await emailIn.isVisible().catch(() => false)) break;
      pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]')
        .filter({ visible: true })
        .count()
        .catch(() => 0);
      if (pwInVisible > 0) break;
    }
  }
  if (await emailIn.isVisible().catch(() => false)) {
    await humanFill(page, emailIn, creds.email);
    console.log(`[google_sso] identifier filled (${creds.email})`);

    const idNext = page.locator('#identifierNext button, button:has-text("Next"), [jsname="LgbsSe"]').filter({ visible: true }).first();
    await humanClickLocator(page, idNext);

    // Wait for Google to leave the identifier step before probing for password/passkey.
    for (let i = 0; i < 30; i++) {
      await humanIdlePause('short');
      if (!/signin\/identifier/.test(page.url())) break;
    }
  } else if (pwInVisible > 0) {
    console.log('[google_sso] starting from visible password challenge');
  } else {
    if (!/accounts\.google\.com/.test(page.url())) {
      console.log(`[google_sso] delayed account selection returned to ${page.url()}`);
      return true;
    }
    await logGooglePageDiag(page, 'no_identifier_or_password_input');
    console.log(`[google_sso] FAIL: no identifier or password input visible (url=${page.url()})`);
    return false;
  }

  // Loop: at each step, try to land on a visible password input. Click
  // "Enter your password" / "Use your password" if offered, "Try another way"
  // if we're on the passkey-only page. Up to 8 transitions before giving up.
  pwInVisible = pwInVisible || 0;
  for (let step = 0; step < 8; step++) {
    for (let i = 0; i < 40; i++) {
      await humanIdlePause('short');
      pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count().catch(() => 0);
      if (pwInVisible > 0) break;
    }
    if (pwInVisible > 0) break;

    // Google's "Welcome" / challenge selection page lists sign-in methods.
    // Explicitly pick "Enter your password" / "Use your password" instead of
    // looping on "Try another way". The option may be a listitem, div, or
    // button, and Playwright's visible filter can be flaky on the listitem
    // itself, so try semantic role first and fall back to text+ancestor click.
    if (/signin\/challenge\/(selection|pk\/presend)/.test(page.url())) {
      // The selection options can appear slightly after the page URL changes.
      // Wait for the password option text before giving up and falling back.
      for (let i = 0; i < 30; i++) {
        const hasPwOption = await page.evaluate(() => /Enter your password|Use your password/i.test(document.body?.innerText || ''));
        if (hasPwOption) break;
        await humanIdlePause('short');
      }

      const pwOptionNames = [/Enter your password/i, /Use your password/i];
      let clickedChoice = false;
      for (const nameRe of pwOptionNames) {
        const semantic = page.getByRole('button', { name: nameRe, exact: false }).or(page.getByRole('link', { name: nameRe, exact: false })).filter({ visible: true }).first();
        if (await semantic.isVisible().catch(() => false)) {
          console.log(`[google_sso] clicking password option via role (${nameRe.source})`);
          await semantic.click({ force: true }).catch(() => humanClickLocator(page, semantic));
          clickedChoice = true;
          break;
        }
        const textual = page.locator('li, div[role="option"], div[role="button"], button, a').filter({ hasText: nameRe }).filter({ visible: true }).first();
        if (await textual.isVisible().catch(() => false)) {
          console.log(`[google_sso] clicking password option via text (${nameRe.source})`);
          await textual.click({ force: true }).catch(() => humanClickLocator(page, textual));
          clickedChoice = true;
          break;
        }
        // Last resort: find the text node and click its nearest clickable ancestor.
        const foundByJs = await page.evaluate((text) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          let n;
          while ((n = walker.nextNode())) {
            if (n.textContent.match(new RegExp(text, 'i'))) {
              let el = n.parentElement;
              while (el && el !== document.body) {
                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute('role');
                if (tag === 'button' || tag === 'a' || role === 'button' || role === 'option' || tag === 'li') {
                  el.click();
                  return true;
                }
                el = el.parentElement;
              }
            }
          }
          return false;
        }, nameRe.source);
        if (foundByJs) {
          console.log(`[google_sso] clicked password option via JS ancestor (${nameRe.source})`);
          clickedChoice = true;
          break;
        }
      }
      if (clickedChoice) {
        await humanIdlePause('deliberate');
        // Wait for password field to appear on the next screen.
        for (let i = 0; i < 30; i++) {
          await humanIdlePause('short');
          pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count().catch(() => 0);
          if (pwInVisible > 0) break;
        }
        if (pwInVisible > 0) break;
        continue;
      }
    }

    if (await clickTryAnotherWay(page)) {
      continue;
    }

    console.log(`[google_sso] no progress option visible (url=${page.url()})`);
    break;
  }

  if (!pwInVisible) {
    await logGooglePageDiag(page, 'no_password_input');
    console.log(`[google_sso] FAIL: never reached password input (url=${page.url()})`);
    return false;
  }

  const pwIn = page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).first();
  await humanFill(page, pwIn, creds.password);
  console.log('[google_sso] password filled');

  // Primary submit: press Enter while the password field still has focus.
  // Google's password form reliably submits on Enter in the input; previous
  // attempts to click the Next button hung because the button locator matched
  // a non-actionable / overlay element.
  console.log('[google_sso] pressing Enter to submit password');
  await page.keyboard.press('Enter');
  await humanIdlePause('deliberate');

  if (/challenge\/pwd/.test(page.url()) && await pwIn.isVisible().catch(() => false)) {
    console.log('[google_sso] password page still visible; clicking Next fallback');
    const currentPasswordLength = await pwIn.evaluate((el) => String(el.value || '').length).catch(() => 0);
    if (currentPasswordLength === 0) {
      console.log('[google_sso] password input was cleared before fallback; refilling');
      await humanFill(page, pwIn, creds.password);
    }
    const nextByRole = page.getByRole('button', { name: 'Next', exact: true }).filter({ visible: true }).last();
    const nextByText = page.locator('button, [role="button"]').filter({ hasText: /^\s*Next\s*$/i }).filter({ visible: true }).last();
    const passwordNextLegacy = page.locator('#passwordNext button').filter({ visible: true }).first();
    const genericNext = page.getByRole('button', { name: /^(Next|Sign in|Continue)$/i }).filter({ visible: true }).last();
    let nextBtn = null;
    for (const candidate of [nextByRole, nextByText, passwordNextLegacy, genericNext]) {
      if (await candidate.isVisible().catch(() => false)) { nextBtn = candidate; break; }
    }
    if (nextBtn) {
      await nextBtn.click({ force: true, timeout: 5000 }).catch(async () => {
        console.log('[google_sso] native click failed, trying human click');
        await humanClickLocator(page, nextBtn);
      });
    }
    await humanIdlePause('deliberate');
  }

  // Dispatch blur/focusout only after attempting submit.
  await pwIn.evaluate((el) => {
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new Event('focusout', { bubbles: true }));
  }).catch(() => {});

  const originHost = opts.originHost;
  const isPopup = page !== session.page;
  const defaultPostPasswordPolls = Number(process.env.GOOGLE_SSO_POST_PASSWORD_POLLS || '90');
  const devicePromptPolls = Number(process.env.GOOGLE_SSO_DEVICE_PROMPT_POLLS || '900');
  let devicePromptLogged = false;
  let totpAttempts = 0;
  for (let i = 0; i < defaultPostPasswordPolls; i++) {
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      for (let j = 0; j < 30; j++) {
        await humanIdlePause('short');
        const u = session.page.url();
        if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] returned to ${originHost}`); return true; }
      }
      console.log(`[google_sso] popup closed; main page=${session.page.url()}`);
      return true;
    }
    await humanIdlePause('short').catch(() => {});
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      for (let j = 0; j < 20; j++) {
        await humanIdlePause('short');
        const u = session.page.url();
        if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] returned to ${originHost}`); return true; }
      }
      console.log(`[google_sso] popup closed; main page=${session.page.url()}`);
      return true;
    }
    const u = page.url();
    if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) {
      console.log(`[google_sso] main page returned to ${originHost}`);
      return true;
    }
    if (/signin\/challenge\/selection/.test(u) && resolveTotpSecret(creds)) {
      if (await handleGoogleAuthenticatorTotp(page, creds)) {
        totpAttempts += 1;
        continue;
      }
      const phonePrompt = page.locator('li, div[role="option"], div[role="button"], button, a')
        .filter({ hasText: /Tap Yes on your phone or tablet|Gmail app|phone or tablet/i })
        .filter({ visible: true })
        .first();
      if (await phonePrompt.isVisible().catch(() => false)) {
        console.log('[google_sso] selecting phone prompt before alternate-method menu');
        await humanClickLocator(page, phonePrompt).catch(() => phonePrompt.click({ force: true, timeout: 5000 }));
        await humanIdlePause('deliberate');
        continue;
      }
    }
    if (totpAttempts < 3 && await handleGoogleAuthenticatorTotp(page, creds)) {
      totpAttempts += 1;
      continue;
    }
    if (/signin\/challenge\/totp/.test(u) && totpAttempts >= 3) {
      await logGooglePageDiag(page, 'authenticator_wrong_code_after_retries');
      console.log('[google_sso] FAIL: Google Authenticator TOTP code was rejected after retries');
      return false;
    }
    if (/signin\/challenge\/dp/.test(u)) {
      if (!devicePromptLogged) {
        devicePromptLogged = true;
        await logGooglePageDiag(page, 'device_prompt_waiting');
        console.log('[google_sso] waiting for Google device prompt approval');
      }
      if (resolveTotpSecret(creds)) {
        if (await navigateGoogleAuthenticatorTotpChallenge(page)) {
          if (totpAttempts < 3 && await handleGoogleAuthenticatorTotp(page, creds)) {
            totpAttempts += 1;
            continue;
          }
        }
        const switchedMethod = await clickTryAnotherWay(page);
        await humanIdlePause('deliberate');
        if (switchedMethod) {
          await logGooglePageDiag(page, 'device_prompt_try_another_after_click');
          if (totpAttempts < 3 && await handleGoogleAuthenticatorTotp(page, creds)) {
            totpAttempts += 1;
            continue;
          }
        }
        await logGooglePageDiag(page, 'authenticator_method_not_reached');
        console.log('[google_sso] FAIL: Google Authenticator method not reached from device prompt');
        return false;
      }
      for (let j = 0; j < devicePromptPolls; j++) {
        await humanIdlePause('short').catch(() => {});
        const promptUrl = page.url();
        if (!/accounts\.google\.com/.test(promptUrl)) {
          console.log(`[google_sso] device prompt approved; redirected to ${promptUrl}`);
          return true;
        }
        if (!/signin\/challenge\/dp/.test(promptUrl)) break;
      }
      await logGooglePageDiag(page, 'device_prompt_not_approved');
      if (await clickTryAnotherWay(page)) {
        await logGooglePageDiag(page, 'device_prompt_try_another_methods');
        const methods = await collectGoogleAuthMethods(page);
        console.log(`[google_sso] available second-factor methods=${JSON.stringify(methods).slice(0, 3000)}`);
      }
      console.log(`[google_sso] FAIL: Google device prompt was not approved (${page.url()})`);
      return false;
    }
    // Handle OAuth consent screen — Google asks to confirm scope before redirecting back.
    if (/\/signin\/oauth\/(consent|id)/.test(u)) {
      const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Allow")').filter({ visible: true }).first();
      if (await continueBtn.isVisible().catch(() => false)) {
        console.log('[google_sso] clicking OAuth consent Continue/Allow');
        await humanClickLocator(page, continueBtn).catch(() => {});
        await humanIdlePause('deliberate').catch(() => {});
        continue;
      }
    }
    // For popup mode: only return when the popup ITSELF leaves accounts.google.com (storagerelay redirect or dashboard redirect).
    if (isPopup && originHost && u.includes(originHost) && !/accounts\.google\.com/.test(u) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] popup redirected to ${originHost}`); return true; }
    if (!isPopup && originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] main page returned to ${originHost}`); return true; }
    if (!isPopup && !originHost && !/accounts\.google\.com/.test(u) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] redirected off google to ${u}`); return true; }
    if (/challenge\/(deviceauth|recaptcha|az|kpe|sk)/.test(u)) {
      await logGooglePageDiag(page, 'security_challenge');
      console.log(`[google_sso] FAIL: hit Google challenge ${u}`);
      return false;
    }
  }
  await logGooglePageDiag(page, 'still_on_google');
  console.log(`[google_sso] FAIL: still on google after 90s (${page.url()})`);
  return false;
}

export function parseBalanceFromText(text) {
  // Require a "Balance:" / "Credits:" / "Wallet:" / "Funds:" labelled
  // match. The earlier first-$X.XX path returned a service price on
  // JuicySMS / FiveSim landing pages (verified live 2026-05-19: JuicySMS
  // post-SSO landed on the rentals homepage whose first row was Discord
  // "$0.53"; the parser reported it as the balance). Now return null when
  // no labelled balance is found, so callers can detect a scrape that
  // landed on the wrong page instead of persisting a misleading number.
  if (!text) return null;
  const labeled = text.match(/(?:balance|credit[s]?|wallet|funds)[^\n$€£]{0,40}\$([0-9]+(?:\.[0-9]{1,4})?)/i);
  if (labeled) return Number(labeled[1]);
  return null;
}

// Resolve the shared Google SSO identity through its exact Skarbiec consumer.
// Callers for Ads, Gmail, Drive, and Workspace admin use their own service
// identities instead of reusing this grant.
export async function getGoogleSsoCreds(email) {
  const login = readScopedLogin('googleSso');
  if (email && login.email.toLowerCase() !== String(email).toLowerCase()) {
    throw new Error('scoped Google SSO identity does not match the requested account');
  }
  return login;
}
export async function getScopedGoogleLogin(serviceName) {
  return readScopedLogin(serviceName);
}

export async function patchServiceBalance(displayName, balance) {
  const databaseUrl = process.env.WELES_DATABASE_URL ?? '';
  const key = process.env.WELES_DATABASE_TOKEN ?? '';
  if (!databaseUrl || !key) return false;
  const now = new Date().toISOString();
  const r = await fetch(`${databaseUrl}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(displayName)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ balance_usd: balance, last_balance_check: now, updated_at: now }),
  });
  return r.ok;
}
