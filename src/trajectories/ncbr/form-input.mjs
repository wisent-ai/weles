import { humanFill } from '../../../dist/human/keyboard.js';

// A value goes into an LSI field whole or not at all: a value longer than the
// field's maxlength is refused with both lengths. Cutting it at a word filed
// shortened texts nobody wrote (repair/text/fix_truncated_textareas_new.mjs
// exists to undo them).
export async function fillField(page, locator, value) {
  await locator.waitFor({ state: 'visible' });
  const next = String(value);
  const declared = await locator.getAttribute('maxlength');
  const max = declared === null ? null : Number(declared);
  if (max !== null && next.length > max) {
    throw Object.assign(
      new Error(
        `LSI_FIELD_TOO_LONG: ${locator}; expected length=${next.length}, maximum=${max}`,
      ),
      {
        code: 'LSI_FIELD_TOO_LONG',
        expectedLength: next.length,
        max,
      },
    );
  }
  const before = await locator.inputValue();
  if (before === next) return { len: next.length, max, changed: false };
  const state = await locator.evaluate((el) => ({
    field: el.name || el.id || el.tagName,
    readOnly: Boolean(el.readOnly),
    disabled: Boolean(
      el.disabled ||
        el.matches(':disabled') ||
        el.getAttribute('aria-disabled') === 'true',
    ),
  })); // allow-raw-playwright: inspect the requested field, never override its mutability
  if (state.readOnly || state.disabled) {
    const error = new Error(
      `LSI_FIELD_LOCKED: ${JSON.stringify(state)}; the requested value differs from the visible field`,
    );
    error.code = 'LSI_FIELD_LOCKED';
    throw error;
  }
  await humanFill(page, locator, next);
  await page.keyboard.press('Tab'); // allow-raw-playwright: commit the field through a real blur gesture
  const actual = await locator.inputValue();
  if (actual !== next) {
    const error = new Error(
      `LSI_FIELD_VALUE_MISMATCH: ${state.field}; expected length=${next.length}, observed length=${actual.length}`,
    );
    error.code = 'LSI_FIELD_VALUE_MISMATCH';
    throw error;
  }
  return { len: next.length, max, changed: true };
}

export async function selectRadio(page, locator) {
  await locator.waitFor({ state: 'attached' });
  if (await locator.isChecked()) return { changed: false };
  if (
    !(await locator.isEnabled()) ||
    (await locator.getAttribute('aria-disabled')) === 'true'
  ) {
    throw Object.assign(new Error(`LSI_RADIO_DISABLED: ${locator}`), {
      code: 'LSI_RADIO_DISABLED',
      pageUrl: page.url(),
    });
  }
  await locator.dispatchEvent('click'); // allow-raw-playwright: preserve the LSI radio input event path
  if (!(await locator.isChecked())) {
    throw Object.assign(
      new Error(
        `LSI_RADIO_SELECTION_MISMATCH: ${locator} is not checked after its click`,
      ),
      {
        code: 'LSI_RADIO_SELECTION_MISMATCH',
        pageUrl: page.url(),
      },
    );
  }
  return { changed: true };
}
