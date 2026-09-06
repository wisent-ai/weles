// Repairs missing 1.3 activity-description and KKK collection rows. UI-only.
// Never submits and never closes the page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/317a21dd-e798-4115-ab53-6ab5a2912fb0';
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_1_3_podmioty.md';
const md = readFileSync(MD, 'utf8');

function after(marker, endMarker) {
  const start = md.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const from = start + marker.length;
  const end = endMarker ? md.indexOf(endMarker, from) : -1;
  return md.slice(from, end >= 0 ? end : undefined).replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
}

const OPIS = after('**Opis działalności podmiotu**', '## Uczestnictwo w Krajowym Klastrze Kluczowym');

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

async function clickDodaj(nth) {
  await page.evaluate((n) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
    if (!btns[n]) throw new Error(`Dodaj #${n} not found; count=${btns.length}`);
    btns[n].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, nth); // allow-raw-playwright: open exact 1.3 collection subform
  await humanIdlePause('long');
}

async function setApplicant() {
  await page.evaluate(() => {
    const inp = document.querySelector("input[name='nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta']");
    const root = inp && inp.closest('.MuiInputBase-root');
    const select = root && root.querySelector('.MuiSelect-select, [role="combobox"]');
    if (select) for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) select.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    else if (inp) inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open applicant select
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
  await humanIdlePause('short');
}

async function fillFirstTextArea(value) {
  const loc = page.locator('textarea[name="opis_dzialalnosci_i_struktura"]').first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || value.length;
  let v = value;
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.fill(v); // allow-raw-playwright: activity description text
  await humanIdlePause('short');
  return v.length;
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save subform
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodaj(Number(process.env.DIAG));
  const out = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      return { tag: el.tagName, type: el.type || null, name: el.name || null, role: el.getAttribute('role'), max: el.getAttribute('maxlength'), value: (el.value || '').slice(0, 80), label };
    }).filter((f) => f.name || f.label),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean),
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const done = [];
if (!await page.evaluate(() => (document.body.innerText || '').includes('Spółka rozwija oprogramowanie i modele sztucznej inteligencji'))) {
  await clickDodaj(2);
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound */ }
  const len = await fillFirstTextArea(OPIS);
  const ue = page.locator('input[name="podmiot_jest_kontrolowany_przez_panstwo_lub_podmiot_z_panstwa_nalezacego_do_ue"]').first();
  if (await ue.count() > 0 && !await ue.isChecked()) await ue.dispatchEvent('click'); // allow-raw-playwright: confirm EU control checkbox
  await saveForm();
  done.push({ collection: 'opis_dzialalnosci', len });
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const kkkRows = await page.evaluate(() => {
  const tables = Array.from(document.querySelectorAll('table'));
  const table = tables[tables.length - 1];
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
if (kkkRows === 0) {
  await clickDodaj(3);
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound */ }
  await page.locator('input[type="radio"][value="Nie"]').first().dispatchEvent('click'); // allow-raw-playwright: KKK membership = Nie
  await humanIdlePause('short');
  await saveForm();
  done.push({ collection: 'kkk', value: 'Nie' });
}

const readback = await page.evaluate(() => ({
  tables: Array.from(document.querySelectorAll('table')).map((t) => ({
    rows: t.querySelectorAll('tbody tr').length,
    text: t.innerText.replace(/\s+/g, ' ').slice(0, 300),
  })),
}));
console.log(JSON.stringify({ done, readback }, null, 2));
process.exit(0);
