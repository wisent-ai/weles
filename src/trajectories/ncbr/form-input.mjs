import { humanFill } from '../../../dist/human/keyboard.js';

export async function fillField(page, locator, value, { truncate = true } = {}) {
  await locator.waitFor({ state: 'visible' });
  const max = Number(await locator.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) {
    if (!truncate) {
      throw Object.assign(new Error(`LSI_FIELD_TOO_LONG: ${locator}; expected length=${next.length}, maximum=${max}`), {
        code: 'LSI_FIELD_TOO_LONG', expectedLength: next.length, max,
      });
    }
    next = next.slice(0, max).replace(/\s+\S*$/, '');
  }
  const before = await locator.inputValue();
  if (before === next) return { len: next.length, max, changed: false };
  const state = await locator.evaluate((el) => ({
    field: el.name || el.id || el.tagName,
    readOnly: Boolean(el.readOnly),
    disabled: Boolean(el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'),
  })); // allow-raw-playwright: inspect the requested field, never override its mutability
  if (state.readOnly || state.disabled) {
    const error = new Error(`LSI_FIELD_LOCKED: ${JSON.stringify(state)}; the requested value differs from the visible field`);
    error.code = 'LSI_FIELD_LOCKED';
    throw error;
  }
  await humanFill(page, locator, next);
  await page.keyboard.press('Tab'); // allow-raw-playwright: commit the field through a real blur gesture
  const actual = await locator.inputValue();
  if (actual !== next) {
    const error = new Error(`LSI_FIELD_VALUE_MISMATCH: ${state.field}; expected length=${next.length}, observed length=${actual.length}`);
    error.code = 'LSI_FIELD_VALUE_MISMATCH';
    throw error;
  }
  return { len: next.length, max, changed: true };
}
