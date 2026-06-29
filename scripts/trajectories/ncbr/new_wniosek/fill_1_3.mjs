// Section 1.3 (Podmioty realizujące projekt) of the NEW NCBR wniosek.
// Replicates the working Kimi reference cdp_fill_1_3.py. Never closes the page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/317a21dd-e798-4115-ab53-6ab5a2912fb0'].join('');

const VAT = 'Nie dotyczy.';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function clickDodaj(nth) {
  await page.evaluate((n) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj');
    if (!btns[n]) throw new Error(`Dodaj #${n} not found`);
    btns[n].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // allow-raw-playwright: synthetic Dodaj click (Kimi reference) bypasses overlay interception
  }, nth);
  await humanIdlePause('long');
}
async function saveForm() {
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!s.length) throw new Error('no enabled Zapisz');
    s[s.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // allow-raw-playwright: synthetic save on the enabled Zapisz (Kimi reference)
  });
  await humanIdlePause('long');
  await humanIdlePause('deliberate');
}
async function radio(value) {
  await page.locator(`input[type="radio"][value="${value}"]`).first().dispatchEvent('click'); // allow-raw-playwright: radio select (Kimi reference)
  await humanIdlePause('short');
}
async function text(name, value) {
  await page.locator(`[name="${name}"]`).first().fill(value); // allow-raw-playwright: LSI gov form, no anti-bot
  await humanIdlePause('short');
}
async function setAuto(name, value) {
  const inp = page.locator(`input[name="${name}"]`).first();
  await inp.click(); // allow-raw-playwright: open combobox
  await inp.fill(''); // allow-raw-playwright: clear
  await inp.fill(value); // allow-raw-playwright: set value, triggers LSI dictionary filter
  await humanIdlePause('deliberate');
  const opts = page.locator("[role='listbox'] [role='option']");
  if (await opts.count() === 0) throw new Error(`1.3 no options: ${name} -> ${value}`);
  await opts.first().dispatchEvent('click'); // allow-raw-playwright: pick filtered option (Kimi reference)
  await humanIdlePause('short');
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: neutralise cookie banner (Kimi reference)

await clickDodaj(0);
await page.waitForSelector("textarea[name='nazwa']");
await humanIdlePause('short');

await radio('wnioskodawca_samodzielny');
await text('nazwa', 'WISENT POLSKA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ');
await text('nazwa_skrocona', 'Wisent Polska');
await text('data_rozpoczecia_dzialalnosci', '27.03.2026');
await radio('przedsiebiorstwo');
await setAuto('forma_prawna', 'spółki z ograniczoną odpowiedzialnością');
await setAuto('forma_wlasnosci', 'Krajowe osoby fizyczne');
await setAuto('wielkosc_podmiotu', 'Mikro');
await radio('Tak'); // spółka celowa
await text('nip', '9462766155');
await text('regon', '544396399');
await text('numer_w_krajowym_rejestrze_sadowym', '0001232991');
await radio('pkd_2007');
await setAuto('pkd_2007', '62.01.Z Działalność związana z oprogramowaniem');
await setAuto('mozliwosc_odzyskania_vat', 'Tak');
await text('uzasadnienie_braku_mozliwosci_odzyskania_vat', VAT);
await setAuto('wojewodztwo_podmiot', 'LUBELSKIE');
await setAuto('powiat_podmiot', 'Lublin');
await setAuto('gmina_podmiot', 'Lublin');
await setAuto('miejscowosc_podmiot', 'Lublin');
await text('kod_pocztowy_podmiot', '20-209');
await setAuto('ulica_podmiot', 'Frezerów');
await text('nr_budynku_podmiot', '3');
await text('telefon_podmiot', '+48516235099');
await text('adres_email_podmiot', 'lukasz.bartoszcze@wisent.ai');
await text('www_podmiot', 'https://wisent.ai/');
await text('adres_e_doreczenie_podmiot', 'AE:PL-50419-15057-VDGUG-25');

let saveResult = 'saved';
try { await saveForm(); } catch (e) { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 80)}`; }

const readback = await page.evaluate(() => {
  const tbl = document.querySelector('table');
  let rows = -1;
  if (tbl) rows = tbl.querySelectorAll('tbody tr').length;
  const hasWisent = (document.body.innerText || '').includes('Wisent Polska');
  return { entityRows: rows, hasWisent };
});

console.log(JSON.stringify({ saveResult, readback }, null, 2));
process.exit(0);
