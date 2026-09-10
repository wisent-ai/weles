import { editedValue, normalize, sha256 } from './plan.mjs';

export async function oneField(page, name) {
  const all = page.locator('[name]').filter({ hasNot: page.locator('[type="password"]') });
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
      if (field.control === 'select') {
        const options = state.options.filter((option) => normalize(option.label).includes(normalize(field.labelIncludes)));
        if (options.length !== 1) throw new Error(`${scope}.${name}: expected one option containing ${field.labelIncludes}, found ${options.length}`);
        expected = options[0].value;
        optionLabel = options[0].label;
      } else expected = editedValue(before, field, plan);
      const max = state.maxLength === null ? field.maxLength : Number(state.maxLength);
      if (max && expected.length > max) throw new Error(`${scope}.${name}: ${expected.length} characters exceed the UI limit ${max}`);
      if (expected !== before && (state.readOnly || state.disabled)) throw new Error(`${scope}.${name} is not editable`);
      prepared.push({ scope, name, before, expected, optionLabel, control: field.control, sha256: sha256(expected) });
    }
  }
  return prepared;
}

export async function fillPrepared(page, fields) {
  for (const field of fields) {
    if (field.before === field.expected) continue;
    const locator = await oneField(page, field.name);
    if (field.control === 'select') await locator.selectOption(field.expected);
    else await locator.fill(field.expected);
    await locator.dispatchEvent('blur');
    if (await locator.inputValue() !== field.expected) throw new Error(`${field.scope}.${field.name}: value was not retained before saving`);
  }
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
