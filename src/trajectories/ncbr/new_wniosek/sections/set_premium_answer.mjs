// Sets the Tak/Nie answer in premium collection sections 5.3/5.4. UI-only.
// Never submits and never closes the page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const PROJ = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/';
const IDS = {
  '5.3': '72d09821-7019-4ac0-ab4f-09fdd4883fc2',
  '5.4': 'e635f786-a34c-4a29-b142-4f4081401a5c',
};

const SECTION = process.env.SECTION;
const ANSWER = process.env.ANSWER || 'Tak';
if (!IDS[SECTION]) throw new Error('SECTION must be 5.3 or 5.4');
if (!['Tak', 'Nie'].includes(ANSWER)) throw new Error('ANSWER must be Tak or Nie');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(PROJ + IDS[SECTION], { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function openFirstRowEdit() {
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find((r) => r.querySelector('button[aria-label="overflow-options"]'));
    if (!row) throw new Error('no data row');
    row.querySelector('button[aria-label="overflow-options"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open premium row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit premium row
  await humanIdlePause('long');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save premium row
  await humanIdlePause('long');
}

await openFirstRowEdit();

if (process.env.DIAG) {
  const out = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      const wrap = el.closest('label, .MuiFormControlLabel-root, .MuiFormGroup-root');
      const mui = el.closest('.MuiRadio-root, .MuiFormControlLabel-root');
      return { tag: el.tagName, type: el.type || null, name: el.name || null, value: el.value || null, checked: el.checked || false, muiChecked: Boolean(mui?.classList?.contains('Mui-checked') || mui?.querySelector?.('.Mui-checked')), label, nearby: wrap ? wrap.textContent.trim().slice(0, 220) : null };
    }).filter((f) => f.name || f.label || f.nearby),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
    bodyTail: (document.body.innerText || '').slice(-3000),
    formControls: Array.from(document.querySelectorAll('.MuiFormControl-root, .MuiFormGroup-root')).map((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 500)).filter(Boolean).slice(-20),
  }));
  console.log(JSON.stringify({ section: SECTION, out }, null, 2));
  process.exit(0);
}

if (SECTION === '5.3' && ANSWER === 'Tak') {
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const idx of [0, 2, 5]) {
      if (!radios[idx]) throw new Error(`radio index ${idx} missing`);
      radios[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }); // allow-raw-playwright: 5.3 = Tak, wojewodztwa a) Tak for Lubelskie, b) Nie
} else {
  await page.locator(`input[type="radio"][value="${ANSWER}"]`).first().dispatchEvent('click'); // allow-raw-playwright: set premium yes/no answer
}
await humanIdlePause('short');
await saveForm();

const readback = await page.evaluate(() => ({
  section: document.body.innerText.match(/5\\.[34]\\.[^\n]+/)?.[0] || null,
  tables: Array.from(document.querySelectorAll('table')).map((t) => ({ rows: t.querySelectorAll('tbody tr').length, text: t.innerText.replace(/\s+/g, ' ').slice(0, 400) })),
}));
console.log(JSON.stringify({ section: SECTION, answer: ANSWER, readback }, null, 2));
process.exit(0);
