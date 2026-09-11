// The explicit modes of the 4.1 filler: parsing only, the field dumps, the single-row
// repairs and the experience rewrite. Each prints its result and exits.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { members } from './source.mjs';

export async function runModes({ page, form }) {
  const { clickDodaj, fillByName, saveForm, fillProjectSubrow, editMemberRow } = form;
if (process.env.PARSE) {
  console.log(JSON.stringify(members().map((m) => ({
    person: `${m.imie} ${m.nazwisko}`,
    expLen: m.doswiadczenie.length,
    stanowiskoLen: m.stanowisko.length,
  })), null, 2));
  process.exit(0);
}

if (process.env.DIAG) {
  await clickDodaj();
  const info = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((i) => {
    const label = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null;
    const wrap = i.closest('label, .MuiFormControlLabel-root, .MuiFormGroup-root, .MuiBox-root');
    return { tag: i.tagName, type: i.type || null, name: i.name || null, value: i.value || null, role: i.getAttribute('role'), max: i.getAttribute('maxlength'), label, nearby: wrap ? wrap.textContent.trim().slice(0, 140) : null };
  }).filter((x) => x.name || x.label));
  console.log(JSON.stringify({ parsedMembers: members().length, fields: info }, null, 2));
  process.exit(0);
}

if (process.env.REPAIR_PROJECT_ROW !== undefined) {
  const idx = Number(process.env.REPAIR_PROJECT_ROW);
  await editMemberRow(idx);
  const current = await page.evaluate(() => ({
    imie: document.querySelector('[name="imie"]')?.value || '',
    nazwisko: document.querySelector('[name="nazwisko"]')?.value || '',
  }));
  const m = members().find((x) => x.imie === current.imie && x.nazwisko === current.nazwisko) || members()[idx];
  if (!m?.projects?.length) throw new Error(`no project source for row ${idx}`);
  await fillProjectSubrow(m.projects[0], 0);
  await saveForm();
  console.log(JSON.stringify({ repairedProjectRow: idx, person: `${m.imie} ${m.nazwisko}`, project: m.projects[0].tytul.slice(0, 80) }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_EDIT !== undefined) {
  const idx = Number(process.env.DIAG_EDIT);
  await editMemberRow(idx);
  const dump = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
      tag: i.tagName,
      name: i.name || null,
      valueLength: (i.value || '').length,
      value: (i.value || '').slice(0, 120),
      max: i.getAttribute('maxlength'),
      readOnly: i.readOnly,
    })).filter((x) => x.name),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
  }));
  console.log(JSON.stringify({ row: idx, dump }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_BUTTONS !== undefined) {
  const idx = Number(process.env.DIAG_BUTTONS);
  await editMemberRow(idx);
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b, i) => ({
    i,
    text: b.innerText.trim(),
    disabled: b.disabled,
    context: (b.closest('div')?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  })).filter((b) => b.text));
  console.log(JSON.stringify({ row: idx, buttons }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_SUB !== undefined) {
  const [rowIdxRaw, addIdxRaw] = String(process.env.DIAG_SUB).split(',');
  const rowIdx = Number(rowIdxRaw);
  const addIdx = Number(addIdxRaw || 0);
  await editMemberRow(rowIdx);
  const adds = page.getByRole('button', { name: 'Dodaj kolejny', exact: true }).filter({ visible: true });
  if (await adds.count() <= addIdx) throw new Error(`Dodaj kolejny ${addIdx} not found`);
  await humanClickLocator(page, adds.nth(addIdx));
  await humanIdlePause('long');
  const dump = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
      tag: i.tagName,
      type: i.type || null,
      name: i.name || null,
      value: (i.value || '').slice(0, 120),
      max: i.getAttribute('maxlength'),
      label: i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null,
    })).filter((x) => x.name || x.label),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
  }));
  console.log(JSON.stringify({ row: rowIdx, addIdx, dump }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_FILL !== undefined) {
  const idx = Number(process.env.DIAG_FILL);
  await editMemberRow(idx);
  const current = await page.evaluate(() => ({
    imie: document.querySelector('[name="imie"]')?.value || '',
    nazwisko: document.querySelector('[name="nazwisko"]')?.value || '',
  }));
  const m = members().find((x) => x.imie === current.imie && x.nazwisko === current.nazwisko) || members()[idx];
  const loc = page.locator('[name="doswiadczenie_naukowe_i_zawodowe"]').first();
  let v = m.doswiadczenie;
  const max = Number(await loc.getAttribute('maxlength')) || v.length;
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await humanFill(page, loc, v);
  await loc.dispatchEvent('input'); // allow-raw-playwright: force React dirty/input state after fill
  await loc.dispatchEvent('change'); // allow-raw-playwright: force React dirty/change state after fill
  await humanIdlePause('deliberate');
  const state = await page.evaluate(() => ({
    current: {
      imie: document.querySelector('[name="imie"]')?.value || '',
      nazwisko: document.querySelector('[name="nazwisko"]')?.value || '',
      expLen: document.querySelector('[name="doswiadczenie_naukowe_i_zawodowe"]')?.value.length || 0,
    },
    saves: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => ({ disabled: b.disabled })),
  }));
  console.log(JSON.stringify({ row: idx, matched: `${m.imie} ${m.nazwisko}`, state }, null, 2));
  process.exit(0);
}

if (process.env.REPAIR_EXP) {
  const repaired = [];
  const target = process.env.ROWS ? process.env.ROWS.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n)) : [0, 1, 2];
  const msAll = members();
  for (const idx of target) {
    await editMemberRow(idx);
    const current = await page.evaluate(() => ({
      imie: document.querySelector('[name="imie"]')?.value || '',
      nazwisko: document.querySelector('[name="nazwisko"]')?.value || '',
    }));
    const m = msAll.find((x) => x.imie === current.imie && x.nazwisko === current.nazwisko) || msAll[idx];
    if (!m) continue;
    const filled = [];
    filled.push(await fillByName('doswiadczenie_naukowe_i_zawodowe', m.doswiadczenie));
    await page.locator('[name="doswiadczenie_naukowe_i_zawodowe"]').first().dispatchEvent('input'); // allow-raw-playwright: force React dirty/input state
    await page.locator('[name="doswiadczenie_naukowe_i_zawodowe"]').first().dispatchEvent('change'); // allow-raw-playwright: force React dirty/change state
    await humanIdlePause('deliberate');
    await humanIdlePause('deliberate');
    await saveForm();
    repaired.push({ row: idx, person: `${m.imie} ${m.nazwisko}`, filled });
  }
  const readback = await page.evaluate(() => {
    const table = document.querySelector('table');
    return {
      rows: table ? table.querySelectorAll('tbody tr').length : 0,
      text: (table?.innerText || '').replace(/\s+/g, ' ').slice(0, 1000),
    };
  });
  console.log(JSON.stringify({ repaired, readback }, null, 2));
  process.exit(0);
}
}
