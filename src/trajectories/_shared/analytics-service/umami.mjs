import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { UMAMI_BASE, UMAMI_APP_BASE, input, defaultInput } from './action-catalog.mjs';
import {
  escapeRegExp,
  safeGoto,
  bodyText,
  clickRequired,
  visibleFormScope,
  fillWithin,
  fillWithinOrNth,
  clickDomElement,
  clickLocator,
} from './page-interaction.mjs';

async function umamiRegisterAccount(s) {
  await safeGoto(s, `${UMAMI_BASE}/signup`);
  await humanIdlePause('long');
  if (/404|not found/i.test(await bodyText(s.page))) {
    await safeGoto(s, UMAMI_BASE);
    await clickRequired(s.page, [/sign up/i, /start free/i, /get started/i, /create account/i], 'Umami sign-up entry point');
  }

  const scope = await visibleFormScope(s.page);
  const email = input('EMAIL');
  const password = input('PASSWORD');
  const displayName = defaultInput('DISPLAY_NAME', email.split('@')[0] || 'Weles User');
  const filledName = await fillWithinOrNth(scope, s.page, displayName, [/name/i, /full name/i], 0);
  const filledEmail = await fillWithinOrNth(scope, s.page, email, [/email/i], filledName ? 1 : 0);
  const filledPassword = await fillWithinOrNth(scope, s.page, password, [/password/i], filledName ? 2 : 1);
  if (!filledEmail || !filledPassword) throw new Error('Umami sign-up fields were not fillable');

  if (!await clickDomElement(s.page, [
    'button[data-umami-event="signup-button-click"]',
    'form button[type="submit"]',
    'form button',
  ], /^Sign up$/i)) {
    await clickRequired(s.page, [/create account/i, /^sign up$/i, /start free/i, /^continue$/i, /^submit$/i], 'Umami sign-up submit button');
  }
  for (let i = 0; i < 40; i++) {
    const text = await bodyText(s.page);
    const url = s.page.url();
    if (/already exists|invalid|incorrect|required|failed|error/i.test(text)) {
      throw new Error(`Umami sign-up failed: ${text.slice(0, 500).replace(/\s+/g, ' ')}`);
    }
    if (/verify|verification|check your email|confirm your email/i.test(text) || (!/signup|register/i.test(url) && /dashboard|websites|analytics\/us/i.test(text))) {
      return { registration: { email, status: 'submitted_or_verified' } };
    }
    await humanIdlePause('short');
  }
  throw new Error(`Umami sign-up did not reach a verification or dashboard state: ${s.page.url()}`);
}

async function umamiCreateWebsite(s) {
  const addButton = s.page
    .getByRole('button', { name: /^Add website$/i })
    .or(s.page.locator('button').filter({ hasText: /^Add website$/i }))
    .filter({ visible: true })
    .first();
  if (!await addButton.isVisible().catch(() => false)) throw new Error('Umami Add website button was not visible');
  try {
    await addButton.scrollIntoViewIfNeeded();
    await humanClickLocator(s.page, addButton);
    await humanIdlePause('deliberate');
  } catch {
    if (!await clickLocator(s.page, addButton)) throw new Error('Umami Add website button was not clickable');
  }

  const dialog = s.page.getByRole('dialog').filter({ visible: true }).first();
  for (let i = 0; i < 20 && !await dialog.isVisible().catch(() => false); i++) {
    await humanIdlePause('short');
  }
  if (!await dialog.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, addButton);
    await humanIdlePause('deliberate');
    for (let i = 0; i < 20 && !await dialog.isVisible().catch(() => false); i++) {
      await humanIdlePause('short');
    }
  }
  if (!await dialog.isVisible().catch(() => false)) throw new Error('Umami Add website dialog did not open');

  const fields = dialog.locator('input:not([type="hidden"]), textarea').filter({ visible: true });
  let filledName = await fillWithin(dialog, s.page, input('DISPLAY_NAME'), [/^name$/i, /website name/i]);
  if (!filledName && await fields.nth(0).isVisible().catch(() => false)) {
    await humanFill(s.page, fields.nth(0), input('DISPLAY_NAME'));
    filledName = true;
  }
  let filledDomain = await fillWithin(dialog, s.page, input('DOMAIN'), [/^domain$/i, /website domain/i]);
  if (!filledDomain && await fields.nth(1).isVisible().catch(() => false)) {
    await humanFill(s.page, fields.nth(1), input('DOMAIN'));
    filledDomain = true;
  }
  if (!filledName || !filledDomain) throw new Error('Umami Add website dialog fields were not fillable');

  const saveButton = dialog
    .locator('button[data-test="button-submit"], button[type="submit"]')
    .or(dialog.getByRole('button', { name: /^(save|create|add|submit)$/i }))
    .or(dialog.locator('button').filter({ hasText: /^(save|create|add|submit)$/i }))
    .filter({ visible: true })
    .last();
  if (!await saveButton.isVisible().catch(() => false)) throw new Error('Umami Add website save button was not visible');

  const saveOutcome = s.page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /gateway-us\.umami\.is\/api\/.*websites|cloud\.umami\.is\/analytics\/us\/api\/.*websites/i.test(response.url())
  )).then(
    (response) => ({ observed: true, status: response.status() }),
    (waitError) => ({ observed: false, reason: `Umami never answered the website-create POST: ${waitError.message}` }),
  );
  await humanClickLocator(s.page, saveButton);
  const save = await saveOutcome;
  if (save.observed && save.status >= 400) {
    await humanIdlePause('short');
    const text = await bodyText(s.page);
    const serviceMessage = text.match(/Website limit reached\.?/i)?.[0];
    throw new Error(`Umami Add website save failed: ${serviceMessage ?? `HTTP ${save.status}`}`);
  }
  await humanIdlePause('long');
  await safeGoto(s, `${UMAMI_APP_BASE}/websites?search=${encodeURIComponent(input('DOMAIN'))}&page=1`);

  const domainPattern = new RegExp(escapeRegExp(input('DOMAIN')), 'i');
  for (let i = 0; i < 30; i++) {
    const text = await bodyText(s.page);
    if (domainPattern.test(text)) return;
    await humanIdlePause('short');
  }
  throw new Error(`Umami website ${input('DOMAIN')} was not visible after save`);
}

export {
  umamiRegisterAccount,
  umamiCreateWebsite,
};
