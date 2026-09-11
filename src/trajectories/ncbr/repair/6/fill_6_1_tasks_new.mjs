// Section 6.1 task collection inspector/filler for NEW NCBR wniosek.
// DIAG=1 opens one task row and dumps fields. Never closes page.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { tasks } from './fill_6_1_tasks_new/source.mjs';
import { tasksForm } from './fill_6_1_tasks_new/form.mjs';
import { milestoneSteps } from './fill_6_1_tasks_new/milestones.mjs';
import { runModes } from './fill_6_1_tasks_new/modes.mjs';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/566c735c-8ad0-406f-a948-f3ea921c2cc7';
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

const form = tasksForm({ page, SECTION_URL });
const milestones = milestoneSteps({ page, form });
const { clickDodaj, fillByName, fillSelector, radio, setApplicant, saveForm } = form;
await runModes({ page, SECTION_URL, form, milestones });

const wanted = process.env.TASKS ? new Set(process.env.TASKS.split(',').map((x) => x.trim()).filter(Boolean)) : null;
const parsed = tasks().filter((t) => t.nr !== '0' && (!wanted || wanted.has(t.nr)));
const currentRows = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
if (!wanted && currentRows >= parsed.length && parsed.length > 0) {
  console.log(JSON.stringify({ skipped: true, currentRows, parsed: parsed.length }, null, 2));
  process.exit(0);
}

const kind = { 'Badania przemysłowe': 'badania_przemyslowe', 'Prace rozwojowe': 'prace_rozwojowe', 'Koszty pośrednie': 'koszty_posrednie' };
const added = [];
for (const t of parsed) {
  console.log(`START TASK ${t.nr}`);
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await clickDodaj();
  await page.waitForSelector('[name="numer_zadania"]');
  await fillByName('numer_zadania', t.nr);
  await fillByName('nazwa_zadania', t.nazwa);
  await radio(t.koszty === 'Tak' ? 'Tak' : 'Nie');
  await fillByName('startDate', t.start);
  await fillByName('endDate', t.end);
  await radio(kind[t.rodzaj] || t.rodzaj);
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound */ }
  await fillByName('zakres_planowanych_prac_br', t.zakres);
  await fillByName('szczegolowy_opis_prac', t.szczegolowy);
  for (let i = 0; i < t.milestones.length; i++) {
    await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Dodaj kolejny$/ }).first()); // allow-raw-playwright: add nested milestone row
    await humanIdlePause('long');
    const m = t.milestones[i];
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_nazwa"]`, m.nazwa);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_parametry"]`, m.parametry);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_opis_weryfikacji"]`, m.weryfikacja);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${i}].kamienie_milowe_opis_wplywu"]`, m.wplyw);
  }
  try {
    await saveForm();
    added.push(t.nr);
    console.log(`SAVED TASK ${t.nr}`);
  } catch (e) {
    console.log(`NOT SAVED TASK ${t.nr}: ${String(e?.message || e).slice(0, 220)}`);
    break;
  }
}

const rows = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
console.log(JSON.stringify({ parsed: parsed.length, added, rows }, null, 2));
process.exit(0);
