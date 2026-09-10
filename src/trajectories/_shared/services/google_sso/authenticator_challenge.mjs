// Google's second factor, answered from this account's own stored secret.
//
// Google decides which method it offers, so the challenge is driven by what the
// page shows: the authenticator option when it is listed, the code field when it
// is on screen, and "Try another way" when Google parked the run on a method
// this driver cannot answer. Every one of those is a question about the live
// page, and the answers are named rather than inferred from an empty read.
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { generateTotp, resolveTotpSecret } from './totp_secret.mjs';
import { PAGE_TEXT_UNREADABLE, logGooglePageDiag, readGooglePageText } from './page_diagnostics.mjs';

// 'present' | 'absent' | 'unreadable'. A page whose text could not be read is
// not a page that fails to offer the authenticator; it is a page that said
// nothing, and the caller treats the two differently.
async function googleAuthenticatorOptionState(page) {
  const text = await readGooglePageText(page);
  if (text === PAGE_TEXT_UNREADABLE) return 'unreadable';
  const offered = /Google Authenticator|Authenticator app|verification code from the Google Authenticator app/i.test(text);
  return offered ? 'present' : 'absent';
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

    const nearestClickable = page.locator('button, [role="button"], a, [role="link"], li, [role="option"]').filter({ hasText: pattern }).filter({ visible: true }).first();
    const clickedByJs = await humanClickLocator(page, nearestClickable).then(() => true).catch(() => false);
    if (clickedByJs) {
      console.log(`[google_sso] selected Google Authenticator option via JS ancestor (${pattern.source})`);
      await humanIdlePause('deliberate');
      return true;
    }
  }
  return false;
}

// Which selector names Google's code field, most specific first. A page that
// cannot answer "is this field visible" is a broken page, and says so.
async function visibleTotpInput(page) {
  const codeFieldSelectors = [
    'input[name="totpPin"]',
    'input[name="Pin"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="text"]',
  ];
  for (const selector of codeFieldSelectors) {
    const input = page.locator(selector).filter({ visible: true }).first();
    if (await input.isVisible()) return input;
  }
  return null;
}

async function submitGoogleSecondFactor(page) {
  await page.keyboard.press('Enter');
  await humanIdlePause('deliberate');
  const next = page.getByRole('button', { name: /^(Next|Verify|Continue)$/i })
    .or(page.locator('button, [role="button"]').filter({ hasText: /^\s*(Next|Verify|Continue)\s*$/i }))
    .filter({ visible: true })
    .last();
  if (await next.isVisible().catch(() => false)) {
    await next.click({ force: true }).catch(() => humanClickLocator(page, next));
    await humanIdlePause('deliberate');
  }
}


async function fillGoogleAuthenticatorTotp(page, creds) {
  const secret = resolveTotpSecret(creds);
  if (!secret) return false;
  for (let i = 0; i < 20; i++) {
    const input = await visibleTotpInput(page);
    if (input) {
      const pageText = await readGooglePageText(page);
      const existing = await input.inputValue();
      let code = generateTotp(secret);
      if (!code) return false;
      // A page whose text could not be read did not say the code was wrong. Only
      // a page that says so, or a field already holding a whole code, forces a
      // freshly generated one.
      const codeRejected = pageText !== PAGE_TEXT_UNREADABLE && /Wrong code|Try again/i.test(pageText);
      if (codeRejected || (/^\d+$/.test(existing) && existing.length === Number('6'))) {
        for (let j = 0; j < 35; j++) {
          code = generateTotp(secret);
          if (code !== existing) break;
          await humanIdlePause('short');
        }
      }
      await humanFill(page, input, '');
      await humanFill(page, input, code);
      console.log('[google_sso] filled Google Authenticator TOTP code from the exact scoped secret');
      await submitGoogleSecondFactor(page);
      return true;
    }
    await humanIdlePause('short');
  }
  return false;
}

export async function handleGoogleAuthenticatorTotp(page, creds) {
  const secret = resolveTotpSecret(creds);
  if (!secret) return false;
  if (await visibleTotpInput(page)) {
    return await fillGoogleAuthenticatorTotp(page, creds);
  }
  if (await googleAuthenticatorOptionState(page) === 'present') {
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
      if (await googleAuthenticatorOptionState(page) === 'present') {
        const clicked = await clickGoogleAuthenticatorOption(page);
        if (clicked && await fillGoogleAuthenticatorTotp(page, creds)) return true;
      }
    }
  }
  if (await googleAuthenticatorOptionState(page) === 'present') {
    await logGooglePageDiag(page, 'authenticator_code_input_missing');
  }
  return false;
}

export async function clickTryAnotherWay(page) {
  const beforeUrl = page.url();
  const transitioned = async () => {
    for (let i = 0; i < 20; i++) {
      const currentUrl = page.url();
      const text = await readGooglePageText(page);
      if (currentUrl !== beforeUrl
          || (text !== PAGE_TEXT_UNREADABLE
            && /choose another way|choose how|verification code|authenticator|backup code|security key|text message|phone call/i.test(text))) {
        return true;
      }
      await humanIdlePause('short');
    }
    return false;
  };

  const controller = page.locator(
    '[data-secondary-action-label="Try another way"] [jsaction*="click:"], '
      + '[data-secondary-action-label="Try another way"][jsaction*="click:"]',
  ).first();
  const semantic = page.getByRole('button', { name: /Try another way/i })
    .or(page.getByRole('link', { name: /Try another way/i }))
    .first();
  const textual = page.locator('button, [role="button"], a, [role="link"], div, span')
    .filter({ hasText: /^\s*Try another way\s*$/i })
    .first();

  for (const [name, candidate] of [
    ['controller', controller],
    ['semantic control', semantic],
    ['text control', textual],
  ]) {
    if (!await candidate.isVisible().catch(() => false)) continue;
    console.log(`[google_sso] clicking "Try another way" via ${name}`);
    await humanClickLocator(page, candidate)
      .catch(() => humanClickLocator(page, candidate));
    await humanIdlePause('deliberate');
    if (await transitioned()) return true;
  }

  const nearestClickable = page.locator('[data-secondary-action-label="Try another way"], button, [role="button"], a, [role="link"], li').filter({ hasText: /^\s*Try another way\s*$/i }).filter({ visible: true }).first();
  const clickedByJs = await humanClickLocator(page, nearestClickable).then(() => true).catch(() => false);
  if (!clickedByJs) return false;
  console.log('[google_sso] clicked "Try another way" through the Google action controller');
  await humanIdlePause('deliberate');
  return transitioned();
}
