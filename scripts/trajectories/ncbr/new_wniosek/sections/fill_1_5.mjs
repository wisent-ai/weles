// Section 1.5 (Miejsce realizacji projektu) of the NEW NCBR wniosek.
// Collection row: applicant + address dictionaries + street/number. Never closes page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/3b7656d2-f2d7-44df-af43-4f4b58b4101f';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function clickDodaj(nth) {
  await page.evaluate((n) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj');
    if (!btns[n]) throw new Error(`Dodaj #${n} not found`);
    btns[n].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // allow-raw-playwright: synthetic Dodaj click (Kimi reference)
  }, nth);
  await humanIdlePause('long');
}
async function saveForm() {
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!s.length) throw new Error('no enabled Zapisz');
    s[s.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // allow-raw-playwright: synthetic save (Kimi reference)
  });
  await humanIdlePause('long');
  await humanIdlePause('deliberate');
}
async function setApplicant() {
  await page.evaluate((nm) => {
    const inp = document.querySelector(`input[name="${nm}"]`);
    const sel = inp && inp.closest('.MuiInputBase-root')?.querySelector('.MuiSelect-select, [role="combobox"]');
    if (sel) { for (const t of ['mousedown', 'mouseup', 'click']) sel.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } // allow-raw-playwright: open applicant MUI select
  }, 'nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta');
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  await opt.waitFor({ state: 'visible' });
  await opt.click({ force: true }); // allow-raw-playwright: select Wisent applicant
  await humanIdlePause('short');
}
async function setAuto(name, value) {
  const inp = page.locator(`input[name$="${name}"]`).first();
  await inp.click(); // allow-raw-playwright: open combobox
  await inp.fill(''); // allow-raw-playwright: clear
  await inp.fill(value); // allow-raw-playwright: filter
  await humanIdlePause('deliberate');
  const opts = page.locator("[role='listbox'] [role='option']");
  if (await opts.count() === 0) throw new Error(`no options: ${name} -> ${value}`);
  await opts.first().dispatchEvent('click'); // allow-raw-playwright: pick option
  await humanIdlePause('short');
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: neutralise cookie banner

await clickDodaj(0);
await humanIdlePause('deliberate');

if (process.env.DIAG) {
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((i) => ({ tag: i.tagName, name: i.name, role: i.getAttribute('role'), label: (document.querySelector(`label[for="${i.id}"]`)?.textContent || '').trim().slice(0, 50) })).filter((f) => f.name));
  console.log(JSON.stringify(fields, null, 2));
  process.exit(0);
}

try { await setApplicant(); } catch (e) { /* auto-assigned */ }
await setAuto('miejsce_realizacji_wojewodztwo', 'LUBELSKIE');
await setAuto('miejsce_realizacji_powiat', 'Lublin');
await setAuto('miejsce_realizacji_gmina', 'Lublin');
await setAuto('miejsce_realizacji_miejscowosc', 'Lublin');
await setAuto('miejsce_realizacji_ulica', 'Frezerów');
await page.locator("[name$='miejsce_realizacji_nr_budynku']").first().fill('3'); // allow-raw-playwright: text
await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
try { await saveForm(); } catch (e) { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 70)}`; }

const readback = await page.evaluate(() => {
  const tbl = document.querySelector('table');
  let rows = -1;
  if (tbl) rows = tbl.querySelectorAll('tbody tr').length;
  return { rows };
});
console.log(JSON.stringify({ saveResult, readback }, null, 2));
process.exit(0);
