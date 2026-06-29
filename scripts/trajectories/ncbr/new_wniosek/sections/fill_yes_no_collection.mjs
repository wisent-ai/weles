// Generic Tak/Nie collection filler for 4.3, 5.3 and 5.4 in the replacement draft. Never submits.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const PROJ = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/';
const REG = {
  '4.3': { id: 'e8020b59-7947-4c3d-9851-0fc499f42427', answer: 'Nie' },
  '5.3': { id: '72d09821-7019-4ac0-ab4f-09fdd4883fc2', answer: 'Tak', locationPremium: true },
  '5.4': { id: 'e635f786-a34c-4a29-b142-4f4081401a5c', answer: 'Nie' },
};

const SECTION = process.env.SECTION;
const cfg = REG[SECTION];
if (!cfg) throw new Error(`SECTION must be one of ${Object.keys(REG).join(', ')}`);
const ANSWER = process.env.ANSWER || cfg.answer;

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(12000);

await page.goto(PROJ + cfg.id, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function dataRowCount() {
  return page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr')).filter((r) => r.querySelector('button[aria-label="overflow-options"]')).length);
}

async function openForm() {
  if (await dataRowCount() > 0) {
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('table tbody tr')).find((r) => r.querySelector('button[aria-label="overflow-options"]'));
      row.querySelector('button[aria-label="overflow-options"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: open row menu
    await humanIdlePause('deliberate');
    await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing row
  } else {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
      if (!btn) throw new Error('Dodaj not found');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: open new row
  }
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

async function saveEnabled() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save Tak/Nie collection row
  await humanIdlePause('long');
}

await openForm();
try { await setApplicant(); } catch (e) { /* single applicant may be auto-selected */ }

if (process.env.DIAG) {
  const out = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el, i) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      const wrap = el.closest('label, .MuiFormControlLabel-root, .MuiFormGroup-root, .MuiFormControl-root');
      return {
        i,
        tag: el.tagName,
        type: el.type || null,
        name: el.name || null,
        value: el.value || null,
        checked: el.checked || false,
        role: el.getAttribute('role'),
        label,
        nearby: wrap ? wrap.textContent.trim().replace(/\s+/g, ' ').slice(0, 260) : null,
      };
    }).filter((f) => f.name || f.label || f.nearby),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
    bodyTail: (document.body.innerText || '').slice(-3000),
  }));
  console.log(JSON.stringify({ section: SECTION, out }, null, 2));
  process.exit(0);
}

if (SECTION === '5.3' && ANSWER === 'Tak') {
  const radios = page.locator('input[type="radio"]');
  if (await radios.count() < 6) throw new Error('5.3 expected three Tak/Nie radio groups');
  await radios.nth(0).dispatchEvent('click'); // allow-raw-playwright: applicant applies for location premium = Tak
  await humanIdlePause('short');
  await radios.nth(2).dispatchEvent('click'); // allow-raw-playwright: B+R in Lubelskie/eligible group a = Tak
  await humanIdlePause('short');
  await radios.nth(5).dispatchEvent('click'); // allow-raw-playwright: B+R in group b = Nie
} else {
  const radio = page.locator(`input[type="radio"][value="${ANSWER}"]`).first();
  if (await radio.count() === 0) throw new Error(`radio not found for ${ANSWER}`);
  await radio.dispatchEvent('click'); // allow-raw-playwright: set Tak/Nie answer
}
await humanIdlePause('short');
await saveEnabled();

await page.goto(PROJ + cfg.id, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const readback = await page.evaluate(() => ({
  rows: Array.from(document.querySelectorAll('table tbody tr')).filter((r) => r.querySelector('button[aria-label="overflow-options"]')).length,
  table: (document.querySelector('table')?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
}));
console.log(JSON.stringify({ section: SECTION, answer: ANSWER, readback }, null, 2));
process.exit(0);
