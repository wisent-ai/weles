import { editedValue, normalize, sha256 } from './plan.mjs';

export async function oneField(page, name) {
  const matching = page.locator(`[name$=${JSON.stringify(name)}]`);
  await matching.first().waitFor({ state: 'attached' });
  const visible = matching.filter({ visible: true });
  if (await visible.count() === 1) return visible;
  if (await matching.count() !== 1) throw new Error(`Ambiguous field: ${name}`);
  return matching;
}

export async function snapshotFields(page) {
  return page.locator('input[name], textarea[name], select[name]').evaluateAll((elements) => elements
    .filter((element) => element.type !== 'password' && element.name !== 'table_search')
    .map((element) => ({ name: element.name, tag: element.tagName, type: element.type,
      value: element.value, maxLength: element.getAttribute('maxlength'),
      readOnly: Boolean(element.readOnly), disabled: Boolean(element.disabled),
      options: element.tagName === 'SELECT' ? Array.from(element.options).map((option) => ({ value: option.value, label: option.label })) : undefined })));
}

function choiceInput(locator) {
  return locator.locator('xpath=ancestor::*[.//input[not(@name) and @type="text"]][1]')
    .locator('input[type="text"]:not([name])').filter({ visible: true });
}

export async function prepareFields(page, declared, plan, scope) {
  const prepared = [];
  for (const field of declared) {
    const names = field.namePattern
      ? (await snapshotFields(page)).filter((item) => new RegExp(field.namePattern).test(item.name)).map((item) => item.name)
      : [field.name];
    if (!names.length) throw new Error(`No fields match ${field.namePattern}`);
    for (const name of names) {
      const locator = await oneField(page, name);
      const before = await locator.inputValue();
      const state = await locator.evaluate((element) => ({
        tag: element.tagName, readOnly: Boolean(element.readOnly), disabled: Boolean(element.disabled),
        maxLength: element.getAttribute('maxlength'),
        options: element.tagName === 'SELECT' ? Array.from(element.options).map((option) => ({ value: option.value, label: option.label })) : [],
      }));
      let expected;
      let optionLabel;
      let control = field.control;
      if (field.control === 'select' && state.tag !== 'SELECT') {
        control = 'autocomplete';
        const display = await choiceInput(locator).inputValue();
        optionLabel = field.labelIncludes;
        expected = normalize(display).includes(normalize(optionLabel)) ? before : null;
      } else if (field.control === 'select') {
        const options = state.options.filter((option) => normalize(option.label).includes(normalize(field.labelIncludes)));
        if (options.length !== 1) throw new Error(`${scope}.${name}: expected one option containing ${field.labelIncludes}, found ${options.length}`);
        expected = options[0].value;
        optionLabel = options[0].label;
      } else expected = editedValue(before, field, plan);
      const max = state.maxLength === null ? field.maxLength : Number(state.maxLength);
      if (max && expected !== null && expected.length > max) throw new Error(`${scope}.${name}: ${expected.length} characters exceed the UI limit ${max}`);
      if (expected !== before && (state.readOnly || state.disabled)) throw new Error(`${scope}.${name} is not editable`);
      prepared.push({ scope, name, before, expected, optionLabel, control, sha256: sha256(expected) });
    }
  }
  return prepared;
}

export async function fillPrepared(page, fields) {
  const ordered = [...fields].sort((a, b) => Number(b.control === 'autocomplete') - Number(a.control === 'autocomplete'));
  for (const field of ordered) {
    if (field.before === field.expected) continue;
    const locator = await oneField(page, field.name);
    if (field.control === 'select') await locator.selectOption(field.expected);
    else if (field.control === 'autocomplete') {
      const input = choiceInput(locator);
      await input.locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]').dispatchEvent('mousedown');
      const option = page.getByRole('option').filter({ hasText: field.optionLabel }).filter({ visible: true });
      await option.waitFor({ state: 'visible' });
      if (await option.count() !== 1) throw new Error(`Ambiguous choice: ${field.optionLabel}`);
      const selectedLabel = await option.textContent();
      await option.dispatchEvent('click');
      await page.waitForFunction(({ name, before }) => {
        const element = document.querySelector(`[name=${JSON.stringify(name)}]`);
        return element?.value && element.value !== before;
      }, { name: field.name, before: field.before });
      field.expected = await locator.inputValue();
      field.optionLabel = selectedLabel;
      field.sha256 = sha256(field.expected);
    } else {
      await locator.focus();
      await locator.selectText();
      await page.keyboard.press('Backspace');
      await locator.type(field.expected);
      await locator.press('End');
      await locator.press('Tab');
    }
    await page.waitForFunction(({ name, expected }) => {
      const element = Array.from(document.querySelectorAll('[name]')).find((candidate) => candidate.name.endsWith(name) && candidate.getClientRects().length);
      return element?.value === expected;
    }, { name: field.name, expected: field.expected });
    if (await locator.inputValue() !== field.expected) throw new Error(`${field.scope}.${field.name}: value was not retained before saving`);
  }
  await page.waitForFunction((entries) => entries.every(([name, expected]) => {
    const element = Array.from(document.querySelectorAll('[name]')).find((candidate) => candidate.name.endsWith(name) && candidate.getClientRects().length);
    return element?.value === expected;
  }), fields.map((field) => [field.name, field.expected]));
}

export async function verifyPrepared(page, fields) {
  for (const field of fields) {
    const locator = await oneField(page, field.name);
    const actual = await locator.inputValue();
    field.actual = actual;
    field.persisted = actual === field.expected;
    if (field.control === 'select') {
      field.actualLabel = await locator.locator('option:checked').textContent();
      field.persisted &&= normalize(field.actualLabel) === normalize(field.optionLabel);
    }
    if (field.control === 'autocomplete') {
      field.actualLabel = await choiceInput(locator).inputValue();
      field.persisted &&= normalize(field.actualLabel).includes(normalize(field.optionLabel));
    }
    if (!field.persisted) throw new Error(`${field.scope}.${field.name}: persisted value differs (${sha256(actual)} != ${field.sha256})`);
  }
}

export async function nestedFields(page, row) {
  const declared = [...(row.fields || [])];
  for (const nested of [...(row.nestedRows || []), ...(row.nested ? [row.nested] : [])]) {
    const matches = (await snapshotFields(page)).filter((field) => field.name.endsWith(nested.matchFieldSuffix)
      && normalize(field.value).includes(normalize(nested.matchNeedle)));
    if (matches.length !== 1) throw new Error(`Nested row is ambiguous: ${nested.matchNeedle}`);
    const prefix = matches[0].name.slice(0, -nested.matchFieldSuffix.length);
    declared.push(...nested.fields.map((field) => ({ ...field, name: `${prefix}${field.nameSuffix}` })));
  }
  return declared;
}
