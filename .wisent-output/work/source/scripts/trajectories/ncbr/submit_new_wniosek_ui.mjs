// Final UI-only submission for the NEW NCBR wniosek (project 8bab411b).
// Assumes live validation has already returned clean status. Never closes page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const PROJECT_URL = 'https://lsi2.ncbr.gov.pl/projekt/8bab411b-170f-438d-a148-f71eb0ab2c9f';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(1); }
page.setDefaultTimeout(20000);

const responses = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!/submit|send|sign|zloz|wniosek|project|validate/i.test(url)) return;
  let text = '';
  try { text = await res.text(); } catch {}
  responses.push({ status: res.status(), url, text: text.slice(0, 2000) });
});

await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');

await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralize cookie banner only

async function clickVisibleButton(text) {
  const clicked = await page.evaluate((text) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) =>
      b.innerText.trim() === text
      && !b.disabled
      && b.getClientRects().length
      && getComputedStyle(b).visibility !== 'hidden'
      && !b.closest('[aria-hidden="true"], .MuiModal-hidden')
    );
    if (!btns.length) return false;
    btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, text); // allow-raw-playwright: click exact visible enabled UI button
  if (clicked) await humanIdlePause('long');
  return clicked;
}

async function buttonState(text) {
  return await page.evaluate((text) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) =>
      b.innerText.trim() === text
      && b.getClientRects().length
      && getComputedStyle(b).visibility !== 'hidden'
      && !b.closest('[aria-hidden="true"], .MuiModal-hidden')
    );
    if (!btns.length) return null;
    const b = btns[btns.length - 1];
    return { disabled: b.disabled, text: b.innerText.trim() };
  }, text); // allow-raw-playwright: read exact visible button state
}

async function runValidationIfNeeded() {
  const submit = await buttonState('Złóż wniosek');
  if (submit && submit.disabled === false) return { ran: false };
  const start = responses.length;
  if (!(await clickVisibleButton('Sprawdź wniosek'))) throw new Error('Sprawdź wniosek not found');
  await humanIdlePause('long');
  await humanIdlePause('long');
  await humanIdlePause('long');
  await clickVisibleButton('Potwierdzam zapoznanie ze wszystkimi informacjami');
  const validation = responses.slice(start).reverse().find((r) => r.url.includes('/validate-project'));
  if (!validation) return { ran: true, validation: null };
  let parsed = null;
  try { parsed = JSON.parse(validation.text); } catch {}
  const errors = [
    ...(parsed?.jsonSchemaValidationErrors || []),
    ...(parsed?.expressionValidationErrors || []),
    ...(parsed?.sectionCorrectionValidationErrors || []),
  ];
  if (validation.status !== 200 || errors.length) {
    throw new Error(`validation failed before submit: ${validation.status}`);
  }
  return { ran: true, validation: { status: validation.status, keys: parsed ? Object.keys(parsed) : [] } };
}

// Close validation-result modal if it is still open from the last safe validation.
await clickVisibleButton('Potwierdzam zapoznanie ze wszystkimi informacjami');
const validationBeforeSubmit = await runValidationIfNeeded();

const before = await page.evaluate(() => ({
  url: location.href,
  bodyHead: (document.body.innerText || '').slice(0, 1200),
  buttons: Array.from(document.querySelectorAll('button')).map((b) => ({
    text: b.innerText.trim() || b.getAttribute('aria-label') || b.title,
    disabled: b.disabled,
    visible: Boolean(b.getClientRects().length) && getComputedStyle(b).visibility !== 'hidden',
  })).filter((b) => b.text).slice(0, 100),
}));

const submittedClick = await clickVisibleButton('Złóż wniosek');
if (!submittedClick) {
  console.log(JSON.stringify({ error: 'SUBMIT_BUTTON_NOT_FOUND', before }, null, 2));
  process.exit(1);
}

await humanIdlePause('long');
await humanIdlePause('long');

// If LSI asks for a final confirmation, accept the affirmative action.
const confirmTexts = [
  'Potwierdzam',
  'Tak',
  'Złóż wniosek',
  'Złóż',
];
const clickedConfirm = [];
for (const text of confirmTexts) {
  if (await clickVisibleButton(text)) clickedConfirm.push(text);
}

await humanIdlePause('long');
await humanIdlePause('long');

const after = await page.evaluate((capturedResponses) => {
  const body = document.body.innerText || '';
  return {
    url: location.href,
    title: document.title,
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiAlert-root, .MuiSnackbar-root')).map((e) => e.textContent.trim()).filter(Boolean).slice(0, 20),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({
      text: b.innerText.trim() || b.getAttribute('aria-label') || b.title,
      disabled: b.disabled,
    })).filter((b) => b.text).slice(0, 100),
    bodyHead: body.slice(0, 2500),
    bodyTail: body.slice(-2500),
    responses: capturedResponses.slice(-40),
  };
}, responses);

console.log(JSON.stringify({ validationBeforeSubmit, submittedClick, clickedConfirm, after }, null, 2));
process.exit(0);
