// The legal-act row form, bound to the page: its diagnostics, the text-like fields, the act
// type and act autocomplete, saving, and filling a whole row.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { rowNeedles, target } from './source.mjs';

export function legalActForm({ page }) {
async function diagForm(opened) {
  const form = await page.evaluate(({ opened, target }) => ({
    opened,
    target,
    fields: Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.offsetParent !== null).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      const wrapper = el.closest('.MuiFormControl-root, label, form, section, .MuiBox-root');
      return {
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        role: el.getAttribute('role') || '',
        value: (el.value || '').slice(0, 220),
        len: (el.value || '').length,
        max: el.getAttribute('maxlength'),
        label,
        nearby: wrapper ? wrapper.textContent.trim().replace(/\s+/g, ' ').slice(0, 300) : '',
        readOnly: el.readOnly,
        disabled: el.disabled,
      };
    }),
    buttons: Array.from(document.querySelectorAll('button')).map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })).filter((button) => button.text),
  }), { opened, target }); // allow-raw-playwright: inspect legal-act edit form only
  console.log(JSON.stringify(form, null, 2));
}

async function fillTextLikeField(predicate, value) {
  const result = await page.evaluate(({ predicateSource, value }) => {
    const predicate = new Function('el', `return (${predicateSource})(el);`);
    const fields = Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.offsetParent !== null && !el.disabled && !el.readOnly);
    const field = fields.find((el) => predicate(el));
    if (!field) return { filled: false, fields: fields.map((el) => ({ name: el.name || '', value: (el.value || '').slice(0, 80), tag: el.tagName, role: el.getAttribute('role') || '' })) };
    const max = Number(field.getAttribute('maxlength')) || value.length;
    let next = String(value);
    if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    if (setter) setter.call(field, next);
    else field.value = next;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next.slice(0, 20) }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('blur', { bubbles: true }));
    return { filled: true, name: field.name || '', valueLength: next.length, max };
  }, { predicateSource: predicate.toString(), value }); // allow-raw-playwright: fill visible legal-act text field through DOM setter
  await humanIdlePause('short');
  return result;
}

async function setActTypeIfPresent() {
  const input = page.locator('input[role="combobox"]').filter({ hasText: '' }).first();
  if (await input.count() === 0) return { skipped: 'no combobox' };
  const name = await input.getAttribute('name');
  const value = await input.inputValue().catch(() => '');
  if (!/akt|prawn|rodzaj|typ|przepis/i.test(name || value)) return { skipped: `combobox not obviously act field: ${name || ''}` };
  await humanFill(page, input, 'Pozostałe inne');
  await humanIdlePause('deliberate');
  const option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: 'Pozostałe inne' }).first();
  if (await option.count() === 0) return { skipped: 'Pozostałe inne option not found' };
  await option.dispatchEvent('click'); // allow-raw-playwright: select legal-act type
  await humanIdlePause('short');
  return { selected: 'Pozostałe inne' };
}

async function setLegalAct(row) {
  const input = page.locator('input[name="akt_prawny"]').first();
  await input.waitFor({ state: 'visible' });
  const optionText = row.kind === 'inne'
    ? 'inne (w polu uzasadnienie wpisz jakie)'
    : row.act;
  const searches = row.kind === 'inne'
    ? ['inne']
    : /odpadach/i.test(row.act)
      ? ['ustawa z dnia 14 grudnia', 'odpadach', row.act]
      : /Prawo ochrony środowiska/i.test(row.act)
        ? ['Prawo ochrony środowiska', 'ustawa Prawo ochrony środowiska', row.act]
        : /Prawo wodne/i.test(row.act)
          ? ['Prawo wodne', 'ustawa Prawo wodne', row.act]
          : /ochronie przyrody/i.test(row.act)
            ? ['ochrony przyrody', 'ustawa o ochronie przyrody', row.act]
            : /3 października 2008|udostępnianiu informacji/i.test(row.act)
              ? ['ustawa OOŚ', 'udostępnianiu informacji', row.act]
              : [row.act];
  let option = null;
  let seen = [];
  for (const search of searches) {
    await humanFill(page, input, search);
    await humanIdlePause('deliberate');
    seen = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option'], [role='option']"))
      .map((o) => o.textContent.trim())
      .filter(Boolean)
      .slice(0, 30)); // allow-raw-playwright: read visible legal-act options only
    option = page.getByRole('option', { name: optionText, exact: true }).first();
    if (await option.count() === 0) {
      const needle = row.kind === 'inne' ? 'inne' : rowNeedles(row)[0];
      option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: needle }).first();
    }
    if (await option.count() > 0) break;
  }
  if (await option.count() === 0) {
    throw new Error(`legal act option not found: ${row.act}; seen=${seen.join(' | ')}`);
  }
  const picked = (await option.textContent())?.trim() || optionText;
  await option.dispatchEvent('click'); // allow-raw-playwright: select legal-act option
  await humanIdlePause('short');
  return picked;
}

async function saveRow() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const buttons = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const count = await buttons.count();
  const state = count > 0
    ? { status: 'saved', errors: [] }
    : {
        status: 'no-enabled-save',
        errors: await page.locator('[aria-invalid="true"], .Mui-error').allTextContents(),
      };
  if (count > 0) await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
  return state;
}

async function fillLegalActForm(row) {
  const picked = await setLegalAct(row);
  const justFill = await fillTextLikeField((el) => {
    const name = el.name || '';
    return name === 'uzasadnienie' || name.endsWith('.uzasadnienie');
  }, row.formJustification);
  const save = await saveRow();
  return { picked, justFill, save };
}
  return { diagForm, fillTextLikeField, setActTypeIfPresent, setLegalAct, saveRow, fillLegalActForm };
}
