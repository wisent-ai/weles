// UI validation runner for the NEW NCBR wniosek. Clicks "Sprawdz wniosek" only.
// Never submits and never closes the browser page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const PROJECT_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(15000);
const responses = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!/valid|check|ocen|submit|send|wniosek|project/i.test(url)) return;
  let text = '';
  try {
    const raw = await res.text();
    text = url.includes('/validate-project') ? raw : raw.slice(0, 12000);
  } catch (e) { text = ''; }
  responses.push({ status: res.status(), url, text });
});

await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Sprawdź wniosek' && b.getClientRects().length);
  if (!btn) throw new Error('Sprawdź wniosek button not found');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}); // allow-raw-playwright: trigger validation only, not submission

await humanIdlePause('long');
await humanIdlePause('long');
await humanIdlePause('long');

if (process.env.ACK) {
  if (process.env.ACK_DEBUG) {
    const candidates = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Potwierdzam zapoznanie ze wszystkimi informacjami').map((b) => ({
      text: b.innerText.trim(),
      disabled: b.disabled,
      rects: b.getClientRects().length,
      hiddenAncestor: Boolean(b.closest('[aria-hidden="true"], .MuiModal-hidden')),
      modalClass: b.closest('.MuiDialog-root, .MuiModal-root')?.className || null,
      visibility: getComputedStyle(b).visibility,
      display: getComputedStyle(b).display,
    })));
    console.log(JSON.stringify({ ackCandidates: candidates }, null, 2));
    process.exit(0);
  }
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
      b.innerText.trim() === 'Potwierdzam zapoznanie ze wszystkimi informacjami'
      && !b.disabled
      && b.getClientRects().length
      && getComputedStyle(b).visibility !== 'hidden'
      && !b.closest('[aria-hidden="true"], .MuiModal-hidden')
    );
    if (buttons.length) buttons[buttons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: acknowledge visible validation result modal only
  await humanIdlePause('long');
}

const out = await page.evaluate((capturedResponses) => {
  const body = document.body.innerText || '';
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiAlert-root, .MuiSnackbar-root')).map((e) => e.textContent.trim()).filter(Boolean);
  const errors = Array.from(document.querySelectorAll('.MuiAlert-message, .Mui-error, [aria-invalid="true"], [role="alert"]')).map((e) => (e.textContent || e.getAttribute('name') || '').trim()).filter(Boolean);
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => /błąd|blad|wymagan|uzupeł|niepopraw|nie może|walid|popraw/i.test(l));
  return {
    url: location.href,
    dialogs: dialogs.slice(0, 20),
    dialogHtml: Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root')).map((e) => e.outerHTML.slice(0, 3000)).slice(0, 5),
    errors: errors.slice(0, 80),
    lines: lines.slice(0, 200),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim() || b.getAttribute('aria-label') || b.title, disabled: b.disabled })).filter((b) => b.text).slice(0, 80),
    responses: capturedResponses.slice(-40),
    bodyTail: body.slice(-4000),
  };
}, responses);

const validateResponse = responses.find((r) => r.url.includes('/validate-project'));
if (validateResponse) {
  try {
    const parsed = JSON.parse(validateResponse.text);
    out.validationStatus = validateResponse.status;
    out.validationTopLevel = Object.fromEntries(Object.entries(parsed).filter(([, v]) => !Array.isArray(v) && typeof v !== 'object').slice(0, 30));
    out.validationKeys = Object.keys(parsed);
    out.validationErrors = [];
    for (const sec of parsed.jsonSchemaValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) {
        out.validationErrors.push({
          sectionId: sec.sectionId,
          dataPath: err.dataPath,
          message: err.message,
          valueId: err.valueId,
          rootValueId: err.rootValueId,
        });
      }
    }
    out.expressionValidationErrors = parsed.expressionValidationErrors || [];
    out.expressionErrors = [];
    for (const sec of parsed.expressionValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) {
        out.expressionErrors.push({
          sectionId: sec.sectionId,
          dataPath: err.dataPath,
          message: err.message,
          valueId: err.valueId,
          rootValueId: err.rootValueId,
        });
      }
    }
    out.sectionCorrectionValidationErrors = parsed.sectionCorrectionValidationErrors || [];
  } catch (e) {
    out.validationParseError = String(e?.message || e);
  }
}

if (process.env.ERRORS_ONLY) {
  console.log(JSON.stringify({
    validationStatus: out.validationStatus,
    validationKeys: out.validationKeys,
    validationTopLevel: out.validationTopLevel,
    validationErrors: out.validationErrors || [],
    expressionErrors: out.expressionErrors || [],
    sectionCorrectionValidationErrors: out.sectionCorrectionValidationErrors || [],
    validationParseError: out.validationParseError || null,
  }, null, 2));
  process.exit(0);
}

if (process.env.BUTTONS_ONLY) {
  console.log(JSON.stringify({
    validationErrors: out.validationErrors || [],
    submitButtons: out.buttons.filter((b) => b.text === 'Złóż wniosek'),
    dialogs: out.dialogs,
  }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
