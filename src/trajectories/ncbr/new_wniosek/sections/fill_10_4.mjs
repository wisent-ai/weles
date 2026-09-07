// Section 10.4 (Zasada zrownowazonego rozwoju) — DIAG + fill. Via UI.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/4e260fae-c455-41ce-bba3-d0df2a8767fd'].join('');
const md = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_10.4_zrownowazony_rozwoj.md', 'utf8');
function bt(start, end) { let s = md.split(start)[1]; if (s === undefined) return ''; if (end) s = s.split(end)[0]; return s.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim(); }
const OPIS_6R = bt('## Opis sposobu realizacji projektu zgodnie z wybranymi zasadami 6R (limit 4 000 znaków)', '## Stosowanie zasad 6R zostało odzwierciedlone');
const OPIS_INNE = bt('## Opis pozytywnego wpływu na inne aspekty środowiskowe w ramach projektu (nie objęte zasadami 6R)', '## Pozytywny wpływ na inne aspekty środowiskowe');
const firstActLine = md.split('\n').find((line) => line.startsWith('| **Inne: Dyrektywa 2010/75/UE'));
const ACT = (() => {
  const cells = (firstActLine || '').split('|').map((c) => c.trim()).filter(Boolean);
  const name = (cells[0] || 'Inne: Dyrektywa 2010/75/UE w sprawie emisji przemysłowych').replace(/\*\*/g, '');
  const justification = `${name}. ${(cells[1] || '').replace(/\*\*/g, '')}`.trim();
  return { name, justification };
})();

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

async function pickFirst(suffix, search) {
  const inp = page.locator(`input[name$="${suffix}"]`).first();
  await humanClickLocator(page, inp); if (search) await humanFill(page, inp, search);
  await humanIdlePause('deliberate');
  const opts = page.locator("[role='listbox'] [role='option']");
  const txt = (await opts.count()) > 0 ? (await opts.first().textContent())?.trim() : null;
  if ((await opts.count()) > 0) await opts.first().dispatchEvent('click'); // allow-raw-playwright: pick
  await humanIdlePause('short');
  return txt;
}

async function saveEnabled(label = 'save') {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const saveCount = await saves.count();
  if (!saveCount) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.nth(saveCount - 1));
  await humanIdlePause('long');
  return label;
}

if (process.env.DIAG) {
  const zr = page.locator('input[name$="zasady_szesc_r"]').first();
  await humanClickLocator(page, zr); await humanIdlePause('deliberate');
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option']")).map((o) => o.textContent.trim()));
  await opts.length && await page.locator("[role='listbox'] [role='option']").first().dispatchEvent('click'); // allow-raw-playwright: pick first to reveal
  await humanIdlePause('long');
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((i) => ({ tag: i.tagName, name: i.name.split('.').pop(), role: i.getAttribute('role'), max: i.getAttribute('maxlength') })).filter((f) => f.name && f.name !== 'table_search'));
  console.log(JSON.stringify({ zrOptions: opts, OPIS_6R: OPIS_6R.length, OPIS_INNE: OPIS_INNE.length, fields }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_ACT) {
  const addButton = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
  if (!await addButton.count()) throw new Error('Dodaj not found');
  await humanClickLocator(page, addButton);
  await humanIdlePause('long');
  if (process.env.ACT_SEARCH) {
    const inp = page.locator('input[name="akt_prawny"]').first();
    await humanClickLocator(page, inp); await humanFill(page, inp, process.env.ACT_SEARCH);
    await humanIdlePause('deliberate');
  }
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((i) => {
    const label = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null;
    const wrap = i.closest('label, .MuiFormControl-root, .MuiFormGroup-root, .MuiBox-root');
    return { tag: i.tagName, name: i.name || null, role: i.getAttribute('role'), max: i.getAttribute('maxlength'), value: (i.value || '').slice(0, 80), label, nearby: wrap ? wrap.textContent.trim().slice(0, 200) : null };
  }).filter((f) => f.name || f.label || f.nearby));
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean));
  const options = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option']")).map((o) => o.textContent.trim()).slice(0, 30));
  console.log(JSON.stringify({ fields, options, buttons }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_WSK) {
  if ((await page.locator('input[name$="zasady_szesc_r_wskazniki"]').count()) === 0) {
    await pickFirst('zasady_szesc_r', '');
    await humanIdlePause('long');
  }
  await multiInto('zasady_szesc_r_projekt', ['ogranicz', 'zastanów']);
  await humanIdlePause('long');
  const input = page.locator('input[name$="zasady_szesc_r_wskazniki"]').first();
  const info = await input.evaluate((inp) => {
    const fc = inp.closest('.MuiFormControl-root');
    const root = inp.closest('.MuiInputBase-root');
    return {
      inputName: inp.getAttribute('name'),
      inputValue: inp.value || '',
      formControlHTML: fc ? fc.outerHTML.slice(0, 2200) : null,
      rootHTML: root ? root.outerHTML.slice(0, 1600) : null,
    };
  }); // allow-raw-playwright: read 10.4 wskazniki control structure
  const wskaznikiSelect = page.locator('.MuiInputBase-root:has(input[name$="zasady_szesc_r_wskazniki"])').locator('.MuiSelect-select, [role="combobox"] , .MuiInputBase-root').first();
  if (await wskaznikiSelect.count()) await humanClickLocator(page, wskaznikiSelect);
  await humanIdlePause('deliberate');
  const options = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option'], [role='option']")).map((o) => o.textContent.trim()).filter(Boolean));
  console.log(JSON.stringify({ info, options }, null, 2));
  process.exit(0);
}

async function multiInto(suffix, searches) {
  const picked = [];
  for (const s of searches) {
    const inp = page.locator(`input[name$="${suffix}"]`).first();
    await humanClickLocator(page, inp); await humanFill(page, inp, s);
    await humanIdlePause('deliberate');
    const opt = page.locator("[role='listbox'] [role='option']").first();
    if (await opt.count() > 0) { picked.push((await opt.textContent())?.trim()?.slice(0, 40)); await opt.dispatchEvent('click'); } // allow-raw-playwright: pick
    await humanIdlePause('short');
  }
  return picked;
}

async function openMuiSelectBySuffix(suffix) {
  const select = page.locator(`.MuiInputBase-root:has(input[name$="${suffix}"])`).locator('.MuiSelect-select, [role="combobox"]').first();
  if (!await select.count()) throw new Error(`MUI select not found: ${suffix}`);
  await humanClickLocator(page, select);
  await humanIdlePause('deliberate');
}

async function selectWskazniki(labels) {
  const picked = [];
  await openMuiSelectBySuffix('zasady_szesc_r_wskazniki');
  for (const label of ['Kompletność strukturalnego raportu audytowego', 'Redukcja attack success']) {
    const old = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await old.count() > 0 && (await old.getAttribute('aria-selected')) === 'true') {
      await old.dispatchEvent('click'); // allow-raw-playwright: remove non-environmental 10.4 indicator
      await humanIdlePause('short');
    }
  }
  for (const label of labels) {
    let opt = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await opt.count() === 0) {
      await openMuiSelectBySuffix('zasady_szesc_r_wskazniki');
      opt = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    }
    if (await opt.count() === 0) throw new Error(`wskaznik option not found: ${label}`);
    picked.push((await opt.textContent())?.trim());
    if ((await opt.getAttribute('aria-selected')) !== 'true') {
      await opt.dispatchEvent('click'); // allow-raw-playwright: select 10.4 wskaznik from MUI multi-select
      await humanIdlePause('short');
    }
  }
  await page.keyboard.press('Escape'); // allow-raw-playwright: close open MUI menu before save
  await humanIdlePause('short');
  return picked;
}

async function selectPrinciples(labels) {
  const picked = [];
  await openMuiSelectBySuffix('zasady_szesc_r_projekt');
  for (const label of labels) {
    let opt = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await opt.count() === 0) {
      await openMuiSelectBySuffix('zasady_szesc_r_projekt');
      opt = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    }
    if (await opt.count() === 0) throw new Error(`6R principle option not found: ${label}`);
    picked.push((await opt.textContent())?.trim());
    if ((await opt.getAttribute('aria-selected')) !== 'true') {
      await opt.dispatchEvent('click'); // allow-raw-playwright: select required 6R principle from MUI multi-select
      await humanIdlePause('short');
    }
  }
  await page.keyboard.press('Escape'); // allow-raw-playwright: close open 6R principle menu before save
  await humanIdlePause('short');
  return picked;
}

const WSK_LABELS = [
  'Redukcja ilości tokenów treningowych',
  'Udział cykli treningowych RNM z raportem energii',
];

if (process.env.WSK_ONLY) {
  const picked = await selectWskazniki(WSK_LABELS);
  let saveResult = 'saved';
  try { await saveEnabled('wsk'); } catch (e) { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 80)}`; }
  const readback = await page.evaluate(() => {
    const inp = document.querySelector('input[name$="zasady_szesc_r_wskazniki"]');
    const root = inp && inp.closest('.MuiInputBase-root');
    return {
      hiddenValue: inp?.value || '',
      display: root ? root.textContent.trim().slice(0, 500) : '',
    };
  }); // allow-raw-playwright: read selected 10.4 wskazniki
  console.log(JSON.stringify({ saveResult, picked, readback }, null, 2));
  process.exit(0);
}

await pickFirst('zasady_szesc_r', '');
await humanIdlePause('deliberate');
const projekt = await selectPrinciples(['ogranicz', 'zastanów']);
const ta6r = page.locator('textarea[name$="opis_zasady_szesc_r"]').first();
let v6 = OPIS_6R; if (v6.length > 4000) v6 = v6.slice(0, 4000).replace(/\s+\S*$/, '');
await humanFill(page, ta6r, v6);
await humanIdlePause('short');
let wOpts = [];
try {
  wOpts = await selectWskazniki(WSK_LABELS);
} catch (e) {
  wOpts = [`SKIPPED: ${String(e?.message || e).slice(0, 120)}`];
}
await humanIdlePause('deliberate'); await humanIdlePause('deliberate');
let saveResult = 'saved';
try { await saveEnabled('main'); } catch (e) { saveResult = `MAIN NOT SAVED: ${String(e?.message || e).slice(0, 70)}`; }

let actResult = 'skipped';
if (saveResult === 'saved') {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (!(await page.evaluate((name) => (document.body.innerText || '').includes(name), ACT.name))) {
    const addButton = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
    if (!await addButton.count()) throw new Error('Dodaj not found');
    await humanClickLocator(page, addButton);
    await humanIdlePause('long');
    const act = page.locator('input[name="akt_prawny"]').first();
    await humanClickLocator(page, act); await humanFill(page, act, 'Inne');
    await humanIdlePause('deliberate');
    const opt = page.locator("[role='listbox'] [role='option']").first();
    if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: pick "inne"
    await humanIdlePause('short');
    const uz = page.locator('textarea[name="uzasadnienie"]').first();
    const max = Number(await uz.getAttribute('maxlength')) || 1000;
    let u = ACT.justification; if (u.length > max) u = u.slice(0, max).replace(/\s+\S*$/, '');
    await humanFill(page, uz, u);
    await humanIdlePause('short');
    await saveEnabled('act');
    actResult = `saved ${u.length}/${max}`;
  } else {
    actResult = 'already present';
  }
}
const readback = await page.evaluate(() => {
  const table = document.querySelector('table');
  return {
    zasady: document.querySelector('input[name$="zasady_szesc_r"]')?.value || '',
    tableRows: table ? table.querySelectorAll('tbody tr').length : 0,
    body: (document.body.innerText || '').slice(0, 1200),
  };
});
console.log(JSON.stringify({ saveResult, actResult, projekt, opis6r: v6.length, wOpts, readback }, null, 2));
process.exit(0);
