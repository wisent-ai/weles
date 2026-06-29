// Section 7 risk collection for the replacement draft. Never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/77be8643-1e31-4619-b266-d156a5388cf6';
const MD = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_7_ryzyka.md', 'utf8');

function field(block, label) {
  const marker = `**${label}**`;
  const a = block.indexOf(marker);
  if (a < 0) return '';
  const rest = block.slice(a + marker.length).replace(/^\s+/, '');
  const b = rest.search(/\n\n\*\*|\n## /);
  return rest.slice(0, b >= 0 ? b : undefined).replace(/\s+/g, ' ').trim();
}
const risks = MD.split(/^## Ryzyka\s*$/m).slice(1).map((block) => ({
  nazwa: field(block, 'Nazwa ryzyka'),
  typ: field(block, 'Typ ryzyka'),
  opis: field(block, 'Opis ryzyka'),
  zapobieganie: field(block, 'Zapobieganie ryzyku'),
})).filter((r) => r.nazwa && r.typ && r.opis && r.zapobieganie);

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
  }); // allow-raw-playwright: open risk subform
  await humanIdlePause('long');
}

async function setAuto(name, search) {
  const inp = page.locator(`input[name="${name}"], input[name$="${name}"]`).first();
  await inp.click(); // allow-raw-playwright: open risk type autocomplete
  await inp.fill(search); // allow-raw-playwright: filter risk type
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option'], [role='option']").first();
  if (await opt.count() === 0) throw new Error(`no option for ${name}: ${search}`);
  const picked = (await opt.textContent())?.trim();
  await opt.dispatchEvent('click'); // allow-raw-playwright: select risk type
  await humanIdlePause('short');
  return picked;
}

async function fillName(name, value) {
  const loc = page.locator(`textarea[name="${name}"], input[name="${name}"], textarea[name$="${name}"], input[name$="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.fill(v); // allow-raw-playwright: risk text field
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function saveEnabled() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save risk subform
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
  console.log(JSON.stringify({ parsed: risks.length, fields: out }, null, 2));
  process.exit(0);
}

const added = [];
for (const r of risks) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const exists = await page.evaluate((needle) => (document.body.innerText || '').includes(needle), r.nazwa.slice(0, 90));
  if (exists) continue;
  await clickDodaj();
  const filled = [];
  filled.push(await fillName('nazwa_ryzyka', r.nazwa));
  const picked = await setAuto('typ_ryzyka', r.typ);
  filled.push(await fillName('opis_ryzyka', r.opis));
  filled.push(await fillName('zapobieganie', r.zapobieganie));
  await saveEnabled();
  added.push({ name: r.nazwa.slice(0, 70), picked, filled });
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const readback = await page.evaluate(() => {
  const table = document.querySelector('table');
  return { rows: table ? table.querySelectorAll('tbody tr').length : 0, text: (table?.innerText || '').replace(/\s+/g, ' ').slice(0, 1000) };
});
console.log(JSON.stringify({ parsed: risks.length, added, readback }, null, 2));
process.exit(0);
