// UI validation runner for the NEW NCBR wniosek. Clicks "Sprawdz wniosek" only.
// Never submits and never closes the browser page.

import { chromium } from 'playwright';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import {
  pageSettled,
  responseAfterAction,
} from '../../_shared/page/settled.mjs';
import { projectValidationErrors } from '../validation.mjs';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const PROJECT_URL = (await import('#ncbr-settings')).projectUrl();

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }));
  process.exit(1);
}

const responses = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!/valid|check|ocen|submit|send|wniosek|project/i.test(url)) return;
  let text = null;
  let readError = null;
  try {
    text = await res.text();
  } catch (error) {
    readError = String(error?.message || error);
  }
  responses.push({ status: res.status(), url, text, readError });
});

await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });

const validateButton = page
  .getByRole('button', { name: 'Sprawdź wniosek', exact: true })
  .and(page.locator('button:not(:disabled):not([aria-disabled="true"])'))
  .filter({ visible: true })
  .first();
await validateButton.waitFor({ state: 'visible' });
const validationResponse = await responseAfterAction(
  page,
  (request) =>
    new URL(request.url()).pathname
      .replace(/\/$/, '')
      .endsWith('/validate-project'),
  () => validateButton.dispatchEvent('click'),
); // React button activation without changing page hit-testing or native focus.
const validateResponse = {
  status: validationResponse.status(),
  url: validationResponse.url(),
  text: await validationResponse.text(),
};
await pageSettled(page);

if (process.env.ACK) {
  if (process.env.ACK_DEBUG) {
    const candidates = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .filter(
          (b) =>
            b.innerText.trim() ===
            'Potwierdzam zapoznanie ze wszystkimi informacjami',
        )
        .map((b) => ({
          text: b.innerText.trim(),
          disabled: b.disabled,
          rects: b.getClientRects().length,
          hiddenAncestor: Boolean(
            b.closest('[aria-hidden="true"], .MuiModal-hidden'),
          ),
          modalClass:
            b.closest('.MuiDialog-root, .MuiModal-root')?.className || null,
          visibility: getComputedStyle(b).visibility,
          display: getComputedStyle(b).display,
        })),
    );
    console.log(JSON.stringify({ ackCandidates: candidates }, null, 2));
    process.exit(0);
  }
  const buttons = page
    .getByRole('button', {
      name: 'Potwierdzam zapoznanie ze wszystkimi informacjami',
      exact: true,
    })
    .filter({ visible: true });
  const count = await buttons.count();
  if (count > 0) await humanClickLocator(page, buttons.nth(count - 1));
  await pageSettled(page);
}

const out = await page.evaluate((capturedResponses) => {
  const body = document.body.innerText || '';
  const dialogs = Array.from(
    document.querySelectorAll(
      '[role="dialog"], .MuiDialog-root, .MuiAlert-root, .MuiSnackbar-root',
    ),
  )
    .map((e) => e.textContent.trim())
    .filter(Boolean);
  const errors = Array.from(
    document.querySelectorAll(
      '.MuiAlert-message, .Mui-error, [aria-invalid="true"], [role="alert"]',
    ),
  )
    .map((e) => (e.textContent || e.getAttribute('name') || '').trim())
    .filter(Boolean);
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) =>
      /błąd|blad|wymagan|uzupeł|niepopraw|nie może|walid|popraw/i.test(l),
    );
  return {
    url: location.href,
    dialogs,
    dialogHtml: Array.from(
      document.querySelectorAll('[role="dialog"], .MuiDialog-root'),
    ).map((e) => e.outerHTML),
    errors,
    lines: lines,
    buttons: Array.from(document.querySelectorAll('button'))
      .map((b) => ({
        text: b.innerText.trim() || b.getAttribute('aria-label') || b.title,
        disabled: b.disabled,
      }))
      .filter((b) => b.text),
    responses: capturedResponses,
    body,
  };
}, responses);

out.validationStatus = validateResponse.status;
out.validationMethod = validationResponse.request().method();
out.validationUrl = validateResponse.url;
try {
  const parsed = JSON.parse(validateResponse.text);
  const parsedErrors = projectValidationErrors(
    parsed,
    `${out.validationMethod} ${out.validationUrl}`,
  );
  out.validationTopLevel = Object.fromEntries(
    Object.entries(parsed).filter(
      ([, v]) => !Array.isArray(v) && typeof v !== 'object',
    ),
  );
  out.validationKeys = parsedErrors.keys;
  out.validationErrors = parsedErrors.jsonSchemaErrors;
  out.expressionValidationErrors = parsed.expressionValidationErrors;
  out.expressionErrors = parsedErrors.expressionErrors;
  out.sectionCorrectionValidationErrors =
    parsedErrors.sectionCorrectionValidationErrors;
} catch (e) {
  out.validationParseError = String(e?.message || e);
}
const validationFailed =
  out.validationStatus !== 200 ||
  out.validationParseError ||
  out.validationErrors?.length ||
  out.expressionErrors?.length ||
  out.sectionCorrectionValidationErrors?.length;
process.exitCode = validationFailed ? 1 : 0;

if (process.env.ERRORS_ONLY) {
  console.log(
    JSON.stringify(
      {
        validationStatus: out.validationStatus,
        validationMethod: out.validationMethod,
        validationUrl: out.validationUrl,
        validationKeys: out.validationKeys,
        validationTopLevel: out.validationTopLevel,
        validationErrors: out.validationErrors || [],
        expressionErrors: out.expressionErrors || [],
        sectionCorrectionValidationErrors:
          out.sectionCorrectionValidationErrors || [],
        validationParseError: out.validationParseError || null,
      },
      null,
      2,
    ),
  );
  process.exit(process.exitCode);
}

if (process.env.BUTTONS_ONLY) {
  console.log(
    JSON.stringify(
      {
        validationStatus: out.validationStatus,
        validationMethod: out.validationMethod,
        validationUrl: out.validationUrl,
        validationParseError: out.validationParseError || null,
        expressionErrors: out.expressionErrors || [],
        sectionCorrectionValidationErrors:
          out.sectionCorrectionValidationErrors || [],
        validationErrors: out.validationErrors || [],
        submitButtons: out.buttons.filter((b) => b.text === 'Złóż wniosek'),
        dialogs: out.dialogs,
      },
      null,
      2,
    ),
  );
  process.exit(process.exitCode);
}

console.log(JSON.stringify(out, null, 2));
process.exit(process.exitCode);
