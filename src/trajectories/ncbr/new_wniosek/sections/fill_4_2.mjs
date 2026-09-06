// Section 4.2 resources collection for the replacement draft. Never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/95a9b43d-b789-479a-a60d-159b975af74d';
const MD = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_4_2_zasoby_techniczne.md', 'utf8');

function val(block, label) {
  const marker = `**${label}:**`;
  const a = block.indexOf(marker);
  if (a < 0) return '';
  const rest = block.slice(a + marker.length);
  const b = rest.search(/\n\n\*\*|\n---|\n## /);
  return rest.slice(0, b >= 0 ? b : undefined).replace(/\s+/g, ' ').trim();
}
const rows = MD.split(/^## Wpis \d+\s*$/m).slice(1).map((block) => ({
  typ: val(block, 'Typ zasobu'),
  nazwa: val(block, 'Nazwa zasobu'),
  przeznaczenie: val(block, 'Przeznaczenie'),
})).filter((r) => r.typ && r.nazwa && r.przeznaczenie);

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(12000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function clickDodaj() {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
    if (!btn) throw new Error('Dodaj not found');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open resource subform
  await humanIdlePause('long');
}

async function setApplicant() {
  await page.evaluate(() => {
    const inp = Array.from(document.querySelectorAll('input')).find((i) => /nazwa_skrocona_wnioskodawcy/.test(i.name || ''));
    const root = inp && inp.closest('.MuiInputBase-root');
    const select = root && root.querySelector('.MuiSelect-select, [role="combobox"]');
    if (!select) return;
    for (const t of ['mousedown', 'mouseup', 'click']) select.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open applicant select
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
  await humanIdlePause('short');
}

async function setAuto(suffix, value) {
  const prefix = value.split(',')[0].trim();
  const inp = page.locator(`input[name$="${suffix}"]`).first();
  await inp.click(); // allow-raw-playwright: open type autocomplete
  await inp.fill(prefix); // allow-raw-playwright: comma-free prefix filter
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: prefix }).first();
  if (await opt.count() === 0) throw new Error(`no option for ${suffix}: ${prefix}`);
  const picked = (await opt.textContent())?.trim();
  await opt.dispatchEvent('click'); // allow-raw-playwright: pick resource type
  await humanIdlePause('short');
  return picked;
}

async function fillSuffix(suffix, value) {
  const loc = page.locator(`textarea[name$="${suffix}"], input[name$="${suffix}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.fill(v); // allow-raw-playwright: resource text field
  await humanIdlePause('short');
  return `${suffix} ${v.length}/${max}`;
}

async function saveEnabled() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save resource subform
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodaj();
  const out = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
    tag: el.tagName,
    name: el.name || null,
    role: el.getAttribute('role'),
    max: el.getAttribute('maxlength'),
  })).filter((f) => f.name));
  console.log(JSON.stringify({ parsed: rows.length, fields: out }, null, 2));
  process.exit(0);
}

const added = [];
for (const row of rows) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const exists = await page.evaluate((needle) => (document.body.innerText || '').includes(needle), row.nazwa.slice(0, 80));
  if (exists) continue;
  await clickDodaj();
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-selected */ }
  const picked = await setAuto('typ_zasobu', row.typ);
  const filled = [];
  filled.push(await fillSuffix('nazwa_zasobu', row.nazwa));
  filled.push(await fillSuffix('przeznaczenie', row.przeznaczenie));
  await saveEnabled();
  added.push({ name: row.nazwa.slice(0, 60), picked, filled });
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const readback = await page.evaluate(() => {
  const table = document.querySelector('table');
  return { rows: table ? table.querySelectorAll('tbody tr').length : 0, text: (table?.innerText || '').replace(/\s+/g, ' ').slice(0, 1000) };
});
console.log(JSON.stringify({ added, readback }, null, 2));
process.exit(0);
