// Safe live readback for the replacement NCBR STEP B draft via Weles WSession.
// Logs in from env vars, reads state, optionally validates. Never submits.

import { WSession } from '../../../dist/index.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const PROJECT_URL = process.env.NCBR_PROJECT_URL || 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({
    error: 'MISSING_NCBR_CREDENTIALS',
    need: ['NCBR_EMAIL', 'NCBR_PASSWORD'],
  }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const session = await WSession.start({ label: 'ncbr_live_readback_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

async function visibleText(limit = 2000) {
  return (await page.locator('body').innerText().catch(() => '')).slice(0, limit);
}

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanFill(page, locator, value);
  await humanIdlePause('short');
}

await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: Weles-controlled LSI login navigation
await humanIdlePause('long');

const emailInput = page.locator('#mail, input[name="mail"]').first();
await setReactInputValue(emailInput, email);

const passwordInput = page.locator('#password, input[name="password"]').first();
await setReactInputValue(passwordInput, password);

const checkbox = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
if (await checkbox.count()) {
  const checked = await checkbox.isChecked().catch(() => false);
  if (!checked) {
    const checkboxTarget = checkbox.locator('xpath=ancestor::label[1]').or(page.locator('label:has(#isStatuteAccepted), label:has(input[name="isStatuteAccepted"])')).first();
    await humanClickLocator(page, await checkboxTarget.count() ? checkboxTarget : checkbox);
    await humanIdlePause('short');
  }
}

const loginButton = page.locator('#login-btn, button:has-text("Zaloguj")').first();
await page.waitForFunction(() => {
  const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
  return !!btn && !btn.disabled;
}, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for MUI login validation
await humanClickLocator(page, loginButton);
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
await humanIdlePause('long');

const afterLogin = {
  url: page.url(),
  title: await page.title().catch(() => ''),
  body: await visibleText(1200),
};

await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read-only project navigation
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
await humanIdlePause('long');

const validationResponses = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!url.includes('/validate-project')) return;
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  validationResponses.push({ status: res.status(), url, text });
});

let validationClick = null;
if (process.env.VALIDATE === '1') {
  const validateButton = page.getByRole('button', { name: 'Sprawdź wniosek', exact: true }).filter({ visible: true }).first();
  if (await validateButton.count() && !await validateButton.isDisabled()) {
    await humanClickLocator(page, validateButton);
    validationClick = { clicked: true };
  } else {
    validationClick = { clicked: false, reason: 'enabled Sprawdz wniosek button not found' };
  }
  if (validationClick.clicked) {
    await humanIdlePause('long');
    await humanIdlePause('long');
    await humanIdlePause('long');
  }
}

const state = await page.evaluate((responses) => {
  const body = document.body?.innerText || '';
  const buttons = Array.from(document.querySelectorAll('button'))
    .map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }))
    .filter((b) => b.text);
  const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    valueLength: 'value' in el ? String(el.value || '').length : null,
    ariaInvalid: el.getAttribute('aria-invalid'),
  }));
  const validation = {};
  const vr = responses.find((r) => r.url.includes('/validate-project'));
  if (vr) {
    validation.status = vr.status;
    try {
      const parsed = JSON.parse(vr.text);
      validation.keys = Object.keys(parsed);
      validation.jsonSchemaErrors = [];
      for (const sec of parsed.jsonSchemaValidationErrors || []) {
        for (const err of sec.validationResult?.errors || []) {
          validation.jsonSchemaErrors.push({
            sectionId: sec.sectionId,
            dataPath: err.dataPath,
            message: err.message,
            valueId: err.valueId,
            rootValueId: err.rootValueId,
          });
        }
      }
      validation.expressionErrors = [];
      for (const sec of parsed.expressionValidationErrors || []) {
        for (const err of sec.validationResult?.errors || []) {
          validation.expressionErrors.push({
            sectionId: sec.sectionId,
            dataPath: err.dataPath,
            message: err.message,
            valueId: err.valueId,
            rootValueId: err.rootValueId,
          });
        }
      }
    } catch (e) {
      validation.parseError = String(e?.message || e);
      validation.rawHead = vr.text.slice(0, 1000);
    }
  }
  return {
    url: location.href,
    title: document.title,
    bodyHead: body.slice(0, 2500),
    bodyTail: body.slice(-2500),
    buttons,
    inputs: inputs.slice(0, 120),
    validation,
  };
}, validationResponses); // allow-raw-playwright: read-only DOM state extraction

console.log(JSON.stringify({ afterLogin, validationClick, state }, null, 2));
await session.ctx.close();
process.exit(0);
