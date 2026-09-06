// Section 2.2 (Opis rezultatu prac B+R) — replicates Kimi fill_2_2.py. Never closes page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7';
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md';
const NB = 'MODUL_DANE_PAKIETU.istota_projektu_sciezka_b.opis_rezultatu_prac_br.';

const md = readFileSync(MD, 'utf8');
const clean = (s) => s.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
function between(start, end) {
  const a = md.split(start);
  if (a.length < 2) throw new Error(`start not found: ${start}`);
  let rest = a[1];
  if (end) rest = rest.split(end)[0];
  return clean(rest);
}
const NAZWA = 'Wisent RNM Platform – audytowalne modele AI z natywną kontrolą reprezentacji';
const OPIS = between('## Opis rezultatu prac B+R\n', '## Podsumowanie cech i funkcjonalności rezultatu projektu');
const WPLYW = between('## Wpływ rezultatu prac B+R na ograniczanie lub zwalczanie strategicznej zależności Unii\n', '## Podsumowanie wpływu prac B+R');
const POW = between('## Powiązanie rezultatu prac B+R z łańcuchem wartości konkretnej technologii krytycznej\n', null).split('\n\n')[0];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function setAuto(name, value) {
  const inp = page.locator(`input[name="${NB}${name}"]`).first();
  await inp.click(); await inp.fill(''); await inp.fill(value); // allow-raw-playwright: filter combobox
  await humanIdlePause('deliberate');
  const opts = page.locator("[role='listbox'] [role='option']");
  if (await opts.count() === 0) throw new Error(`no options: ${name}`);
  await opts.first().dispatchEvent('click'); // allow-raw-playwright: pick option
  await humanIdlePause('short');
}
async function fillCapped(name, value) {
  const ta = page.locator(`textarea[name="${NB}${name}"]`).first();
  const max = Number(await ta.getAttribute('maxlength')) || value.length;
  if (value.length > max) throw new Error(`${name} over limit: ${value.length}/${max}`);
  await ta.fill(value); // allow-raw-playwright: LSI text, no anti-bot
  await humanIdlePause('short');
  return { max, len: value.length };
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

await setAuto('rodzaj_innowacji', 'Innowacja produktowa');
await page.waitForSelector(`input[name="${NB}innowacja_produktowa_nazwa"]`);
await humanIdlePause('short');

await page.locator(`input[name="${NB}innowacja_produktowa_nazwa"]`).first().fill(NAZWA); // allow-raw-playwright: text
await humanIdlePause('short');
const opisR = await fillCapped('innowacja_produktowa_opis_rezultatu_prac_br', OPIS);

const czynniki = [];
const czName = `input[name="${NB}innowacja_produktowa_rezultat_prac_br_spelnia_nastepujace_czynniki"]`;
const factorLabels = [
  'przyczynia się do wiodącej pozycji Unii w dziedzinie przemysłu i technologii',
  'stanowi wkład w infrastrukturę krytyczną na szczeblu europejskim',
  'wpływa na zwiększenie zdolności produkcyjnych',
  'wpływa na zwiększenie bezpieczeństwa dostaw',
  'skutkuje promowaniem pozytywnych skutków transgranicznych na rynku wewnętrznym',
];
for (const label of factorLabels) {
  await page.locator(czName).first().click(); // allow-raw-playwright: open czynniki multi
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option']").filter({ hasText: label }).first();
  if (await opt.count() > 0) { const t = (await opt.textContent())?.trim()?.slice(0, 70); await opt.dispatchEvent('click'); czynniki.push(t); } // allow-raw-playwright: pick factor by exact label
  await humanIdlePause('short');
}

const wplywR = await fillCapped('innowacja_produktowa_wplyw_rezultatu_prac_br', WPLYW);
const powR = await fillCapped('innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci', POW);

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
await page.evaluate(() => {
  const s = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
  if (!s.length) throw new Error('no enabled Zapisz');
  s[s.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // allow-raw-playwright: synthetic save
}).catch((e) => { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 60)}`; });
await humanIdlePause('long');

const readback = await page.evaluate((nb) => {
  const tl = (n) => { const e = document.querySelector(`textarea[name="${nb}${n}"]`); return e ? e.value.length : null; };
  const iv = (n) => { const e = document.querySelector(`input[name="${nb}${n}"]`); return e ? e.value.slice(0, 30) : null; };
  return { rodzaj: iv('rodzaj_innowacji'), nazwa: iv('innowacja_produktowa_nazwa'), opis: tl('innowacja_produktowa_opis_rezultatu_prac_br'), wplyw: tl('innowacja_produktowa_wplyw_rezultatu_prac_br'), pow: tl('innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci') };
}, NB);

console.log(JSON.stringify({ saveResult, czynniki, opisR, wplywR, powR, readback }, null, 2));
process.exit(0);
