import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled, responseAfterAction } from '../page/settled.mjs';
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
} from './page-interaction.mjs';

async function umamiRegisterAccount(s) {
  await safeGoto(s, `${UMAMI_BASE}/signup`);
  await pageSettled(s.page);
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
  // clickDomElement / clickRequired leave the page settled after the submit.
  const text = await bodyText(s.page);
  const url = s.page.url();
  if (/already exists|invalid|incorrect|required|failed|error/i.test(text)) {
    throw new Error(`Umami sign-up failed: ${text.replace(/\s+/g, ' ')}`);
  }
  if (/verify|verification|check your email|confirm your email/i.test(text) || (!/signup|register/i.test(url) && /dashboard|websites|analytics\/us/i.test(text))) {
    return { registration: { email, status: 'submitted_or_verified' } };
  }
  throw new Error(`Umami sign-up did not reach a verification or dashboard state: ${s.page.url()}`);
}

async function umamiCreateWebsite(s) {
  const addButton = s.page
    .getByRole('button', { name: /^Add website$/i })
    .or(s.page.locator('button').filter({ hasText: /^Add website$/i }))
    .filter({ visible: true })
    .first();
  if (!await addButton.isVisible()) throw new Error('Umami Add website button was not visible');
  await addButton.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, addButton);
  const dialog = s.page.getByRole('dialog').filter({ visible: true }).first();
  await dialog.waitFor({ state: 'visible' });

  const fields = dialog.locator('input:not([type="hidden"]), textarea').filter({ visible: true });
  let filledName = await fillWithin(dialog, s.page, input('DISPLAY_NAME'), [/^name$/i, /website name/i]);
  if (!filledName && await fields.nth(0).isVisible()) {
    await humanFill(s.page, fields.nth(0), input('DISPLAY_NAME'));
    filledName = true;
  }
  let filledDomain = await fillWithin(dialog, s.page, input('DOMAIN'), [/^domain$/i, /website domain/i]);
  if (!filledDomain && await fields.nth(1).isVisible()) {
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
  if (!await saveButton.isVisible()) throw new Error('Umami Add website save button was not visible');
  if (!await saveButton.isEnabled()) throw Object.assign(new Error('Umami Add website save button was disabled'),
    { code: 'UMAMI_WEBSITE_SAVE_NOT_ENABLED', pageUrl: s.page.url() });

  const response = await responseAfterAction(s.page,
    (request) => request.method() === 'POST'
      && /gateway-us\.umami\.is\/api\/.*websites|cloud\.umami\.is\/analytics\/us\/api\/.*websites/i.test(request.url()),
    () => humanClickLocator(s.page, saveButton));
  const status = response.status();
  const requestUrl = response.url();
  let body;
  try {
    body = await response.text();
  } catch (cause) {
    throw Object.assign(new Error(`Umami website-save response could not be read at ${requestUrl}`, { cause }),
      { code: 'UMAMI_WEBSITE_RESPONSE_FAILED', requestMethod: 'POST', requestUrl, status });
  }
  if (!response.ok()) throw Object.assign(new Error(`Umami Add website save failed: HTTP ${status} ${body}`),
    { code: 'UMAMI_WEBSITE_SAVE_HTTP_ERROR', requestMethod: 'POST', requestUrl, status });
  await pageSettled(s.page);
  await safeGoto(s, `${UMAMI_APP_BASE}/websites?search=${encodeURIComponent(input('DOMAIN'))}&page=1`);

  const domainPattern = new RegExp(escapeRegExp(input('DOMAIN')), 'i');
  await pageSettled(s.page);
  if (domainPattern.test(await bodyText(s.page))) return;
  throw new Error(`Umami website ${input('DOMAIN')} was not visible after save`);
}

export {
  umamiRegisterAccount,
  umamiCreateWebsite,
};
