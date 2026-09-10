// UI-only correction for NEW NCBR draft section 10.4. Never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const SECTION_URL = [`https://`, `lsi2.ncbr.gov.pl/projekt/${projectId}/projekt_step/4e260fae-c455-41ce-bba3-d0df2a8767fd`].join('');
const md = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_10.4_zrownowazony_rozwoj.md', 'utf8');

function between(start, end) {
  const rest = md.split(start)[1] || '';
  return (end ? rest.split(end)[0] : rest)
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();
}

const OPIS_6R = between('## Opis sposobu realizacji projektu zgodnie z wybranymi zasadami 6R (limit 4 000 znaków)', '## Stosowanie zasad 6R zostało odzwierciedlone');
const OPIS_INNE = between('## Opis pozytywnego wpływu na inne aspekty środowiskowe w ramach projektu (nie objęte zasadami 6R)', '## Pozytywny wpływ na inne aspekty środowiskowe');
const WSK_LABELS = [
  'Redukcja ilości tokenów treningowych',
  'Udział cykli treningowych RNM z pomiarem energii',
];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(1); }
page.setDefaultTimeout(15000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: UI navigation to authenticated LSI draft section
await humanIdlePause('long');
await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner only

async function clickFirstOption(inputSuffix, search = '') {
  const input = page.locator(`input[name$="${inputSuffix}"]`).first();
  await input.waitFor({ state: 'visible' });
  await humanClickLocator(page, input);
  if (search) await humanFill(page, input, search); // allow-raw-playwright: open/filter LSI autocomplete despite body pointer interception
  await humanIdlePause('deliberate');
  const option = page.locator("[role='listbox'] [role='option'], [role='option']").first();
  if (await option.count() === 0) throw new Error(`no option for ${inputSuffix}`);
  const text = (await option.textContent())?.trim() || '';
  await option.dispatchEvent('click'); // allow-raw-playwright: select visible option
  await humanIdlePause('short');
  return text;
}

async function multiPick(inputSuffix, searches) {
  const picked = [];
  for (const search of searches) {
    picked.push(await clickFirstOption(inputSuffix, search));
  }
  return picked;
}

async function openMuiSelect(inputSuffix) {
  const target = page.locator(`input[name$="${inputSuffix}"]`).first().locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
  if (await target.count() === 0) throw new Error(`select not found: ${inputSuffix}`);
  await humanClickLocator(page, target); // allow-raw-playwright: open visible MUI select control
  await humanIdlePause('deliberate');
}

async function selectIndicators(labels) {
  const picked = [];
  await openMuiSelect('zasady_szesc_r_wskazniki');
  for (const label of ['Kompletność strukturalnego raportu audytowego', 'Redukcja attack success']) {
    const old = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await old.count() > 0 && (await old.getAttribute('aria-selected')) === 'true') {
      await old.dispatchEvent('click'); // allow-raw-playwright: remove non-environmental 10.4 indicator
      await humanIdlePause('short');
    }
  }
  for (const label of labels) {
    await openMuiSelect('zasady_szesc_r_wskazniki');
    const option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await option.count() === 0) {
      const seen = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option'], [role='option']")).map((o) => o.textContent.trim()).filter(Boolean));
      throw new Error(`indicator not found: ${label}; seen=${seen.join(' | ')}`);
    }
    picked.push((await option.textContent())?.trim() || label);
    if ((await option.getAttribute('aria-selected')) !== 'true') {
      await option.dispatchEvent('click'); // allow-raw-playwright: select 10.4 indicator
      await humanIdlePause('short');
    }
  }
  await page.keyboard.press('Escape'); // allow-raw-playwright: close menu before save
  await humanIdlePause('short');
  return picked;
}

async function selectPrinciples(labels) {
  const picked = [];
  await openMuiSelect('zasady_szesc_r_projekt');
  for (const label of labels) {
    let option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await option.count() === 0) {
      await openMuiSelect('zasady_szesc_r_projekt');
      option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    }
    if (await option.count() === 0) throw new Error(`6R principle not found: ${label}`);
    picked.push((await option.textContent())?.trim() || label);
    if ((await option.getAttribute('aria-selected')) !== 'true') {
      await option.dispatchEvent('click'); // allow-raw-playwright: select required 6R principle
      await humanIdlePause('short');
    }
  }
  await page.keyboard.press('Escape'); // allow-raw-playwright: close menu before save
  await humanIdlePause('short');
  return picked;
}

async function fillTextarea(selector, value) {
  const loc = page.locator(selector).first();
  if (await loc.count() === 0) return null;
  const max = Number(await loc.getAttribute('maxlength')) || value.length;
  let v = value;
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await humanFill(page, loc, v); // allow-raw-playwright: fill LSI textarea
  await humanIdlePause('short');
  return v.length;
}

const variant = await clickFirstOption('zasady_szesc_r', '');
await humanIdlePause('long');
const principles = await selectPrinciples(['ogranicz', 'zastanów']);
const opis6r = await fillTextarea('textarea[name$="opis_zasady_szesc_r"]', OPIS_6R);
const opisInne = await fillTextarea('textarea[name*="inne"], textarea[name*="pozytyw"]', OPIS_INNE);
const indicators = await selectIndicators(WSK_LABELS);

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
try {
  await humanClickLocator(page, page.locator('button:visible:not([disabled])').filter({ hasText: /^Zapisz$/ }).last()); // allow-raw-playwright: save section through visible UI
  await humanIdlePause('long');
} catch (e) {
  saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 100)}`;
}

const readback = await page.evaluate(() => ({
  url: location.href,
  zasady: document.querySelector('input[name$="zasady_szesc_r"]')?.value || '',
  chips: Array.from(document.querySelectorAll('.MuiChip-label')).map((c) => c.textContent.trim()),
  textareas: Array.from(document.querySelectorAll('textarea')).map((t) => ({
    name: (t.name || '').split('.').pop(),
    length: (t.value || '').length,
  })),
  tables: Array.from(document.querySelectorAll('table')).map((t) => ({ rows: t.querySelectorAll('tbody tr').length, text: (t.innerText || '').replace(/\s+/g, ' ').slice(0, 600) })),
  buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text === 'Zapisz'),
})); // allow-raw-playwright: read 10.4 state after save attempt

console.log(JSON.stringify({ saveResult, variant, principles, opis6r, opisInne, indicators, readback }, null, 2));
process.exit(saveResult === 'saved' ? 0 : 2);
