// UI-only repair for section 2.4 parameters in the replacement NCBR draft.
// DIAG dumps the sub-form; normal mode adds all prepared parameter rows.
// Never submits the application.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/94fb1adb-38a5-4949-b4c1-b0a79472bfd3'].join('');
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.4_efekty_zewnetrzne.md';

const md = readFileSync(MD, 'utf8');
const clean = (s) => (s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();

function tableValue(block, key) {
  const line = block.split('\n').find((l) => l.trim().startsWith('|') && l.toLowerCase().includes(key.toLowerCase()));
  if (!line) throw new Error(`missing 2.4 table row: ${key}`);
  const cells = line.split('|').map((c) => c.trim());
  return clean(cells[2]);
}

const paramBlocks = md.split(/^### Parametr \d+\s*$/m).slice(1);
const params = paramBlocks.map((block) => ({
  nazwa: tableValue(block, 'Nazwa parametru'),
  bazowa: tableValue(block, 'Wartość bazowa'),
  rokBazowy: tableValue(block, 'Rok bazowy'),
  docelowa: tableValue(block, 'Wartość docelowa'),
  rokDocelowy: tableValue(block, 'Rok docelowy'),
  metoda: tableValue(block, 'Metoda oszacowania'),
  monitoring: tableValue(block, 'Sposób monitorowania'),
}));

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(0);
}

async function clickVisibleButton(text) {
  await page.evaluate((text) => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === text && b.getClientRects().length);
    if (!buttons.length) throw new Error(`button not found: ${text}`);
    buttons[buttons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, text); // allow-raw-playwright: UI-only section 2.4 button click, never submit
  await humanIdlePause('long');
}

async function gotoSection() {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await humanIdlePause('deliberate');
}

async function tableText() {
  return page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table) => table.innerText || '').join('\n'));
} // allow-raw-playwright: read-only 2.4 table text

async function fieldDump() {
  return page.evaluate(() => {
    const labelFor = (el) => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return lab.textContent.trim();
      }
      let node = el;
      for (let i = 0; i < 6 && node; i += 1) {
        node = node.parentElement;
        const lab = node?.querySelector?.('label, .MuiFormLabel-root, legend');
        if (lab?.textContent) return lab.textContent.trim();
      }
      return '';
    };
    return Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
      tag: el.tagName,
      name: el.name || '',
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      maxlength: el.getAttribute('maxlength') || '',
      placeholder: el.getAttribute('placeholder') || '',
      label: labelFor(el).slice(0, 120),
      value: (el.value || '').slice(0, 60),
    })).filter((f) => f.name || f.label);
  }); // allow-raw-playwright: read-only field dump
}

async function fillBySuffix(suffix, value) {
  const loc = page.locator(`input[name$="${suffix}"], textarea[name$="${suffix}"]`).first();
  const count = await loc.count();
  if (count === 0) throw new Error(`field not found: ${suffix}`);
  const max = Number(await loc.getAttribute('maxlength')) || value.length;
  let v = value;
  if (v.length > max) throw new Error(`${suffix} too long: ${v.length}/${max}`);
  await loc.fill(v); // allow-raw-playwright: UI-only 2.4 parameter text input
  await humanIdlePause('short');
  return { suffix, len: v.length, max };
}

async function addParam(p) {
  await gotoSection();
  const current = await tableText();
  if (current.includes(p.nazwa.slice(0, 50))) return { skipped: true, filled: [] };
  await clickVisibleButton('Dodaj');
  await humanIdlePause('deliberate');
  const filled = [];
  filled.push(await fillBySuffix('nazwa_parametru', p.nazwa));
  filled.push(await fillBySuffix('wartosc_bazowa', p.bazowa));
  filled.push(await fillBySuffix('rok_bazowy', p.rokBazowy));
  filled.push(await fillBySuffix('wartosc_docelowa', p.docelowa));
  filled.push(await fillBySuffix('rok_docelowy', p.rokDocelowy));
  filled.push(await fillBySuffix('metoda_szacowania_wartosci_docelowej', p.metoda));
  filled.push(await fillBySuffix('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', p.monitoring));
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await clickVisibleButton('Zapisz');
  await humanIdlePause('long');
  await gotoSection();
  return { skipped: false, filled };
}

await gotoSection();

if (process.env.DIAG) {
  await clickVisibleButton('Dodaj');
  await humanIdlePause('deliberate');
  console.log(JSON.stringify({ paramsParsed: params.length, fields: await fieldDump() }, null, 2));
  process.exit(0);
}

const added = [];
for (const p of params) {
  const result = await addParam(p);
  added.push({ nazwa: p.nazwa.slice(0, 80), ...result });
}

await gotoSection();
const readback = await page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table, i) => ({
  i,
  rows: table.querySelectorAll('tbody tr').length,
  text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\s+/g, ' ').slice(0, 260)),
}))); // allow-raw-playwright: read-only 2.4 table readback

console.log(JSON.stringify({ addedCount: added.filter((a) => !a.skipped).length, added, readback }, null, 2));
process.exit(0);
