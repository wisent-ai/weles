// Section 10.1 required product/service accessibility collection. UI-only; never closes page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/e5bd23d7-9d4d-4f2e-948a-97c95041ef18';
const md = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_10_1_rowność.md', 'utf8');

function clean(s) {
  return s.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
}

function products() {
  return md.split('**Nazwa produktu/usługi**').slice(1).map((block) => {
    const name = clean(block.split('**Wpływ**')[0]);
    const impact = clean((block.split('**Wpływ**')[1] || '').split('**Uzasadnienie**')[0]);
    const justification = clean((block.split('**Uzasadnienie**')[1] || '').split('**Nazwa produktu/usługi**')[0].split('**Zgodność projektu')[0]);
    return { name, impact, justification };
  }).filter((p) => p.name && p.justification);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function clickDodaj() {
  const button = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
  if (await button.count() === 0) throw new Error('Dodaj not found');
  await humanClickLocator(page, button);
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodaj();
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => {
    const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
    const wrap = el.closest('label, .MuiFormControl-root, .MuiFormGroup-root, .MuiBox-root');
    return {
      tag: el.tagName,
      type: el.getAttribute('type') || null,
      name: el.getAttribute('name') || null,
      role: el.getAttribute('role') || null,
      max: el.getAttribute('maxlength') || null,
      value: (el.value || '').slice(0, 60),
      label,
      nearby: wrap ? wrap.textContent.trim().slice(0, 180) : null,
    };
  }).filter((f) => f.name || f.label || f.nearby));
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean));
  console.log(JSON.stringify({ parsedProducts: products(), fields, buttons }, null, 2));
  process.exit(0);
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  if (await saves.count() === 0) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.last());
  await humanIdlePause('long');
}

async function fillText(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || value.length;
  let v = value;
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await humanFill(page, loc, v);
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function setAuto(name, value) {
  const inp = page.locator(`input[name="${name}"]`).first();
  await humanClickLocator(page, inp);
  await humanFill(page, inp, value);
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option']").filter({ hasText: value }).first();
  if (await opt.count() === 0) throw new Error(`no option: ${name} -> ${value}`);
  await opt.dispatchEvent('click'); // allow-raw-playwright: select impact option
  await humanIdlePause('short');
}

const added = [];
for (const p of products()) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (await page.evaluate((name) => (document.body.innerText || '').includes(name), p.name)) continue;
  await clickDodaj();
  const filled = [];
  filled.push(await fillText('nazwa_produktu_uslugi', p.name));
  await setAuto('wplyw', p.impact);
  filled.push(await fillText('uzasadnienie', p.justification));
  await saveForm();
  added.push({ name: p.name, filled });
}

const readback = await page.evaluate(() => {
  const table = document.querySelector('table');
  return {
    rows: table ? table.querySelectorAll('tbody tr').length : 0,
    text: (table?.innerText || '').slice(0, 1000),
  };
});
console.log(JSON.stringify({ added, readback }, null, 2));
process.exit(0);
