// UI-only sync for section 10.4 legal-act collection in the replacement NCBR draft.
// Keeps the legal-act table aligned to the vetted markdown rows. Never submits or withdraws.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const SECTION_URL = `https://lsi2.ncbr.gov.pl/projekt/${projectId}/projekt_step/4e260fae-c455-41ce-bba3-d0df2a8767fd`;
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_10.4_zrownowazony_rozwoj.md';

const md = readFileSync(MD, 'utf8');

function legalRows() {
  return md.split('\n')
    .filter((line) => line.startsWith('| **') && !line.includes('|---|'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      const act = (cells[1] || '').replace(/\*\*/g, '');
      const justification = (cells[2] || '').replace(/\*\*/g, '');
      if (!act || !justification) throw new Error(`malformed legal-act row: ${line.slice(0, 120)}`);
      const formJustification = act.startsWith('Inne:') ? `${act}. ${justification}` : justification;
      if (formJustification.length > 1000) throw new Error(`legal-act justification too long: ${act} ${formJustification.length}/1000`);
      return { act, kind: act.startsWith('Inne:') ? 'inne' : 'lista', justification, justificationLength: justification.length, formJustification, formJustificationLength: formJustification.length };
    });
}

const targets = legalRows();
const target = targets[0];
const staleNeedles = [
  ['2010/75'],
  ['emisji przemys'],
];

function rowNeedles(row) {
  if (/2018\/2001/i.test(row.act)) return ['2018/2001'];
  if (/2023\/1791/i.test(row.act)) return ['2023/1791'];
  if (/2024\/1364/i.test(row.act)) return ['2024/1364'];
  if (row.kind === 'inne') return [row.act.replace(/^Inne:\s*/, '').slice(0, 40)];
  if (/odpadach/i.test(row.act)) return ['odpadach'];
  if (/Prawo ochrony środowiska/i.test(row.act)) return ['Prawo ochrony środowiska'];
  if (/Prawo wodne/i.test(row.act)) return ['Prawo wodne'];
  if (/ochronie przyrody/i.test(row.act)) return ['ustawa o ochronie przyrody', 'ochronie przyrody'];
  if (/3 października 2008|udostępnianiu informacji/i.test(row.act)) return ['ustawa OOŚ', 'udostępnianiu informacji'];
  return [row.act];
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(15000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: authenticated LSI section navigation
await humanIdlePause('long');
await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie overlay only

async function tableState() {
  return page.evaluate(() => ({
    url: location.href,
    tables: Array.from(document.querySelectorAll('table')).map((table, index) => ({
      index,
      rows: Array.from(table.querySelectorAll('tbody tr')).map((row, rowIndex) => ({
        rowIndex,
        text: row.innerText.trim().replace(/\s+/g, ' ').slice(0, 1400),
        buttons: Array.from(row.querySelectorAll('button, [role="button"]')).map((button) => ({
          text: (button.textContent || '').trim(),
          aria: button.getAttribute('aria-label') || '',
        })),
      })),
    })),
  })); // allow-raw-playwright: read 10.4 table state only
}

async function openOutdatedRow() {
  const rows = page.locator('table tbody tr');
  let targetRow = null;
  for (let index = 0; index < await rows.count(); index += 1) {
    const candidate = rows.nth(index);
    if (/2010\/75|emisji przemys|BAT|efektywno/i.test(await candidate.innerText().catch(() => ''))) {
      targetRow = candidate;
      break;
    }
  }
  if (!targetRow) {
    const rowTexts = await rows.allTextContents();
    throw new Error(JSON.stringify({ opened: false, reason: 'target row not found', rows: rowTexts.map((text) => text.trim().replace(/\s+/g, ' ').slice(0, 300)) }));
  }
  const button = targetRow.locator('button[aria-label="overflow-options"], button, [role="button"]').first();
  if (await button.count() === 0) throw new Error(JSON.stringify({ opened: false, reason: 'row menu not found', row: (await targetRow.innerText()).trim().replace(/\s+/g, ' ') }));
  const row = (await targetRow.innerText()).trim().replace(/\s+/g, ' ').slice(0, 600);
  await humanClickLocator(page, button);
  await humanIdlePause('deliberate');
  const edit = page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first();
  if (await edit.count() === 0) {
    const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 30)); // allow-raw-playwright: read visible menu labels
    throw new Error(`edit menu item not found: ${menu.join(' | ')}`);
  }
  await humanClickLocator(page, edit);
  await humanIdlePause('long');
  return { opened: true, row };
}

async function openRowByNeedle(needles) {
  const items = Array.isArray(needles) ? needles : [needles];
  const rows = page.locator('table tbody tr');
  let targetRow = null;
  for (let index = 0; index < await rows.count(); index += 1) {
    const candidate = rows.nth(index);
    const text = await candidate.innerText().catch(() => '');
    if (items.some((needle) => text.includes(needle))) {
      targetRow = candidate;
      break;
    }
  }
  if (!targetRow) {
    const rowTexts = await rows.allTextContents();
    throw new Error(JSON.stringify({ opened: false, reason: 'target row not found', needles: items, rows: rowTexts.map((text) => text.trim().replace(/\s+/g, ' ').slice(0, 300)) }));
  }
  const button = targetRow.locator('button[aria-label="overflow-options"], button, [role="button"]').first();
  if (await button.count() === 0) throw new Error(JSON.stringify({ opened: false, reason: 'row menu not found', row: (await targetRow.innerText()).trim().replace(/\s+/g, ' ') }));
  const row = (await targetRow.innerText()).trim().replace(/\s+/g, ' ').slice(0, 600);
  await humanClickLocator(page, button);
  await humanIdlePause('deliberate');
  await humanClickLocator(page, page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first());
  await humanIdlePause('long');
  return { opened: true, row };
}

async function openMenuByNeedle(needles) {
  const items = Array.isArray(needles) ? needles : [needles];
  const rows = page.locator('table tbody tr');
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const text = await row.innerText().catch(() => '');
    if (!items.some((needle) => text.includes(needle))) continue;
    const button = row.locator('button[aria-label="overflow-options"], button, [role="button"]').first();
    if (await button.count() === 0) {
      return { opened: false, reason: 'row menu not found', row: text.trim().replace(/\s+/g, ' ') };
    }
    await humanClickLocator(page, button);
    await humanIdlePause('deliberate');
    return { opened: true, row: text.trim().replace(/\s+/g, ' ').slice(0, 600) };
  }
  return { opened: false, reason: 'target row not found', needles: items };
}

async function deleteRowByNeedle(needles) {
  const opened = await openMenuByNeedle(needles);
  if (!opened.opened) return { skipped: opened };
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button'))
    .map((el) => (el.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 40)); // allow-raw-playwright: read visible menu labels
  const del = page.getByRole('menuitem', { name: /usuń|usun/i }).first();
  if (await del.count() === 0) return { opened, error: `delete menu item not found: ${labels.join(' | ')}` };
  await humanClickLocator(page, del);
  await humanIdlePause('deliberate');
  const buttons = page.getByRole('button', { name: /^(Usuń|Usun|Tak|Potwierdź|Potwierdz)$/i })
    .filter({ visible: true });
  const count = await buttons.count();
  const confirmed = count > 0
    ? { confirmed: true, label: (await buttons.nth(count - 1).innerText()).trim() }
    : { confirmed: false, labels: await page.locator('button').filter({ visible: true }).allTextContents() };
  if (count > 0) await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
  return { opened, labels, confirmed };
}

async function clickAdd() {
  const button = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
  if (await button.count() === 0) throw new Error('enabled Dodaj not found');
  await humanClickLocator(page, button);
  await humanIdlePause('long');
}

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

if (process.env.DIAG_ADD) {
  await clickAdd();
  const input = page.locator('input[name="akt_prawny"]').first();
  await input.waitFor({ state: 'visible' });
  const searches = (process.env.DIAG_SEARCHES || 'Prawo ochrony środowiska|ustawa z dnia 27 kwietnia|ustawa OOŚ|ustawa z dnia 3 października|udostępnianiu informacji')
    .split('|')
    .filter(Boolean);
  const results = [];
  for (const search of searches) {
    await humanFill(page, input, search);
    await humanIdlePause('deliberate');
    const options = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option'], [role='option']"))
      .map((o) => o.textContent.trim())
      .filter(Boolean)
      .slice(0, 30)); // allow-raw-playwright: read visible legal-act options only
    results.push({ search, options });
  }
  console.log(JSON.stringify({ diagAdd: results }, null, 2));
  process.exit(0);
}

if (process.env.ADD_OOS_ONLY) {
  const row = targets.find((candidate) => /udostępnianiu informacji|3 października 2008/i.test(candidate.act));
  if (!row) throw new Error('OOŚ row not found in markdown');
  console.log(JSON.stringify({ stage: 'start', row: { act: row.act, len: row.formJustificationLength } }));
  await clickAdd();
  console.log(JSON.stringify({ stage: 'opened' }));
  const picked = await setLegalAct(row);
  console.log(JSON.stringify({ stage: 'picked', picked }));
  const justFill = await fillTextLikeField((el) => {
    const name = el.name || '';
    return name === 'uzasadnienie' || name.endsWith('.uzasadnienie');
  }, row.formJustification);
  console.log(JSON.stringify({ stage: 'filled', justFill }));
  const formState = await page.evaluate(() => ({
    visibleFields: Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.offsetParent !== null).map((el) => ({
      name: el.name || '',
      value: (el.value || '').slice(0, 160),
      len: (el.value || '').length,
      role: el.getAttribute('role') || '',
      invalid: el.getAttribute('aria-invalid') || '',
    })),
    saves: Array.from(document.querySelectorAll('button')).filter((button) => button.innerText.trim() === 'Zapisz').map((button) => ({
      disabled: button.disabled,
      visible: !!button.getClientRects().length,
    })),
    errors: Array.from(document.querySelectorAll('[aria-invalid="true"], .Mui-error')).map((el) => (el.getAttribute('name') || el.textContent || '').trim().slice(0, 160)).filter(Boolean).slice(0, 20),
  })); // allow-raw-playwright: read add-form state before save
  console.log(JSON.stringify({ stage: 'formState', formState }));
  const save = await saveRow();
  console.log(JSON.stringify({ stage: 'save', save }));
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: return to 10.4 table
  await humanIdlePause('long');
  const readback = await tableState();
  console.log(JSON.stringify({ stage: 'readback', readback }, null, 2));
  process.exit(0);
}

if (process.env.SYNC_ALL) {
  const before = await tableState();
  const deleted = [];
  for (const needles of staleNeedles) {
    deleted.push({ needles, ...(await deleteRowByNeedle(needles)) });
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: return to 10.4 table after delete attempt
    await humanIdlePause('long');
  }
  const startAt = Number(process.env.START_AT || 0);
  const syncTargets = targets.slice(startAt);
  const results = [];
  for (const row of syncTargets) {
    const current = await tableState();
    const text = JSON.stringify(current);
    const needles = rowNeedles(row);
    const alreadyPresent = needles.some((needle) => text.includes(needle));
    if (alreadyPresent) {
      await openRowByNeedle(needles);
      results.push({ act: row.act, action: 'edit', ...(await fillLegalActForm(row)) });
    } else {
      await clickAdd();
      results.push({ act: row.act, action: 'add', ...(await fillLegalActForm(row)) });
    }
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: return to 10.4 table after row save
    await humanIdlePause('long');
  }
  const readback = await tableState();
  const allText = JSON.stringify(readback);
  console.log(JSON.stringify({
    expected: targets.map((row) => ({ act: row.act, formJustificationLength: row.formJustificationLength })),
    before,
    deleted,
    results,
    readback,
    foundCount: targets.filter((row) => rowNeedles(row).some((needle) => allText.includes(needle))).length,
    staleHits: {
      industrialDirective: /2010\/75/.test(allText),
      renewablesDirective: /2018\/2001/.test(allText),
      oos: /ustawa z dnia 3 października 2008|udostępnianiu informacji o środowisku/i.test(allText),
      bat: /\bBAT\b|najlepsz/i.test(allText),
      industrialEmissions: /emisji przemys/i.test(allText),
    },
  }, null, 2));
  process.exit(0);
}

const opened = await openOutdatedRow();
if (process.env.DIAG) {
  await diagForm(opened);
  process.exit(0);
}

const actType = await setActTypeIfPresent();
const justFill = await fillTextLikeField((el) => {
  const name = el.name || '';
  return name === 'uzasadnienie' || name.endsWith('.uzasadnienie');
}, target.formJustification);

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
try {
  const buttons = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const count = await buttons.count();
  if (!count) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
} catch (error) {
  saveResult = `NOT SAVED: ${String(error?.message || error).slice(0, 140)}`;
}

const readback = await tableState();
const allText = JSON.stringify(readback);
console.log(JSON.stringify({
  target,
  actType,
  justFill,
  saveResult,
  readback,
  staleHits: {
    industrialDirective: /2010\/75/.test(allText),
    bat: /\bBAT\b|najlepsz/i.test(allText),
    industrialEmissions: /emisji przemys/i.test(allText),
  },
}, null, 2));
process.exit(saveResult === 'saved' ? 0 : 2);
