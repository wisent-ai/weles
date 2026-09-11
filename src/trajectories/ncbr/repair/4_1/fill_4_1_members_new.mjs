// Section 4.1 team-member collection filler for the NEW NCBR wniosek.
// DIAG=1 opens one row and dumps field names. Never closes page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { members } from './fill_4_1_members_new/source.mjs';
import { membersForm } from './fill_4_1_members_new/form.mjs';
import { runModes } from './fill_4_1_members_new/modes.mjs';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/5af236aa-03b2-4650-b5a2-95c299dfeeaf';
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(8000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

const form = membersForm({ page, SECTION_URL });
const { clickDodaj, fillByName, setAuto, setApplicant, setStatus, saveForm, fillProjectSubrow } = form;
await runModes({ page, form });

const existingState = await page.evaluate(() => {
  const table = document.querySelector('table');
  return {
    rows: table ? table.querySelectorAll('tbody tr').length : 0,
    text: document.body.innerText || '',
  };
});
const onlyNames = process.env.ONLY_NAMES
  ? process.env.ONLY_NAMES.split(',').map((x) => x.trim()).filter(Boolean)
  : null;
const ms = members().filter((m) => {
  const full = `${m.imie} ${m.nazwisko}`;
  if (onlyNames) return onlyNames.includes(full);
  return !existingState.text.includes(full);
});
if (ms.length === 0) {
  console.log(JSON.stringify({ skipped: true, reason: `all parsed members visible; rows ${existingState.rows}` }, null, 2));
  process.exit(0);
}

const added = [];
for (const m of ms) {
  console.log(`START ${m.imie} ${m.nazwisko}`);
  await clickDodaj();
  await page.waitForSelector('[name="imie"]');
  const filled = [];
  filled.push(await fillByName('imie', m.imie));
  filled.push(await fillByName('nazwisko', m.nazwisko));
  await setAuto('wyksztalcenie', m.wyksztalcenie);
  filled.push(await fillByName('tytul_naukowy', m.tytul));
  await setAuto('rola_w_projekcie', m.rola);
  filled.push(await fillByName('doswiadczenie_naukowe_i_zawodowe', m.doswiadczenie));
  filled.push(await fillByName('stanowisko_i_zakres_obowiazkow_w_projekcie', m.stanowisko));
  filled.push(await fillByName('wymiar_zaangazowania_w_projekcie', m.wymiar));
  await setStatus();
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-bound after status */ }
  if (m.rola.toLowerCase().includes('kierownik') && m.projects.length) {
    await fillProjectSubrow(m.projects[0], 0);
  }
  try {
    await saveForm();
    added.push(`${m.imie} ${m.nazwisko}`);
    console.log(`SAVED ${m.imie} ${m.nazwisko}`);
  } catch (e) {
    console.log(`NOT SAVED ${m.imie} ${m.nazwisko}: ${String(e?.message || e).slice(0, 180)}`);
    break;
  }
}

const rows = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
console.log(JSON.stringify({ added, rows }, null, 2));
process.exit(0);
