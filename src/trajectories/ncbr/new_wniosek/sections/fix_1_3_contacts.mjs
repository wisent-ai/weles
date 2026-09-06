// Repair section 1.3 contact-person collection. UI-only; never closes page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/317a21dd-e798-4115-ab53-6ab5a2912fb0';
const CONTACTS = [
  {
    imie: 'Łukasz',
    nazwisko: 'Bartoszcze',
    stanowisko: 'Senior Machine Learning Scientist / osoba upoważniona do kontaktu merytorycznego',
    telefon: '+48516235099',
    email: 'lukasz.bartoszcze@wisent.ai',
  },
  {
    imie: 'Zuzanna',
    nazwisko: 'Bartoszcze',
    stanowisko: 'Osoba do kontaktu organizacyjnego i finansowo-operacyjnego',
    telefon: '+48534110040',
    email: 'zuzanna.bartoszcze@gmail.com',
  },
];
const EDORECZENIA = 'AE:PL-50419-15057-VDGUG-25';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function clickDodajContact() {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
    if (!btns[1]) throw new Error(`contact Dodaj not found; count=${btns.length}`);
    btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open contact collection sub-form
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodajContact();
  const out = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      const wrap = el.closest('label, .MuiFormControl-root, .MuiFormGroup-root, .MuiBox-root');
      return {
        tag: el.tagName,
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || null,
        role: el.getAttribute('role') || null,
        max: el.getAttribute('maxlength') || null,
        value: (el.value || '').slice(0, 80),
        label,
        nearby: wrap ? wrap.textContent.trim().slice(0, 180) : null,
      };
    }).filter((f) => f.name || f.label || f.nearby),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean),
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

async function fillAny(names, value) {
  for (const name of names) {
    const loc = page.locator(`[name="${name}"]`).first();
    if (await loc.count() === 0) continue;
    const max = Number(await loc.getAttribute('maxlength')) || value.length;
    let v = value;
    if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
    await loc.fill(v); // allow-raw-playwright: contact text field
    await humanIdlePause('short');
    return `${name} ${v.length}/${max}`;
  }
  throw new Error(`none of fields found: ${names.join(', ')}`);
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save contact row
  await humanIdlePause('long');
}

async function deleteRowsContaining(needle) {
  const deleted = [];
  while (await page.evaluate((text) => Array.from(document.querySelectorAll('table tbody tr')).some((r) => (r.innerText || '').includes(text)), needle)) {
    await page.evaluate((text) => {
      const row = Array.from(document.querySelectorAll('table tbody tr')).find((r) => (r.innerText || '').includes(text));
      const btn = row?.querySelector('button[aria-label="overflow-options"]');
      if (!btn) throw new Error(`row menu not found for ${text}`);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, needle); // allow-raw-playwright: open visible stale contact row menu
    await humanIdlePause('deliberate');
    const del = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: /Usuń|Usun|Delete/ }).first();
    if (await del.count() === 0) throw new Error(`delete menu item not found for ${needle}`);
    await del.dispatchEvent('click'); // allow-raw-playwright: delete stale visible contact row
    await humanIdlePause('deliberate');
    const confirm = page.locator('button').filter({ hasText: /Usuń|Usun|Potwierdź|Tak|Delete/ }).last();
    if (await confirm.count() > 0) await confirm.dispatchEvent('click'); // allow-raw-playwright: confirm visible delete dialog
    await humanIdlePause('long');
    deleted.push(needle);
  }
  return deleted;
}

async function fillEdoreczeniaIfPresent() {
  const result = await page.evaluate((value) => {
    const fields = Array.from(document.querySelectorAll('input, textarea'));
    const hit = fields.find((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || '' : '';
      const hay = `${el.name || ''} ${label} ${el.placeholder || ''}`.toLowerCase();
      return hay.includes('doręc') || hay.includes('dorec') || hay.includes('ae:');
    });
    if (!hit || hit.disabled || hit.readOnly) return { found: Boolean(hit), filled: false };
    const proto = hit instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(hit, value);
    else hit.value = value;
    hit.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    hit.dispatchEvent(new Event('change', { bubbles: true }));
    hit.dispatchEvent(new Event('blur', { bubbles: true }));
    return { found: true, filled: true, name: hit.name || null, id: hit.id || null };
  }, EDORECZENIA); // allow-raw-playwright: fill visible e-Doreczenia field if present
  if (result.filled) {
    const clicked = await page.evaluate(() => {
      const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
      if (!saves.length) return false;
      saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }); // allow-raw-playwright: save main 1.3 form if e-Doreczenia was editable
    if (clicked) await humanIdlePause('long');
  }
  return result;
}

const deleted = await deleteRowsContaining('Weronika Pernak');
const edoreczenia = await fillEdoreczeniaIfPresent();
const added = [];
for (const c of CONTACTS) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (await page.evaluate((needle) => (document.body.innerText || '').includes(needle), `${c.imie} ${c.nazwisko}`)) continue;
  await clickDodajContact();
  const filled = [];
  filled.push(await fillAny(['imie', 'imie_osoby_do_kontaktu'], c.imie));
  filled.push(await fillAny(['nazwisko', 'nazwisko_osoby_do_kontaktu'], c.nazwisko));
  filled.push(await fillAny(['telefon', 'telefon_osoby_do_kontaktu', 'nr_telefonu'], c.telefon));
  filled.push(await fillAny(['adres_email', 'email', 'adres_email_osoby_do_kontaktu'], c.email));
  await saveForm();
  added.push({ person: `${c.imie} ${c.nazwisko}`, filled });
}

const readback = await page.evaluate(() => ({
  tables: Array.from(document.querySelectorAll('table')).map((t) => ({
    rows: t.querySelectorAll('tbody tr').length,
    text: t.innerText.replace(/\s+/g, ' ').slice(0, 700),
  })),
}));
console.log(JSON.stringify({ deleted, edoreczenia, added, readback }, null, 2));
process.exit(0);
