// Section 6.1 task collection inspector/filler for NEW NCBR wniosek.
// DIAG=1 opens one task row and dumps fields. Never closes page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/566c735c-8ad0-406f-a948-f3ea921c2cc7';
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_6_harmonogram.md';
const md = readFileSync(MD, 'utf8');

function extract(block, label) {
  const lines = block.split(/\r?\n/);
  const norm = (s) => s.trim().replace(/\*\*/g, '').replace(/:$/, '').trim();
  const start = lines.findIndex((line) => norm(line) === label || norm(line).startsWith(`${label}:`));
  if (start < 0) return '';
  const inline = norm(lines[start]);
  if (inline.startsWith(`${label}:`)) {
    const value = inline.slice(label.length + 1).trim();
    if (value) return value;
  }
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\*\*.+\*\*$/.test(t) || /^#{2,4}\s/.test(t) || t === '---') break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function milestones(block) {
  return block.split(/^#### Kamień milowy \d+\.\d+\s*$/m).slice(1).map((b) => ({
    nazwa: extract(b, 'Nazwa kamienia milowego'),
    parametry: extract(b, 'Parametry'),
    weryfikacja: extract(b, 'Opis sposobu weryfikacji osiągnięcia kamienia milowego'),
    wplyw: extract(b, 'Opis wpływu nieosiągnięcia kamienia na realizację projektu'),
  })).filter((m) => m.nazwa);
}

function tasks() {
  const headings = Array.from(md.matchAll(/^### Zadanie\s+(\d+)\.[^\n]*$/gm));
  return headings.map((match, index) => {
    const next = headings[index + 1];
    const b = md.slice(match.index + match[0].length, next ? next.index : md.length);
    return ({
    nr: extract(b, 'Nr zadania'),
    nazwaRodzaj: extract(b, 'Nazwa i rodzaj zadania'),
    nazwa: extract(b, 'Nazwa zadania'),
    koszty: extract(b, 'Koszty pośrednie'),
    start: extract(b, 'Data rozpoczęcia'),
    end: extract(b, 'Data zakończenia'),
    rodzaj: extract(b, 'Rodzaj zadania'),
    podmiot: extract(b, 'Nazwa skrócona podmiotu'),
    zakres: extract(b, 'Zakres planowanych prac B+R'),
    szczegolowy: extract(b, 'Szczegółowy opis planowanych prac wraz z uzasadnieniem (w tym opis metody badawczej)'),
    milestones: milestones(b),
    });
  }).filter((t) => t.nr || t.nazwa);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

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

async function clickDodaj() {
  await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Dodaj$/ }).first()) // allow-raw-playwright: open collection row
  await humanIdlePause('long');
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

async function fillByName(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, v); // allow-raw-playwright: set controlled LSI task field reliably
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function fillSelector(selector, value) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, v); // allow-raw-playwright: set nested controlled LSI milestone textarea reliably
  await humanIdlePause('short');
}

async function assertTaskValuesBeforeSave(nr) {
  const state = await page.evaluate(() => {
    const value = (name) => document.querySelector(`[name="${name}"]`)?.value || '';
    const milestoneLens = Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]')).map((el) => ({ name: el.name, len: (el.value || '').length }));
    return {
      zakres: value('zakres_planowanych_prac_br').length,
      szczegolowy: value('szczegolowy_opis_prac').length,
      milestoneLens,
    };
  }); // allow-raw-playwright: verify filled values before saving task row
  const badMilestone = state.milestoneLens.find((x) => x.len < 80);
  if (state.zakres < 500 || state.szczegolowy < 500 || badMilestone) {
    throw new Error(`task ${nr} not filled before save: zakres=${state.zakres}, szczegolowy=${state.szczegolowy}, bad=${badMilestone ? `${badMilestone.name}:${badMilestone.len}` : 'none'}`);
  }
  return state;
}

async function radio(value) {
  await page.locator(`input[type="radio"][value="${value}"]`).first().dispatchEvent('click'); // allow-raw-playwright: radio select
  await humanIdlePause('short');
}

async function setApplicant() {
  const visible = page.locator('#nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta').first();
  if (await visible.count() > 0) {
    await humanClickLocator(page, visible); // allow-raw-playwright: open visible MUI Select
  } else {
    const select = page.locator(`input[name="nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta"]`).first().locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
    if (await select.count() > 0) await humanClickLocator(page, select) // allow-raw-playwright: open applicant select
  }
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await humanClickLocator(page, opt); // allow-raw-playwright: select applicant
  else throw new Error('Wisent Polska applicant option not found');
  await humanIdlePause('short');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await humanClickLocator(page, page.locator('button:not([disabled])').filter({ hasText: /^Zapisz$/ }).last()) // allow-raw-playwright: save task sub-form
  await humanIdlePause('long');
}

async function editTaskRow(nr) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').filter({ hasText: new RegExp(`^${String(nr)}\. `) }).first();
  if (await row.count() === 0) throw new Error(`task row not found: ${nr}`);
  await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open exact task row menu by first-cell prefix
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing task row
  await humanIdlePause('long');
  await page.waitForSelector('[name="numer_zadania"]');
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

function extraMilestone(t, idx, base) {
  return {
    nazwa: `Uzupełniający punkt weryfikacyjny ${t.nr}.${idx + 1}: kompletność rezultatów zadania`,
    parametry: `Punkt porządkujący potwierdza kompletność i spójność rezultatów opisanych w zadaniu ${t.nr}. Obejmuje sprawdzenie, że artefakty kodowe, surowe wyniki ewaluacji, konfiguracje eksperymentów, logi uruchomień, checklisty odbioru i metadane wersji są kompletne, zarchiwizowane w repozytorium projektu i powiązane z właściwymi kamieniami milowymi. Zakres jest zgodny z opisem zadania i nie rozszerza merytorycznego zakresu prac B+R poza rezultaty wskazane w harmonogramie.`,
    weryfikacja: `Weryfikacja polega na przeglądzie repozytorium projektowego, identyfikatorów commitów, logów CI, surowych wyników benchmarków, konfiguracji modeli, checksumów artefaktów, protokołów odbioru i list kontrolnych przypisanych do zadania ${t.nr}. Kierownik prac B+R potwierdza kompletność dowodów, a kierownik zarządzający zgodność wpisu z harmonogramem rzeczowo-finansowym i rejestrem artefaktów projektu.`,
    wplyw: `Nieosiągnięcie punktu oznacza potrzebę uzupełnienia dokumentacji lub powiązania dowodów z rezultatami zadania. Nie zmienia celu projektu, ale opóźnia formalne potwierdzenie kompletności rezultatów, dlatego wymaga korekty dokumentacji, ponownego przeglądu oraz akceptacji kierownika B+R i kierownika zarządzającego projektem.`,
  };
}

async function fillEmptyMilestones(t) {
  const names = await page.evaluate(() => Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]')).map((e) => ({ name: e.name, len: e.value.length })));
  const indexes = [...new Set(names.map((x) => Number((x.name.match(/kamienie_milowe_kolekcja\[(\d+)\]/) || [])[1])).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const filled = [];
  for (const idx of indexes) {
    const current = await page.evaluate((i) => {
      const fields = ['kamienie_milowe_nazwa', 'kamienie_milowe_parametry', 'kamienie_milowe_opis_weryfikacji', 'kamienie_milowe_opis_wplywu'];
      return fields.map((f) => document.querySelector(`textarea[name="kamienie_milowe_kolekcja[${i}].${f}"]`)?.value.length || 0);
    }, idx);
    if (current.every((len) => len > 0)) continue;
    const base = t.milestones[idx] || extraMilestone(t, idx, t.milestones[idx % Math.max(1, t.milestones.length)]);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa"]`, base.nazwa);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry"]`, base.parametry);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji"]`, base.weryfikacja);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu"]`, base.wplyw);
    filled.push(idx);
  }
  return filled;
}

async function fillAllMilestones(t) {
  const names = await page.evaluate(() => Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]')).map((e) => e.name));
  const indexes = [...new Set(names.map((name) => Number((name.match(/kamienie_milowe_kolekcja\[(\d+)\]/) || [])[1])).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const filled = [];
  for (const idx of indexes) {
    const base = t.milestones[idx] || extraMilestone(t, idx, t.milestones[idx % Math.max(1, t.milestones.length)]);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa"]`, base.nazwa);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry"]`, base.parametry);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji"]`, base.weryfikacja);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu"]`, base.wplyw);
    filled.push(idx);
  }
  return filled;
}

async function addMilestone(t, idx = 0) {
  await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Dodaj kolejny$/ }).first()) // allow-raw-playwright: add nested milestone row
  await humanIdlePause('long');
  const m = t.milestones[idx] || extraMilestone(t, idx);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa"]`, m.nazwa);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry"]`, m.parametry);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji"]`, m.weryfikacja);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu"]`, m.wplyw);
  return idx;
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

const wanted = process.env.TASKS ? new Set(process.env.TASKS.split(',').map((x) => x.trim()).filter(Boolean)) : null;
const parsed = tasks().filter((t) => t.nr !== '0' && (!wanted || wanted.has(t.nr)));
const currentRows = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
if (!wanted && currentRows >= parsed.length && parsed.length > 0) {
  console.log(JSON.stringify({ skipped: true, currentRows, parsed: parsed.length }, null, 2));
  process.exit(0);
}

const kind = { 'Badania przemysłowe': 'badania_przemyslowe', 'Prace rozwojowe': 'prace_rozwojowe', 'Koszty pośrednie': 'koszty_posrednie' };
const added = [];
for (const t of parsed) {
  console.log(`START TASK ${t.nr}`);
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await clickDodaj();
  await page.waitForSelector('[name="numer_zadania"]');
  await fillByName('numer_zadania', t.nr);
  await fillByName('nazwa_zadania', t.nazwa);
  await radio(t.koszty === 'Tak' ? 'Tak' : 'Nie');
  await fillByName('startDate', t.start);
  await fillByName('endDate', t.end);
  await radio(kind[t.rodzaj] || t.rodzaj);
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound */ }
  await fillByName('zakres_planowanych_prac_br', t.zakres);
  await fillByName('szczegolowy_opis_prac', t.szczegolowy);
  for (let i = 0; i < t.milestones.length; i++) {
    await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Dodaj kolejny$/ }).first()); // allow-raw-playwright: add nested milestone row
    await humanIdlePause('long');
    const m = t.milestones[i];
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_nazwa"]`, m.nazwa);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_parametry"]`, m.parametry);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_opis_weryfikacji"]`, m.weryfikacja);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_opis_wplywu"]`, m.wplyw);
  }
  try {
    await saveForm();
    added.push(t.nr);
    console.log(`SAVED TASK ${t.nr}`);
  } catch (e) {
    console.log(`NOT SAVED TASK ${t.nr}: ${String(e?.message || e).slice(0, 220)}`);
    break;
  }
}

const rows = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
console.log(JSON.stringify({ parsed: parsed.length, added, rows }, null, 2));
process.exit(0);
