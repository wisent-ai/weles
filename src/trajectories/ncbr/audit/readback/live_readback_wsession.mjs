// Safe live readback for the replacement NCBR STEP B draft via Weles WSession.
// Logs in from env vars, reads state, optionally validates. Never submits.

import { WSession } from '../../../../../dist/index.js';
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { validateProject } from '../../validation.mjs';

const PROJECT_URL = (await import('#ncbr-settings')).projectUrl();
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(
    JSON.stringify(
      {
        error: 'MISSING_NCBR_CREDENTIALS',
        need: ['NCBR_EMAIL', 'NCBR_PASSWORD'],
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const session = await WSession.start({
  label: 'ncbr_live_readback_wsession',
  proxy: 'direct',
  browser: 'chromium',
});
const page = session.page;

async function visibleText(limit = 2000) {
  return (
    await page
      .locator('body')
      .innerText()
      .catch(() => '')
  ).slice(0, limit);
}

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanFill(page, locator, value);
}

await page.goto('https://lsi2.ncbr.gov.pl/logowanie', {
  waitUntil: 'domcontentloaded',
}); // allow-raw-playwright: Weles-controlled LSI login navigation

const emailInput = page.locator('#mail, input[name="mail"]').first();
await setReactInputValue(emailInput, email);

const passwordInput = page.locator('#password, input[name="password"]').first();
await setReactInputValue(passwordInput, password);

const checkbox = page
  .locator('#isStatuteAccepted, input[name="isStatuteAccepted"]')
  .first();
if (await checkbox.count()) {
  const checked = await checkbox.isChecked();
  if (!checked) {
    const checkboxTarget = checkbox
      .locator('xpath=ancestor::label[1]')
      .or(
        page.locator(
          'label:has(#isStatuteAccepted), label:has(input[name="isStatuteAccepted"])',
        ),
      )
      .first();
    await humanClickLocator(
      page,
      (await checkboxTarget.count()) ? checkboxTarget : checkbox,
    );
  }
}

const loginButton = page
  .locator('#login-btn, button:has-text("Zaloguj")')
  .first();
await page.waitForFunction(
  () => {
    const btn =
      document.querySelector('#login-btn') ||
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.innerText.trim() === 'Zaloguj',
      );
    return !!btn && !btn.disabled;
  },
  null,
  { polling: 'raf' },
); // allow-raw-playwright: wait for MUI login validation
await humanClickLocator(page, loginButton);
await page.waitForLoadState('load');
await humanIdlePause('long');

const afterLogin = {
  url: page.url(),
  title: await page.title().catch(() => ''),
  body: await visibleText(1200),
};

let validation = null;
if (process.env.VALIDATE === '1') {
  validation = await validateProject(page, PROJECT_URL);
} else {
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only project navigation
  await page.waitForLoadState('load');
  await humanIdlePause('long');
}
const validationClick = validation?.clicked ?? null;

const state = await page.evaluate(() => {
  const body = document.body?.innerText || '';
  const buttons = Array.from(document.querySelectorAll('button'))
    .map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }))
    .filter((b) => b.text);
  const inputs = Array.from(
    document.querySelectorAll('input, textarea, select'),
  ).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    valueLength: 'value' in el ? String(el.value || '').length : null,
    ariaInvalid: el.getAttribute('aria-invalid'),
  }));
  return {
    url: location.href,
    title: document.title,
    body,
    buttons,
    inputs: inputs,
  };
}); // allow-raw-playwright: read-only DOM state extraction
state.validation = validation
  ? {
      status: validation.status,
      keys: validation.keys,
      jsonSchemaErrors: validation.jsonSchemaErrors,
      expressionErrors: validation.expressionErrors,
      sectionCorrectionValidationErrors:
        validation.sectionCorrectionValidationErrors,
    }
  : {};

console.log(JSON.stringify({ afterLogin, validationClick, state }, null, 2));
await session.ctx.close();
process.exit(0);
