// Section 8 (Zrodla finansowania wydatkow) — one Wisent Polska row.
// UI-only. Never closes the page and never submits.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/d31b6d68-33b7-45a0-a032-0f5f02b5aed8';

const AMOUNTS = {
  euTotal: '11950000.00',
  euEligible: '11950000.00',
  privateTotal: '3675000.00',
  privateEligible: '3675000.00',
  ownTotal: '0.00',
  ownEligible: '0.00',
  loanTotal: '3675000.00',
  loanEligible: '3675000.00',
  creditTotal: '0.00',
  creditEligible: '0.00',
};

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner overlay only

async function clickDodaj() {
  const add = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
  await humanClickLocator(page, add);
  await humanIdlePause('long');
}

async function setApplicant() {
  const applicant = page.locator('input[name*="nazwa_skrocona"]').first();
  const applicantSelect = applicant.locator('xpath=ancestor::*[contains(@class, "MuiInputBase-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
  if (await applicantSelect.count()) await humanClickLocator(page, applicantSelect);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await humanClickLocator(page, opt); // allow-raw-playwright: select Wisent applicant
  await humanIdlePause('short');
}

async function fillBySuffix(fragment, value) {
  const loc = page.locator(`input[name*="${fragment}"], textarea[name*="${fragment}"]`).first();
  await loc.waitFor({ state: 'visible' });
  await humanFill(page, loc, value); // allow-raw-playwright: fill section 8 amount field
  await humanIdlePause('short');
  return { fragment, value };
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const save = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last();
  await humanClickLocator(page, save);
  await humanIdlePause('long');
}

async function fillFinancingFields() {
  const filled = [];
  filled.push(await fillBySuffix('srodki_wspolnotowe_wydatki_ogolem', AMOUNTS.euTotal));
  filled.push(await fillBySuffix('srodki_wspolnotowe_wydatki_kwalifikowalne', AMOUNTS.euEligible));
  filled.push(await fillBySuffix('prywatne_w_tym_wydatki_ogolem', AMOUNTS.privateTotal));
  filled.push(await fillBySuffix('prywatne_w_tym_wydatki_kwalifikowalne', AMOUNTS.privateEligible));
  filled.push(await fillBySuffix('srodki_wlasne_wydatki_ogolem', AMOUNTS.ownTotal));
  filled.push(await fillBySuffix('srodki_wlasne_wydatki_kwalifikowalne', AMOUNTS.ownEligible));
  filled.push(await fillBySuffix('kredyt_wydatki_ogolem', AMOUNTS.creditTotal));
  filled.push(await fillBySuffix('kredyt_wydatki_kwalifikowalne', AMOUNTS.creditEligible));
  filled.push(await fillBySuffix('pozyczka_wydatki_ogolem', AMOUNTS.loanTotal));
  filled.push(await fillBySuffix('pozyczka_wydatki_kwalifikowalne', AMOUNTS.loanEligible));
  return filled;
}

async function editExistingWisentRow() {
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: 'Wisent Polska' }).first();
  if (await row.count() === 0) return false;
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open section 8 row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing financing row
  await humanIdlePause('long');
  return true;
}

if (!await page.evaluate(() => (document.body.innerText || '').includes('Wisent Polska'))) {
  await clickDodaj();
  if (process.env.DIAG_AFTER_APPLICANT) {
    try { await setApplicant(); } catch (e) { /* single-applicant forms may auto-assign applicant */ }
    const out = await page.evaluate(() => ({
      fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
        const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
        return { tag: el.tagName, name: el.name || null, type: el.type || null, role: el.getAttribute('role'), readOnly: el.readOnly, disabled: el.disabled, value: (el.value || '').slice(0, 80), label };
      }).filter((f) => f.name || f.label),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
    }));
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  if (process.env.DIAG) {
    const out = await page.evaluate(() => ({
      fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
        const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
        return { tag: el.tagName, name: el.name || null, type: el.type || null, role: el.getAttribute('role'), value: (el.value || '').slice(0, 80), label };
      }).filter((f) => f.name || f.label),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
    }));
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  try { await setApplicant(); } catch (e) { /* single-applicant forms may auto-assign applicant */ }
  const filled = await fillFinancingFields();
  await saveForm();
  console.log(JSON.stringify({ added: true, filled }, null, 2));
} else if (process.env.REWRITE) {
  const opened = await editExistingWisentRow();
  if (!opened) throw new Error('existing Wisent Polska section 8 row not found');
  const filled = await fillFinancingFields();
  await saveForm();
  console.log(JSON.stringify({ rewritten: true, filled }, null, 2));
} else if (process.env.DIAG) {
  console.log(JSON.stringify({ note: 'row already exists before DIAG' }, null, 2));
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const readback = await page.evaluate(() => ({
  tables: Array.from(document.querySelectorAll('table')).map((t) => Array.from(t.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\s+/g, ' '))),
})); // allow-raw-playwright: read back section 8 tables
console.log(JSON.stringify({ readback }, null, 2));
process.exit(0);
