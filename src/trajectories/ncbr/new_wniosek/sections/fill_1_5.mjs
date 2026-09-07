// Section 1.5 (Miejsce realizacji projektu) of the NEW NCBR wniosek.
// Collection row: applicant + address dictionaries + street/number. Never closes page.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/3b7656d2-f2d7-44df-af43-4f4b58b4101f';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function clickDodaj(nth) {
  const button = page.getByRole('button', { name: 'Dodaj', exact: true }).nth(nth);
  if (await button.count() === 0) throw new Error(`Dodaj #${nth} not found`);
  await humanClickLocator(page, button);
  await humanIdlePause('long');
}
async function saveForm() {
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const enabled = saves.filter({ hasNot: page.locator('[disabled]') });
  if (await enabled.count() === 0) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, enabled.last());
  await humanIdlePause('long');
  await humanIdlePause('deliberate');
}
async function setApplicant() {
  const applicant = page.locator('input[name="nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta"]')
    .locator('xpath=ancestor::*[contains(@class, "MuiInputBase-root")][1]')
    .locator('.MuiSelect-select, [role="combobox"]').first();
  if (await applicant.count() > 0) await humanClickLocator(page, applicant);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  await opt.waitFor({ state: 'visible' });
  await humanClickLocator(page, opt);
  await humanIdlePause('short');
}
async function setAuto(name, value) {
  const inp = page.locator(`input[name$="${name}"]`).first();
  await humanClickLocator(page, inp);
  await humanFill(page, inp, '');
  await humanFill(page, inp, value);
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
await humanFill(page, page.locator("[name$='miejsce_realizacji_nr_budynku']").first(), '3');
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
