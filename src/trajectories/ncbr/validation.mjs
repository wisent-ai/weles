import { humanClickLocator } from '../../../dist/human/mouse.js';
import { responseAfterAction } from '../_shared/page/settled.mjs';

// Validates the selected project through its visible action, never submission.
export async function validateProject(page, projectUrl) {
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: project validation navigation
  const button = page.getByRole('button', { name: 'Sprawdź wniosek', exact: true })
    .and(page.locator('button:not(:disabled):not([aria-disabled="true"])')).filter({ visible: true }).first();
  await button.waitFor({ state: 'visible' });
  const response = await responseAfterAction(page,
    (request) => new URL(request.url()).pathname.replace(/\/$/, '').endsWith('/validate-project'),
    () => humanClickLocator(page, button));
  const operation = `${response.request().method()} ${response.url()}`;
  if (!response.ok()) throw new Error(`LSI_VALIDATION_HTTP_ERROR: ${operation}; HTTP ${response.status()} ${response.statusText()}`);
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw new Error(`LSI_VALIDATION_BODY_FAILED: ${operation}`, { cause });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`LSI_VALIDATION_RESPONSE_INVALID: ${operation}; response is not JSON`, { cause });
  }
  return {
    clicked: { clicked: true },
    status: response.status(),
    ...projectValidationErrors(parsed, operation),
    rawHead: text,
  };
}

export function projectValidationErrors(parsed, operation) {
  const flatten = (name) => {
    const sections = parsed?.[name];
    if (!Array.isArray(sections)) throw new Error(`LSI_VALIDATION_RESPONSE_INVALID: ${operation}; ${name} is not an array`);
    return sections.flatMap((section, sectionIndex) => {
      const errors = section?.validationResult?.errors;
      if (!Array.isArray(errors)) throw new Error(`LSI_VALIDATION_RESPONSE_INVALID: ${operation}; ${name}[${sectionIndex}].validationResult.errors is not an array`);
      return errors.map((error, errorIndex) => {
        if (!error || typeof error !== 'object' || Array.isArray(error)) throw new Error(`LSI_VALIDATION_RESPONSE_INVALID: ${operation}; ${name}[${sectionIndex}].validationResult.errors[${errorIndex}] is not an object`);
        return { sectionId: section.sectionId, dataPath: error.dataPath, message: error.message, valueId: error.valueId, rootValueId: error.rootValueId };
      });
    });
  };
  const corrections = parsed?.sectionCorrectionValidationErrors ?? [];
  if (!Array.isArray(corrections)) throw new Error(`LSI_VALIDATION_RESPONSE_INVALID: ${operation}; sectionCorrectionValidationErrors is not an array`);
  return {
    jsonSchemaErrors: flatten('jsonSchemaValidationErrors'),
    expressionErrors: flatten('expressionValidationErrors'),
    sectionCorrectionValidationErrors: corrections,
    keys: Object.keys(parsed),
  };
}
