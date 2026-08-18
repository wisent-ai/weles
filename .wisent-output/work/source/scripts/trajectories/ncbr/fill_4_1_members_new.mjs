// Section 4.1 team-member collection filler for the NEW NCBR wniosek.
// DIAG=1 opens one row and dumps field names. Never closes page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/5af236aa-03b2-4650-b5a2-95c299dfeeaf';
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_4_1_zespol.md';
const md = readFileSync(MD, 'utf8');

function extract(block, label) {
  const lines = block.split(/\r?\n/);
  const norm = (s) => s.trim().replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/:$/, '').trim();
  const start = lines.findIndex((line) => norm(line) === label);
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\*\*.+\*\*$/.test(t) || /^#{2,4}\s/.test(t) || t === '---') break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function members() {
  return md.split(/^## Zespół projektowy — członek \d+\s*$/m).slice(1).map((b) => ({
    imie: extract(b, 'Imię'),
    nazwisko: extract(b, 'Nazwisko'),
    wyksztalcenie: extract(b, 'Wykształcenie'),
    tytul: extract(b, 'Tytuł naukowy/stopień naukowy (jeśli dotyczy)'),
    rola: extract(b, 'Rola w projekcie'),
    doswiadczenie: extract(b, 'Doświadczenie naukowe i zawodowe oraz doświadczenie we wdrażaniu wyników prac B+R'),
    stanowisko: extract(b, 'Stanowisko i zakres obowiązków w projekcie'),
    wymiar: extract(b, 'Wymiar zaangażowania w projekcie'),
    status: extract(b, 'Status współpracy'),
    podmiot: extract(b, 'Nazwa skrócona podmiotu'),
    projects: b.split(/^### Informacje o zrealizowanych projektach.*$/m).slice(1).map((p) => ({
      tytul: extract(p, 'Tytuł projektu'),
      budzet: extract(p, 'Budżet (PLN)'),
      numer: extract(p, 'Numer projektu'),
      od: extract(p, 'Okres realizacji od'),
      do: extract(p, 'Okres realizacji do'),
      konsorcjum: extract(p, 'Projekt realizowany w ramach konsorcjum') || 'Nie',
      rola: extract(p, 'Rola w zrealizowanym projekcie'),
      efekty: extract(p, 'Główne efekty zrealizowanego projektu'),
    })).filter((p) => p.tytul),
  })).filter((m) => m.imie && m.nazwisko);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(8000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

if (process.env.PARSE) {
  console.log(JSON.stringify(members().map((m) => ({
    person: `${m.imie} ${m.nazwisko}`,
    expLen: m.doswiadczenie.length,
    stanowiskoLen: m.stanowisko.length,
  })), null, 2));
  process.exit(0);
}

async function clickDodaj() {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Dodaj');
    if (!btn) throw new Error('Dodaj not found');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open team member sub-form
  await humanIdlePause('long');
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

async function fillByName(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || value.length;
  let v = value || '';
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.fill(v); // allow-raw-playwright: LSI form text field
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function setAuto(name, search) {
  const inp = page.locator(`input[name="${name}"]`).first();
  await inp.click(); // allow-raw-playwright: open MUI autocomplete
  await inp.fill(search); // allow-raw-playwright: filter
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option']").first();
  if (await opt.count() === 0) throw new Error(`no option for ${name} -> ${search}`);
  const picked = (await opt.textContent())?.trim();
  await opt.dispatchEvent('click'); // allow-raw-playwright: pick filtered option
  await humanIdlePause('short');
  return picked;
}

async function setApplicant() {
  await page.evaluate(() => {
    const inp = document.querySelector("input[name='nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta']");
    const root = inp && inp.closest('.MuiInputBase-root');
    const select = root && root.querySelector('.MuiSelect-select, [role="combobox"]');
    if (!select) throw new Error('applicant select not found');
    for (const t of ['mousedown', 'mouseup', 'click']) select.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open applicant MUI select
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
  await humanIdlePause('short');
}

async function setStatus() {
  const value = 'pracownik_wnioskodawcy_samodzielnego_lidera_konsorcjum';
  await page.locator(`input[type="radio"][value="${value}"]`).first().dispatchEvent('click'); // allow-raw-playwright: status radio
  await humanIdlePause('short');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save sub-form
  await humanIdlePause('long');
}

async function fillProjectSubrow(project, addIdx = 0) {
  await page.evaluate((idx) => {
    const adds = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj kolejny' && !b.disabled);
    if (!adds[idx]) throw new Error(`Dodaj kolejny ${idx} not found`);
    adds[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, addIdx); // allow-raw-playwright: open nested realized-project row
  await humanIdlePause('long');

  const fillNested = async (suffix, value) => {
    const loc = page.locator(`[name$="${suffix}"]`).first();
    await loc.waitFor({ state: 'visible' });
    const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
    let v = String(value || '');
    if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
    await loc.fill(v); // allow-raw-playwright: nested realized-project text field
    await humanIdlePause('short');
  };

  await fillNested('zrealizowane_projekty_tytul', project.tytul);
  await fillNested('zrealizowane_projekty_budzet', project.budzet);
  await fillNested('zrealizowane_projekty_numer_projektu', project.numer);
  await fillNested('zrealizowane_projekty_okres_realizacji_od', project.od);
  await fillNested('zrealizowane_projekty_okres_realizacji_do', project.do);
  const consortiumValue = project.konsorcjum === 'Tak' ? 'Tak' : 'Nie';
  await page.locator(`input[type="radio"][value="${consortiumValue}"]`).first().dispatchEvent('click'); // allow-raw-playwright: project consortium radio
  await humanIdlePause('short');
  await fillNested('zrealizowane_projekty_rola_w_zrealizowanym_projekcie', project.rola);
  await fillNested('zrealizowane_projekty_glowne_efekty', project.efekty);
  await saveForm();
}

async function editMemberRow(index) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').nth(index + 1);
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open member row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit member row
  await humanIdlePause('long');
  await page.waitForSelector('[name="imie"]');
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
  await page.evaluate((idx) => {
    const adds = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj kolejny' && !b.disabled);
    if (!adds[idx]) throw new Error(`Dodaj kolejny ${idx} not found`);
    adds[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, addIdx); // allow-raw-playwright: open nested collection row for diagnostics
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
  await loc.fill(v); // allow-raw-playwright: diagnostic fill existing member experience
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

const existingState = await page.evaluate(() => {
  const table = document.querySelector('table');
  return {
    rows: table ? table.querySelectorAll('tbody tr').length : 0,
    text: document.body.innerText || '',
  };
});
const onlyNames = process.env.ONLY_NAMES
  ? process.env.ONLY_NAMES.split(',').map((x) => x.trim()).filter(Boolean)
  : null;
const ms = members().filter((m) => {
  const full = `${m.imie} ${m.nazwisko}`;
  if (onlyNames) return onlyNames.includes(full);
  return !existingState.text.includes(full);
});
if (ms.length === 0) {
  console.log(JSON.stringify({ skipped: true, reason: `all parsed members visible; rows ${existingState.rows}` }, null, 2));
  process.exit(0);
}

const added = [];
for (const m of ms) {
  console.log(`START ${m.imie} ${m.nazwisko}`);
  await clickDodaj();
  await page.waitForSelector('[name="imie"]');
  const filled = [];
  filled.push(await fillByName('imie', m.imie));
  filled.push(await fillByName('nazwisko', m.nazwisko));
  await setAuto('wyksztalcenie', m.wyksztalcenie);
  filled.push(await fillByName('tytul_naukowy', m.tytul));
  await setAuto('rola_w_projekcie', m.rola);
  filled.push(await fillByName('doswiadczenie_naukowe_i_zawodowe', m.doswiadczenie));
  filled.push(await fillByName('stanowisko_i_zakres_obowiazkow_w_projekcie', m.stanowisko));
  filled.push(await fillByName('wymiar_zaangazowania_w_projekcie', m.wymiar));
  await setStatus();
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound after status */ }
  if (m.rola.toLowerCase().includes('kierownik') && m.projects.length) {
    await fillProjectSubrow(m.projects[0], 0);
  }
  try {
    await saveForm();
    added.push(`${m.imie} ${m.nazwisko}`);
    console.log(`SAVED ${m.imie} ${m.nazwisko}`);
  } catch (e) {
    console.log(`NOT SAVED ${m.imie} ${m.nazwisko}: ${String(e?.message || e).slice(0, 180)}`);
    break;
  }
}

const rows = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
console.log(JSON.stringify({ added, rows }, null, 2));
process.exit(0);
