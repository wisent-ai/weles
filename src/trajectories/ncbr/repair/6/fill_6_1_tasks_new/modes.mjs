// The explicit modes of the 6.1 filler: headings and parsing dumps, the field dumps, the
// milestone verification and the single-task repairs. Each prints its result and exits.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { md, tasks } from './source.mjs';

export async function runModes({ page, SECTION_URL, form, milestones }) {
  const { clickDodaj, fillByName, assertTaskValuesBeforeSave, radio, setApplicant, saveForm, editTaskRow } = form;
  const { fillEmptyMilestones, fillAllMilestones, addMilestone } = milestones;
if (process.env.HEADINGS) {
  console.log(JSON.stringify({
    lines: md.split(/\r?\n/).filter((l) => l.startsWith('### Zadanie')).slice(0, 20),
    regexCount: Array.from(md.matchAll(/^### Zadanie\s+(\d+)\.[^\n]*$/gm)).length,
    parsed: tasks().length,
  }, null, 2));
  process.exit(0);
}

if (process.env.PARSE) {
  console.log(JSON.stringify(tasks().map((t) => ({
    nr: t.nr,
    nazwa: t.nazwa,
    zakresLen: t.zakres.length,
    szczegolowyLen: t.szczegolowy.length,
    milestones: t.milestones.length,
  })), null, 2));
  process.exit(0);
}

if (process.env.DIAG) {
  await clickDodaj();
  if (process.env.MILESTONE) {
    await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Dodaj kolejny$/ }).first()) // allow-raw-playwright: open milestone nested row
    await humanIdlePause('long');
  }
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((i) => {
    const label = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null;
    const wrap = i.closest('label, .MuiFormControlLabel-root, .MuiFormGroup-root, .MuiBox-root');
    return { tag: i.tagName, type: i.type || null, name: i.name || null, value: i.value || null, role: i.getAttribute('role'), max: i.getAttribute('maxlength'), label, nearby: wrap ? wrap.textContent.trim().slice(0, 160) : null };
  }).filter((x) => x.name || x.label));
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean));
  console.log(JSON.stringify({ parsedTasks: tasks().length, firstTask: tasks()[0], fields, buttons }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_EDIT) {
  await editTaskRow(process.env.DIAG_EDIT);
  if (process.env.APP_HTML) {
    const inp = page.locator(`input[name="nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta"]`).first();
    const select = inp.locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
    if (await select.count() > 0) await humanClickLocator(page, select);
    const app = { inputValue: await inp.inputValue().catch(() => ''), formControl: null }; // allow-raw-playwright: open applicant select for diagnosis
    await humanIdlePause('deliberate');
    const options = await page.evaluate(() => Array.from(document.querySelectorAll("[role='option'], li")).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 30));
    console.log(JSON.stringify({ task: process.env.DIAG_EDIT, app, options }, null, 2));
    process.exit(0);
  }
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
    tag: i.tagName,
    name: i.name || null,
    valueLength: (i.value || '').length,
    value: (i.value || '').slice(0, 80),
    max: i.getAttribute('maxlength'),
    readOnly: i.readOnly,
  })).filter((x) => x.name));
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim() || b.getAttribute('aria-label') || b.title).filter(Boolean));
  console.log(JSON.stringify({ task: process.env.DIAG_EDIT, fields, buttons }, null, 2));
  process.exit(0);
}

if (process.env.VERIFY_MILESTONES) {
  const wantedVerify = process.env.TASKS ? process.env.TASKS.split(',').map((x) => x.trim()).filter(Boolean) : ['1', '2', '3', '4', '5'];
  const weak = /raport|preprint|paper|publikac|dokumentacja techniczna|testy jednostkowe|kompletność raportu|raport energii/i;
  const verified = [];
  for (const nr of wantedVerify) {
    await editTaskRow(nr);
    const milestonesRead = await page.evaluate(() => {
      const indexes = [...new Set(Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]')).map((e) => Number((e.name.match(/kamienie_milowe_kolekcja\[(\d+)\]/) || [])[1])).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
      return indexes.map((idx) => {
        const val = (field) => document.querySelector(`textarea[name="kamienie_milowe_kolekcja[${idx}].${field}"]`)?.value || '';
        return {
          idx,
          nazwa: val('kamienie_milowe_nazwa'),
          weryfikacja: val('kamienie_milowe_opis_weryfikacji'),
        };
      });
    }); // allow-raw-playwright: read milestone fields for verification only
    verified.push({
      nr,
      milestones: milestonesRead.map((m) => ({
        idx: m.idx,
        nazwa: m.nazwa.slice(0, 180),
        weryfikacjaLen: m.weryfikacja.length,
        weakHit: weak.test(`${m.nazwa}\n${m.weryfikacja}`),
        weryfikacjaStart: m.weryfikacja.slice(0, 220),
      })),
    });
    const cancel = page.locator('button').filter({ hasText: /^Anuluj$/ }).first();
    if (await cancel.count() > 0) await humanClickLocator(page, cancel) // allow-raw-playwright: close task row without saving
    await humanIdlePause('long');
  }
  console.log(JSON.stringify({ verified }, null, 2));
  process.exit(0);
}

if (process.env.FIX_TASK0_MILESTONE) {
  const t = tasks().find((x) => x.nr === '0') || {
    nr: '0',
    milestones: [],
    zakres: 'Koszty pośrednie projektu rozliczane ryczałtowo jako koszt obsługi administracyjnej, finansowej i organizacyjnej niezbędnej do prawidłowej realizacji projektu.',
    szczegolowy: 'Zadanie obejmuje rozliczenie kosztów pośrednich projektu zgodnie z harmonogramem rzeczowo-finansowym i zasadami kwalifikowalności wydatków. Zakres nie stanowi prac B+R, lecz porządkuje administracyjne potwierdzenie kompletności kosztów pośrednich.',
  };
  await editTaskRow('0');
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound */ }
  await fillByName('zakres_planowanych_prac_br', t.zakres || 'Nie dotyczy');
  await fillByName('szczegolowy_opis_prac', t.szczegolowy || 'Nie dotyczy');
  const existing = await page.evaluate(() => document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]').length);
  const filled = existing > 0 ? await fillEmptyMilestones(t) : [await addMilestone(t, 0)];
  await saveForm();
  console.log(JSON.stringify({ fixed: '0', milestoneFilled: filled }, null, 2));
  process.exit(0);
}

if (process.env.ADD_TASK0) {
  const t = tasks().find((x) => x.nr === '0') || {
    nr: '0',
    nazwa: 'Koszty pośrednie',
    start: '01.09.2026',
    end: '31.08.2029',
    rodzaj: 'Koszty pośrednie',
    zakres: 'Nie dotyczy',
    szczegolowy: 'Nie dotyczy',
    milestones: [],
  };
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await clickDodaj();
  await page.waitForSelector('[name="numer_zadania"]');
  await fillByName('numer_zadania', '0');
  await fillByName('nazwa_zadania', 'Koszty pośrednie');
  await radio('Tak');
  await fillByName('startDate', t.start || '01.09.2026');
  await fillByName('endDate', t.end || '31.08.2029');
  await radio('koszty_posrednie');
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound */ }
  await fillByName('zakres_planowanych_prac_br', t.zakres || 'Nie dotyczy');
  await fillByName('szczegolowy_opis_prac', t.szczegolowy || 'Nie dotyczy');
  if (!process.env.NO_TASK0_MILESTONE) await addMilestone(t, 0);
  await saveForm();
  const rows = await page.evaluate(() => document.querySelector('table')?.querySelectorAll('tbody tr').length || 0);
  console.log(JSON.stringify({ added: '0', rows }, null, 2));
  process.exit(0);
}

if (process.env.FIX_EXISTING) {
  const wantedFix = process.env.TASKS ? new Set(process.env.TASKS.split(',').map((x) => x.trim()).filter(Boolean)) : new Set(['1', '2', '3', '4', '5', '0']);
  const byNr = new Map(tasks().map((t) => [t.nr, t]));
  const fixed = [];
  for (const nr of wantedFix) {
    const t = byNr.get(nr);
    if (!t) throw new Error(`parsed task missing: ${nr}`);
    await editTaskRow(nr);
    try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound */ }
    await fillByName('zakres_planowanych_prac_br', t.zakres || 'Nie dotyczy');
    await fillByName('szczegolowy_opis_prac', t.szczegolowy || 'Nie dotyczy');
    const milestoneFilled = process.env.OVERWRITE_MILESTONES ? await fillAllMilestones(t) : await fillEmptyMilestones(t);
    await assertTaskValuesBeforeSave(nr);
    await saveForm();
    fixed.push({ nr, zakres: t.zakres.length, szczegolowy: t.szczegolowy.length, milestoneFilled });
  }
  const rows = await page.evaluate(() => {
    const table = document.querySelector('table');
    return table ? table.querySelectorAll('tbody tr').length : 0;
  });
  console.log(JSON.stringify({ fixed, rows }, null, 2));
  process.exit(0);
}

if (process.env.FIX_APPLICANT) {
  const wantedFix = process.env.TASKS ? process.env.TASKS.split(',').map((x) => x.trim()).filter(Boolean) : ['1', '2', '3', '4', '5', '0'];
  const byNr = new Map(tasks().map((t) => [t.nr, t]));
  const fixed = [];
  for (const nr of wantedFix) {
    const t = byNr.get(nr);
    await editTaskRow(nr);
    await setApplicant();
    if (nr === '0') {
      await fillByName('zakres_planowanych_prac_br', t?.zakres || 'Nie dotyczy');
      await fillByName('szczegolowy_opis_prac', t?.szczegolowy || 'Nie dotyczy');
    }
    await saveForm();
    fixed.push(nr);
  }
  console.log(JSON.stringify({ fixed }, null, 2));
  process.exit(0);
}
}
