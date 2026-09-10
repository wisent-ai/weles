// Section 2.3 (Zapotrzebowanie rynkowe...) — data from Kimi save_2_3_fetch.py, driven via UI.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/c5dbdc83-5baf-4866-b3d8-4da3ae553865';
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';

const md = readFileSync(MD, 'utf8');
const clean = (s) => s.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
function between(start, end) { let s = md.split(start, 2)[1]; if (end) s = s.split(end, 2)[0]; return clean(s); }
const NAZWA = 'Modele oparte na reprezentacjach (RNM) z natywnym katalogiem konceptów';
const RYNEK = between('## Rynek docelowy dla innowacji produktowej oraz zapotrzebowanie rynkowe na produkt\n', '## Znaczący potencjał');
const POTENCJAL = between('## Znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE\n', '## Parametry opisujące');
function competitorRows(start, end) {
  const block = between(start, end);
  return block.split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|') && !/---|Podmiot konkurencyjny/.test(line))
    .map((line) => {
      const c = line.split('|').map((v) => v.trim());
      return { producent: c[1], produkt: c[3], korzysc: c[5] };
    })
    .filter((r) => r.producent && r.produkt && r.korzysc);
}
const EU_COMP = competitorRows('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE');
const NON_EU_COMP = competitorRows('## Oferta konkurencji spoza UE', '## Rynek docelowy');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function setAuto(suffix, value) {
  const inp = page.locator(`input[name$="${suffix}"]`).first();
  await humanFill(page, inp, value);
  await humanIdlePause('deliberate');
  const opts = page.locator("[role='listbox'] [role='option']");
  if (await opts.count() === 0) throw new Error(`no options: ${suffix}`);
  await opts.first().dispatchEvent('click'); // allow-raw-playwright: pick option
  await humanIdlePause('short');
}
async function fillCapped(suffix, value) {
  const ta = page.locator(`textarea[name$="${suffix}"]`).first();
  const max = Number(await ta.getAttribute('maxlength')) || value.length;
  if (value.length > max) throw new Error(`${suffix} over limit: ${value.length}/${max}`);
  await humanFill(page, ta, value);
  await humanIdlePause('short');
  return { max, len: value.length };
}
async function setApplicant() {
  const input = page.locator('input[name*="nazwa_skrocona_wnioskodawcy"]').first();
  const root = page.locator('.MuiFormControl-root, .MuiInputBase-root').filter({ has: input }).first();
  const select = root.locator('.MuiSelect-select, [role="combobox"]').first();
  if (await select.count() === 0) throw new Error('applicant select not found');
  await humanClickLocator(page, select);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  await opt.waitFor({ state: 'visible' });
  await humanClickLocator(page, opt);
  await humanIdlePause('short');
}
async function saveMain() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true })
    .filter({ visible: true });
  const count = await saves.count();
  if (!count) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.nth(count - 1));
  await humanIdlePause('long');
}
async function clickDodaj(nth) {
  const buttons = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true });
  if (await buttons.count() <= nth) throw new Error(`Dodaj #${nth} not found; count=${await buttons.count()}`);
  await humanClickLocator(page, buttons.nth(nth));
  await humanIdlePause('long');
}
async function fillNamed(name, value) {
  const loc = page.locator(`textarea[name="${name}"], input[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || value.length;
  if (value.length > max) throw new Error(`${name} over limit: ${value.length}/${max}`);
  await humanFill(page, loc, value);
  await humanIdlePause('short');
  return `${name} ${value.length}/${max}`;
}
async function saveSubform() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true })
    .filter({ visible: true });
  const count = await saves.count();
  if (!count) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.nth(count - 1));
  await humanIdlePause('long');
}
async function addCompetitor(nth, row) {
  await clickDodaj(nth);
  const filled = [];
  filled.push(await fillNamed('produkt_proces', row.produkt));
  filled.push(await fillNamed('nazwa_producenta', row.producent));
  filled.push(await fillNamed('korzysc_przewaga', row.korzysc));
  await saveSubform();
  return { producent: row.producent, filled };
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

if (process.env.APPLICANT_ONLY) {
  if (process.env.DIAG_APPLICANT) {
    const info = await page.evaluate(() => {
      const inp = Array.from(document.querySelectorAll('input')).find((i) => /nazwa_skrocona_wnioskodawcy/.test(i.name || ''));
      const fc = inp?.closest('.MuiFormControl-root') || inp?.parentElement;
      return { name: inp?.name || null, value: inp?.value || null, html: fc ? fc.outerHTML.slice(0, 1600) : null };
    }); // allow-raw-playwright: inspect applicant control
    console.log(JSON.stringify(info, null, 2));
    process.exit(0);
  }
  await setApplicant();
  await saveMain();
  const applicant = await page.evaluate(() => Array.from(document.querySelectorAll('input')).find((i) => /nazwa_skrocona_wnioskodawcy/.test(i.name || ''))?.value || null);
  console.log(JSON.stringify({ applicant, saved: true }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_DODAJ) {
  const nth = Number(process.env.DIAG_DODAJ) || 0;
  const buttons = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true });
  if (await buttons.count() <= nth) throw new Error(`Dodaj #${nth} not found; count=${await buttons.count()}`);
  await humanClickLocator(page, buttons.nth(nth));
  await humanIdlePause('long');
  const out = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      return { tag: el.tagName, name: el.name || null, type: el.type || null, role: el.getAttribute('role'), max: el.getAttribute('maxlength'), value: (el.value || '').slice(0, 80), label };
    }).filter((f) => f.name || f.label),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
  }));
  console.log(JSON.stringify({ nth, ...out }, null, 2));
  process.exit(0);
}

if (process.env.FILL_COMPETITION) {
  const done = [];
  for (const row of EU_COMP) {
    const exists = await page.evaluate((name) => (document.body.innerText || '').includes(name), row.producent);
    if (!exists) done.push({ type: 'UE', ...(await addCompetitor(0, row)) });
  }
  for (const row of NON_EU_COMP) {
    const exists = await page.evaluate((name) => (document.body.innerText || '').includes(name), row.producent);
    if (!exists) done.push({ type: 'nonUE', ...(await addCompetitor(1, row)) });
  }
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const readback = await page.evaluate(() => Array.from(document.querySelectorAll('table')).map((t) => Array.from(t.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\s+/g, ' '))));
  console.log(JSON.stringify({ done, readback }, null, 2));
  process.exit(0);
}

await setAuto('rodzaj_innowacji', 'Innowacja produktowa');
await humanIdlePause('deliberate');

if (process.env.DIAG) {
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((i) => ({ tag: i.tagName, name: i.name, role: i.getAttribute('role'), max: i.getAttribute('maxlength') })).filter((f) => f.name && f.name.includes('produktowa')));
  console.log(JSON.stringify({ fields, lens: { RYNEK: RYNEK.length, POTENCJAL: POTENCJAL.length } }, null, 2));
  process.exit(0);
}

await humanFill(page, page.locator(`input[name$="innowacja_produktowa_nazwa"]`).first(), NAZWA);
await humanIdlePause('short');
const rynekR = await fillCapped('innowacja_produktowa_rynek_docelowy', RYNEK);
const potR = await fillCapped('innowacja_produktowa_znaczacy_potencjal_gospodarczy_innowacji', POTENCJAL);

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
await saveMain().catch((e) => { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 60)}`; });

const readback = await page.evaluate(() => {
  const tl = (n) => { const e = document.querySelector(`textarea[name$="${n}"]`); return e ? e.value.length : null; };
  return { nazwa: (document.querySelector('input[name$="innowacja_produktowa_nazwa"]') || {}).value, rynek: tl('innowacja_produktowa_rynek_docelowy'), pot: tl('innowacja_produktowa_znaczacy_potencjal_gospodarczy_innowacji') };
});
console.log(JSON.stringify({ saveResult, rynekR, potR, readback }, null, 2));
process.exit(0);
